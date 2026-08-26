import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProcessAlive, readJsonFile } from './ralph-runtime.mjs';

/**
 * Чтение рантайма Ralph для GUI: состояние прогона и расход по задачам.
 *
 * Модуль только читает. Ни лока, ни state он не чинит и не удаляет: страница
 * показывает то, что есть на диске, а решение о брошенном локе принимает
 * человек.
 */

// Путь выводится так же, как в `ralph-state-store.mjs` и `ralph-run-metrics.mjs`.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const runtimeDirectory = path.join(projectRoot, '.git', 'ralph-loop');

// Лимит итераций живёт не в state, а в конфиге; путь тот же, что и в
// `ralph-config.mjs`. Файл читается сырым: проверка конфига — дело GUI-полей,
// а прогону нужно только число рядом с `iterationsUsed`.
const configFilePath = path.join(projectRoot, '.agents', 'ralph.config.json');

// Значение `maxStoredIssueRecords` из `ralph-run-metrics.mjs`: там оно не
// экспортируется, а число нужно, чтобы честно сказать, что журнал обрезан.
const maxStoredIssueRecords = 200;

// В метриках нет роли `milestone-review`: ревью всей вехи идёт вне цикла issue
// и в расход не попадает. Признак уходит на страницу, чтобы сумма не выдавала
// себя за полную стоимость прогона.
const missesMilestoneReview = true;

const outcomeDescriptions = {
  completed: 'задача закрыта',
  'review-failed': 'ревью не пропустило',
  'agent-failed': 'агент не справился',
  'validation-failed': 'валидация не прошла',
  RALPH_COMMAND_FAILED: 'упала команда прогона',
  RALPH_AGENT_AUTH: 'агент не авторизован',
  aborted: 'прогон прерван',
};

const stageNames = ['implementation', 'validation', 'review'];

// Поле входа переименовалось: старые записи хранят `inputTokens`, новые —
// `uncachedInputTokens`. В одной записи оба не встречаются, поэтому читаются
// оба имени.
const tokenFields = [
  'inputTokens',
  'uncachedInputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
];

function resolveRuntimeDirectory(dependencies) {
  return dependencies.runtimeDir ?? runtimeDirectory;
}

/** Битый JSON не должен ронять сервер: GUI показывает пустоту, а не 500. */
function readJsonSafely(filePath, fallback = null) {
  try {
    return readJsonFile(filePath, fallback);
  } catch {
    return fallback;
  }
}

