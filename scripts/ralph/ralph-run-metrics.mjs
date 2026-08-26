import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonFile, writeJsonAtomic } from './ralph-runtime.mjs';

/**
 * Стоимость одной issue: время по стадиям и телеметрия сессий агента.
 *
 * Журнал ведётся отдельно от state.json намеренно: `finish()` удаляет состояние
 * целиком, то есть метрики исчезали бы ровно на успешном завершении — в том
 * единственном случае, ради которого их и собирают.
 *
 * Каталог `.git/ralph-loop` выбран потому, что он невидим для
 * `git status --porcelain` и не попадает в snapshot валидации: запись метрик не
 * может изменить проверяемое дерево и не может сдвинуть attestation.
 */

const metricsProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Имя не должно начинаться с `run-` и заканчиваться на `.log`: ретенция журнала
// прогонов удаляет такие файлы по маске, оставляя пять последних.
export const issueMetricsPath = path.join(
  metricsProjectRoot,
  '.git',
  'ralph-loop',
  'issue-metrics.json',
);

const metricsVersion = 1;
const maxStoredIssueRecords = 200;

/**
 * Вес токена по виду обращения, в единицах базового входа.
 *
 * Числа не взяты из прайс-листа, а выведены из собственных прогонов: CLI
 * присылает и сырые счётчики, и `total_cost_usd`, поэтому ставки решаются как
 * система уравнений. Запись кэша вышла 6,03 $/Mtok, чтение 0,33, выход 50,2 и
 * 49,9 по двум независимым сессиям. Отсюда базовый вход 3,015 и веса ниже.
 *
 * Считать сырые токены нельзя: чтение кэша составляло 95% их числа и 26%
 * стоимости, а рассуждения — 0,9% числа и 38% стоимости. Два счёта ведут к
 * противоположным решениям, и невзвешенный указывает не туда.
 *
 * Ставки сняты на claude-opus-5 с окном в 1M. Сменится модель — веса надо
 * пересчитать тем же способом; пока их источник один, они живут здесь.
 */
const tokenWeights = {
  uncachedInput: 1,
  cacheCreation: 2,
  cacheRead: 0.109,
  output: 16.6,
};

// -----------------------------------------------------------------------------
// Активная запись
// -----------------------------------------------------------------------------

// Тот же приём, что и у `activeStateStore`: одна запись на процесс, доступ
// только через функции этого модуля. Альтернатива — протаскивать recorder через
// runAgentOnIssue → commitAndCompleteIssue → reviewAndCloseCommittedIssue, то
// есть через каждую сигнатуру на пути, включая те, что метрик не касаются.
let activeIssueMetrics = null;

export function beginIssueMetrics(context, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const startedMs = now();
  activeIssueMetrics = {
    issue: context.issue,
    milestone: context.milestone ?? null,
    branch: context.branch ?? null,
    iteration: context.iteration ?? null,
    agentCli: context.agentCli ?? null,
    startedMs,
    startedAt: new Date(startedMs).toISOString(),
    stages: new Map(),
    agents: [],
    now,
  };

  return activeIssueMetrics;
}

export function currentIssueMetrics() {
  return activeIssueMetrics;
}

/**
 * Возвращает функцию завершения стадии. Вызывать её нужно в `finally`: самые
 * дорогие стадии — те, что упали, и запись без них показала бы дешёвый цикл там,
 * где оператор ищет причину траты.
 */
export function startStage(name) {
  const metrics = activeIssueMetrics;
  if (!metrics) return () => {};
  const startedMs = metrics.now();
  let closed = false;

  return (extra = {}) => {
    if (closed) return;
    closed = true;
    const previous = metrics.stages.get(name) ?? { ms: 0, runs: 0 };
    metrics.stages.set(name, {
      ...previous,
      ...extra,
      ms: previous.ms + (metrics.now() - startedMs),
      runs: previous.runs + 1,
    });
  };
}

export function recordAgentTelemetry(role, telemetry) {
  if (!activeIssueMetrics || !telemetry) return;
  activeIssueMetrics.agents.push({ role, ...telemetry });
}

/**
 * Телеметрия снимается здесь, а не на каждой площадке вызова: у сессии два
 * выхода, и путь с исключением — это ровно сгоревший maxTurns или timeout,
 * самая дорогая сессия из возможных.
 */
export async function withRecordedTelemetry(role, operation) {
  try {
    const session = await operation();
    recordAgentTelemetry(role, session?.telemetry);
    return session;
  } catch (error) {
    recordAgentTelemetry(role, error?.telemetry);
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Свод и запись
// -----------------------------------------------------------------------------

function sumTelemetry(agents, field) {
  const reported = agents.map((agent) => agent[field]).filter((value) => typeof value === 'number');

  return reported.length > 0 ? reported.reduce((total, value) => total + value, 0) : null;
}

export function summarizeIssueMetrics(metrics, outcome) {
  const finishedMs = metrics.now();
  const agents = metrics.agents;
  const totals = {
    // Роли считаются отдельно от суммы: цену одной issue задаёт не только
    // общий счёт, но и распределение между реализацией и ревью.
    sessions: agents.length,
    // Число сессий, приславших цену. Codex её не отдаёт, и общая сумма без
    // этого счётчика выглядела бы полной, будучи частичной.
    costReportedBy: agents.filter((agent) => typeof agent.costUsd === 'number').length,
    costUsd: sumTelemetry(agents, 'costUsd'),
    turns: sumTelemetry(agents, 'turns'),
    // Разделяет две причины дорогого цикла, которые метка шага в логе не
    // различает: агент много ходил по репозиторию или много рассуждал.
    toolResults: sumTelemetry(agents, 'toolResults'),
    thinkingTokens: sumTelemetry(agents, 'thinkingTokens'),
    uncachedInputTokens: sumTelemetry(agents, 'uncachedInputTokens'),
    outputTokens: sumTelemetry(agents, 'outputTokens'),
    cacheReadTokens: sumTelemetry(agents, 'cacheReadTokens'),
    cacheCreationTokens: sumTelemetry(agents, 'cacheCreationTokens'),
    // Полный вход, а не одно из трёх слагаемых.
    inputTokens: totalInputTokens(agents),
  };

  return {
    version: metricsVersion,
    issue: metrics.issue,
    milestone: metrics.milestone,
    branch: metrics.branch,
    iteration: metrics.iteration,
    agentCli: metrics.agentCli,
    outcome: outcome?.outcome ?? 'unknown',
    reason: outcome?.reason ?? null,
    startedAt: metrics.startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
    wallMs: finishedMs - metrics.startedMs,
    stages: Object.fromEntries(metrics.stages),
    agents,
    totals,
    effective: effectiveTokenBreakdown(totals),
  };
}

function totalInputTokens(agents) {
  const parts = ['uncachedInputTokens', 'cacheCreationTokens', 'cacheReadTokens']
    .map((field) => sumTelemetry(agents, field))
    .filter((value) => typeof value === 'number');

  return parts.length > 0 ? parts.reduce((total, value) => total + value, 0) : null;
}

/**
 * Расход в единицах базового входа, по составляющим. Разбивка важнее суммы:
 * она отвечает на вопрос, что именно сокращать, а сумма — только на вопрос,
 * стало ли лучше.
 */
export function effectiveTokenBreakdown(totals) {
  const thinking = totals.thinkingTokens ?? 0;
  const output = totals.outputTokens ?? 0;
  // Округление на каждой составляющей, а не только на сумме: доли базового
  // токена смысла не имеют, а вес 16,6 порождает их на любом входе.
  const weighted = {
    uncachedInput: Math.round((totals.uncachedInputTokens ?? 0) * tokenWeights.uncachedInput),
    cacheCreation: Math.round((totals.cacheCreationTokens ?? 0) * tokenWeights.cacheCreation),
    cacheRead: Math.round((totals.cacheReadTokens ?? 0) * tokenWeights.cacheRead),
    // Рассуждения отделены от остального выхода: тарифицируются одинаково, но
    // сокращаются разными средствами — effort против объёма задачи.
    reasoning: Math.round(thinking * tokenWeights.output),
    answer: Math.round(Math.max(output - thinking, 0) * tokenWeights.output),
  };

  return {
    ...weighted,
    total: Object.values(weighted).reduce((sum, value) => sum + value, 0),
  };
}

function largestEffectiveShare(breakdown) {
  const names = {
    uncachedInput: 'вход вне кэша',
    cacheCreation: 'запись кэша',
    cacheRead: 'чтение кэша',
    reasoning: 'рассуждения',
    answer: 'ответ',
  };
  const entries = Object.entries(names)
    .map(([key, name]) => [name, breakdown[key]])
    .sort(([, a], [, b]) => b - a);
  const [name, value] = entries[0];

  return breakdown.total > 0 ? `${name} ${Math.round((value / breakdown.total) * 100)}%` : null;
}

export function appendIssueMetrics(record, dependencies = {}) {
  const metricsPath = dependencies.metricsPath ?? issueMetricsPath;
  const stored = readJsonFile(metricsPath, null);
  const entries =
    stored?.version === metricsVersion && Array.isArray(stored.entries) ? stored.entries : [];
  writeJsonAtomic(metricsPath, {
    version: metricsVersion,
    entries: [record, ...entries].slice(0, maxStoredIssueRecords),
  });

  return record;
}

/**
 * Закрывает активную запись и возвращает её. Активная запись снимается до
 * записи на диск: сбой файловой операции не должен оставить процесс с чужими
 * метриками на следующей issue.
 */
export function finishIssueMetrics(outcome, dependencies = {}) {
  const metrics = activeIssueMetrics;
  activeIssueMetrics = null;
  if (!metrics) return null;

  return appendIssueMetrics(summarizeIssueMetrics(metrics, outcome), dependencies);
}

// -----------------------------------------------------------------------------
// Строка для оператора
// -----------------------------------------------------------------------------

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, '0')}s`;
}

function formatTokens(value) {
  if (typeof value !== 'number') return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1000)}k`;

  return String(value);
}