function fileModifiedAt(filePath) {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Доли цента и хвосты плавающей точки на странице читать нельзя. */
function roundMoney(value) {
  return Math.round(value * 10_000) / 10_000;
}

// -----------------------------------------------------------------------------
// Состояние прогона
// -----------------------------------------------------------------------------

/**
 * @returns {{ running: boolean, run: object | null, staleLock: boolean }}
 * `running` — лок есть и его процесс жив. `staleLock` — лок есть, процесса нет:
 * прогон упал, не убрав за собой.
 */
export function readRunState(dependencies = {}) {
  const directory = resolveRuntimeDirectory(dependencies);
  const alive = dependencies.isProcessAlive ?? isProcessAlive;
  const lock = readJsonSafely(path.join(directory, 'run.lock'), null);
  if (!lock) return { running: false, run: null, staleLock: false };

  const state = readJsonSafely(path.join(directory, 'state.json'), null);
  const config = readJsonSafely(dependencies.configPath ?? configFilePath, null);
  const running = alive(lock.pid);

  return {
    running,
    staleLock: !running,
    run: {
      mode: lock.mode ?? null,
      branch: lock.branch ?? state?.branch ?? null,
      pid: lock.pid ?? null,
      startedAt: lock.startedAt ?? null,
      milestone: state?.milestone ?? null,
      phaseIndex: state?.phaseIndex ?? null,
      phaseCount: state?.phaseCount ?? null,
      iterationsUsed: state?.iterationsUsed ?? null,
      maxIterations: config?.maxIterations ?? null,
      issueNumber: state?.issue?.number ?? null,
      issuePhase: state?.issue?.phase ?? null,
      stateUpdatedAt: state?.updatedAt ?? null,
      logUpdatedAt: fileModifiedAt(path.join(directory, 'run.log')),
    },
  };
}

// -----------------------------------------------------------------------------
// Расход по задачам
// -----------------------------------------------------------------------------

function agentTokens(agent) {
  return tokenFields.reduce((total, field) => total + numberOrZero(agent[field]), 0);
}

function normalizeAgent(agent) {
  return {
    role: agent.role ?? null,
    costUsd: typeof agent.costUsd === 'number' ? roundMoney(agent.costUsd) : null,
    turns: typeof agent.turns === 'number' ? agent.turns : null,
    models: Array.isArray(agent.models) ? agent.models : [],
    tokens: agentTokens(agent),
  };
}

/** Стадии выравниваются до трёх известных: страница показывает пропуск, а не дыру. */
function normalizeStages(stages) {
  const source = stages ?? {};

  return Object.fromEntries(
    stageNames.map((name) => {
      const stage = source[name];
      if (!stage) return [name, null];

      return [
        name,
        {
          ms: numberOrZero(stage.ms),
          runs: numberOrZero(stage.runs),
          attested: stage.attested ?? null,
        },
      ];
    }),
  );
}

function normalizeRun(entry) {
  const agents = (Array.isArray(entry.agents) ? entry.agents : []).map(normalizeAgent);

  return {
    iteration: entry.iteration ?? null,
    startedAt: entry.startedAt ?? null,
    finishedAt: entry.finishedAt ?? null,
    outcome: entry.outcome ?? null,
    reason: entry.reason ?? null,
    wallMs: numberOrZero(entry.wallMs),
    agentCli: entry.agentCli ?? null,
    stages: normalizeStages(entry.stages),
    agents,
  };
}

function emptySpend() {
  return {
    totals: { costUsd: 0, tasks: 0, attempts: 0, wallMs: 0, tokens: 0, missesMilestoneReview },
    period: { fromIso: null, toIso: null, storedAttempts: 0, maxStored: maxStoredIssueRecords },
    tasks: [],
  };
}

/**
 * Одна запись метрик — одна попытка, а не задача, поэтому попытки группируются
 * по номеру issue. Заголовка задачи в метриках нет, и поле `title` здесь не
 * появляется: выдумывать его нельзя.
 *
 * @returns {{ totals: object, period: object, tasks: object[] }} задачи по
 * убыванию стоимости.
 */
export function readTaskSpend(dependencies = {}) {
  const metricsPath =
    dependencies.metricsPath ??
    path.join(resolveRuntimeDirectory(dependencies), 'issue-metrics.json');
  const stored = readJsonSafely(metricsPath, null);
  const entries = Array.isArray(stored?.entries) ? stored.entries : [];
  if (entries.length === 0) return emptySpend();

  const byIssue = new Map();
  for (const entry of entries) {
    const issue = entry.issue ?? null;
    const key = String(issue);
    let task = byIssue.get(key);
    if (!task) {
      task = {
        issue,
        milestone: entry.milestone ?? null,
        attempts: 0,
        lastOutcome: null,
        lastReason: null,
        costUsd: 0,
        tokens: 0,
        wallMs: 0,
        runs: [],
      };
      byIssue.set(key, task);
    }
    const run = normalizeRun(entry);
    task.attempts += 1;
    task.wallMs += run.wallMs;
    for (const agent of run.agents) {
      task.costUsd += numberOrZero(agent.costUsd);
      task.tokens += agent.tokens;
    }
    task.runs.push(run);
  }

  const startTimes = entries.map((entry) => entry.startedAt).filter(Boolean).sort();
  const tasks = [...byIssue.values()].map((task) => {
    // В файле записи лежат от новых к старым; человеку нужен ход попыток.
    task.runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const last = task.runs.at(-1);
    task.lastOutcome = last?.outcome ?? null;
    task.lastReason = last?.reason ?? null;
    task.costUsd = roundMoney(task.costUsd);

    return task;
  });
  tasks.sort((a, b) => b.costUsd - a.costUsd);

  const totals = tasks.reduce(
    (sum, task) => ({
      costUsd: sum.costUsd + task.costUsd,
      tasks: sum.tasks + 1,
      attempts: sum.attempts + task.attempts,
      wallMs: sum.wallMs + task.wallMs,
      tokens: sum.tokens + task.tokens,
    }),
    { costUsd: 0, tasks: 0, attempts: 0, wallMs: 0, tokens: 0 },
  );

  return {
    totals: { ...totals, costUsd: roundMoney(totals.costUsd), missesMilestoneReview },
    period: {
      fromIso: startTimes[0] ?? null,
      toIso: startTimes.at(-1) ?? null,
      storedAttempts: entries.length,
      maxStored: maxStoredIssueRecords,
    },
    tasks,
  };
}

// -----------------------------------------------------------------------------
// Итог попытки словами
// -----------------------------------------------------------------------------

/** Незнакомый итог возвращается как есть: молчаливая подмена скрыла бы новый код. */
export function describeOutcome(outcome) {
  if (typeof outcome !== 'string' || outcome.length === 0) return 'итог неизвестен';

  return outcomeDescriptions[outcome] ?? outcome;
}