/**
 * Строка оператору считает токены, а не деньги: на подписке доллары условны, а
 * прогон ограничивает пятичасовое окно, которое расходуется токенами. Цена от
 * CLI остаётся в записи — она приходит даром и её нельзя восстановить потом.
 */
function formatTokenVolume(record) {
  const { inputTokens, outputTokens, thinkingTokens, sessions, costReportedBy } = record.totals;
  if (typeof inputTokens !== 'number' && typeof outputTokens !== 'number') return null;
  const breakdown = record.effective ?? effectiveTokenBreakdown(record.totals);
  const dominant = largestEffectiveShare(breakdown);
  const partial =
    costReportedBy < sessions ? `, телеметрию прислали ${costReportedBy}/${sessions}` : '';
  const reasoning =
    typeof thinkingTokens === 'number' ? `, рассуждений ${formatTokens(thinkingTokens)}` : '';

  return (
    `расход ${formatTokens(breakdown.total)} базовых токенов` +
    `${dominant ? ` (больше всего — ${dominant})` : ''}; ` +
    `сырых: вход ${formatTokens(inputTokens)}, выход ${formatTokens(outputTokens)}${reasoning}` +
    partial
  );
}

export function formatIssueMetrics(record) {
  const stages = Object.entries(record.stages)
    .map(([name, stage]) => {
      const runs = stage.runs > 1 ? ` ×${stage.runs}` : '';
      const attested = stage.attested === true ? ', из attestation' : '';
      return `${name} ${formatDuration(stage.ms)}${runs}${attested}`;
    })
    .join(', ');
  const { turns, toolResults } = record.totals;
  const work =
    `${record.totals.sessions} сессий` +
    `${typeof turns === 'number' ? `, шагов ${turns}` : ''}` +
    `${typeof toolResults === 'number' ? `, вызовов инструментов ${toolResults}` : ''}`;

  return [
    `Стоимость issue #${record.issue}: ${formatDuration(record.wallMs)} — ${stages || 'без стадий'}`,
    work,
    formatTokenVolume(record),
    `итог: ${record.reason ?? record.outcome}`,
  ]
    .filter(Boolean)
    .join('; ');
}
