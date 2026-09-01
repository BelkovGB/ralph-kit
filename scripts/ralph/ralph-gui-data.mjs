import { closeSync, openSync, readSync, statSync } from 'node:fs';
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

// Ревью всего milestone цикл пишет записью без номера issue. Пока такой записи в
// журнале нет, сумма не покрывает самую дорогую сессию прогона, и страница
// обязана об этом сказать, чтобы итог не выдавал себя за полную стоимость.
const milestoneReviewKeyPrefix = 'milestone-review:';

// Итоги попытки: слева — что цикл пишет в журнал, справа — что это значит.
// Значения сверены с `ralph-loop.mjs`: первые семь пишет сам цикл, остальные
// приходят кодом упавшего исключения.
//
// Тот же список слово в слово повторён в `outcomeWords` на странице:
// страница подписывает ячейку, сервер — подсказку к ней, и расхождение читалось
// бы как два разных события. Меняете здесь — правьте и там.
const outcomeDescriptions = {
  completed: 'Ralph закрыл issue',
  'review-failed': 'ревью вернуло замечания',
  'review-parked': 'Ralph отложил issue после отказов ревью',
  'iteration-limit': 'итерации кончились до начала issue',
  'milestone-review': 'Ralph отревьюил milestone',
  'validation-failed': 'проверки не прошли',
  'agent-failed': 'сессия агента оборвалась, наработки сохранены',
  RALPH_VALIDATION_FAILED: 'проверки не прошли, попытки кончились',
  RALPH_MAX_TURNS: 'сессия упёрлась в лимит шагов',
  RALPH_AGENT_TIMEOUT: 'сессия не уложилась в срок',
  RALPH_AGENT_AUTH: 'CLI агента не авторизован',
  RALPH_AGENT_REJECTED: 'CLI отклонил запрос',
  RALPH_AGENT_WRITE_ACCESS: 'агент не смог писать файлы',
  RALPH_UNTRUSTED_ISSUE: 'автор issue не доверенный',
  RALPH_COMMAND_FAILED: 'команда прогона вернула ошибку',
  RALPH_COMMAND_NOT_FOUND: 'Ralph не нашёл команду прогона',
  RALPH_COMMAND_TIMEOUT: 'команда прогона не уложилась в срок',
  RALPH_COMMAND_TERMINATED: 'команду прогона прервали снаружи',
  aborted: 'прогон прервали',
};

const stageNames = ['implementation', 'validation', 'review'];

// Заголовок issue, заведённой по замечанию ревью: severity в начале строки
// ставит `findingIssueTitle` из `ralph-milestone-review.mjs`. По нему пульт
// отделяет баги от задач плана — другого признака в журнале нет.
const bugTitlePattern = /^\[P[0-3]\]/;

/**
 * Виды токенов. Пять слагаемых не пересекаются и в сумме дают весь объём
 * сессии, поэтому страница вправе показывать и части, и итог.
 *
 * `reasoning` и `answer` — две половины `outputTokens`: CLI кладёт рассуждения
 * внутрь выхода, а сокращаются они разными средствами, поэтому считаются врозь.
 */
const tokenKinds = ['uncachedInput', 'cacheCreation', 'cacheRead', 'reasoning', 'answer'];

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
// Ход прогона по журналу run.log
// -----------------------------------------------------------------------------

/**
 * Числа, которые меняются чаще, чем цикл пишет `state.json`.
 *
 * Номер шага сменяется десятки раз за сессию, а очередь issues — на каждой
 * итерации; обе величины цикл уже печатает в `run.log`. Пульт читает их оттуда,
 * вместо того чтобы заставлять цикл перезаписывать состояние на каждый шаг.
 * Формат этих строк — договор двух модулей набора, и его держит
 * `ralph-gui-data.test.mjs`.
 */

// Хвоста хватает на несколько итераций: вывод инструментов между строками
// бывает объёмным, а читать журнал целиком пульт не должен — он опрашивает
// сервер каждые пятнадцать секунд.
const runLogTailBytes = 64 * 1024;

// `Итерация 12/20; осталось issues: 7.` и `Resume 12/20; осталось issues: 7.`
const iterationLinePattern = /(?:^|\n)(?:Итерация|Resume) (\d+)\/(\d+); осталось issues: (\d+)\./g;
// `[claude step 12/50] правка файла`
const stepLinePattern = /(?:^|\n)\[\S+ step (\d+)\/(\d+)\]/g;
// `Разработка issue #11: использовано шагов 12/50.`
const stepsUsedLinePattern = /(?:^|\n).*: использовано шагов (\d+)\/(\d+)\./g;

function emptyProgress() {
  return {
    iteration: null,
    maxIterations: null,
    issuesRemaining: null,
    turn: null,
    turnLimit: null,
    sessionFinished: false,
  };
}

function readFileTail(filePath, maxBytes) {
  let handle;
  try {
    const size = statSync(filePath).size;
    const length = Math.min(size, maxBytes);
    if (length === 0) return '';
    handle = openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    readSync(handle, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // Хвост начинается посреди строки, а на кириллице — и посреди символа.
    // Первая строка отбрасывается целиком: разобранная наполовину, она дала бы
    // неверное число.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/** Последнее совпадение: журнал дописывается, и текущее состояние — в конце. */
function lastMatch(pattern, text) {
  pattern.lastIndex = 0;
  let last = null;
  let match;
  while ((match = pattern.exec(text)) !== null) last = match;

  return last;
}

export function readRunProgress(dependencies = {}) {
  const logPath =
    dependencies.logPath ?? path.join(resolveRuntimeDirectory(dependencies), 'run.log');
  const text = readFileTail(logPath, dependencies.maxBytes ?? runLogTailBytes);
  if (text === '') return emptyProgress();

  const iteration = lastMatch(iterationLinePattern, text);
  const step = lastMatch(stepLinePattern, text);
  const used = lastMatch(stepsUsedLinePattern, text);
  // Итог сессии напечатан после последнего шага — сессия закрыта, и её номер
  // шага уже не растёт. Иначе пульт показывал бы шаг мёртвой сессии как живой.
  const finished = Boolean(used) && (!step || used.index > step.index);
  const turns = finished ? used : step;

  return {
    iteration: iteration ? Number(iteration[1]) : null,
    maxIterations: iteration ? Number(iteration[2]) : null,
    issuesRemaining: iteration ? Number(iteration[3]) : null,
    turn: turns ? Number(turns[1]) : null,
    turnLimit: turns ? Number(turns[2]) : null,
    sessionFinished: finished,
  };
}

// -----------------------------------------------------------------------------
// Состояние прогона
// -----------------------------------------------------------------------------

/** Порядок фаз задан планом в конфигурации, а не порядком работы над ними. */
function plannedPhaseMilestones(config) {
  const phases = Array.isArray(config?.phases) ? config.phases : [];

  return phases
    .map((phase) => phase?.milestone)
    .filter((milestone) => typeof milestone === 'string' && milestone !== '');
}

/**
 * @returns {{ running: boolean, run: object | null, staleLock: boolean }}
 * `running` — лок есть и его процесс жив. `staleLock` — лок есть, процесса нет:
 * прогон упал, не убрав за собой.
 */
export function readRunState(dependencies = {}) {
  const directory = resolveRuntimeDirectory(dependencies);
  const alive = dependencies.isProcessAlive ?? isProcessAlive;
  const config = readJsonSafely(dependencies.configPath ?? configFilePath, null);
  // План фаз нужен и без прогона: пульт показывает «фаза 2 из 3» на журнале
  // прошлой ночи, когда состояния на диске уже нет.
  const plannedPhases = plannedPhaseMilestones(config);
  const lock = readJsonSafely(path.join(directory, 'run.lock'), null);
  if (!lock) return { running: false, run: null, staleLock: false, plannedPhases };

  const state = readJsonSafely(path.join(directory, 'state.json'), null);
  const running = alive(lock.pid);
  // Хвост журнала читается только у живого прогона: у брошенного лока последние
  // строки принадлежат мёртвой сессии, и «шаг 12 из 50» читался бы как текущий.
  const progress = running ? readRunProgress(dependencies) : emptyProgress();
  const issue = state?.issue ?? null;

  return {
    running,
    staleLock: !running,
    plannedPhases,
    run: {
      mode: lock.mode ?? null,
      branch: lock.branch ?? state?.branch ?? null,
      pid: lock.pid ?? null,
      startedAt: lock.startedAt ?? null,
      milestone: state?.milestone ?? null,
      phaseIndex: state?.phaseIndex ?? null,
      phaseCount: state?.phaseCount ?? (plannedPhases.length || null),
      iterationsUsed: state?.iterationsUsed ?? null,
      maxIterations: config?.maxIterations ?? null,
      issueNumber: issue?.number ?? null,
      issueTitle: issue?.title ?? null,
      issuePhase: issue?.phase ?? null,
      // Круги внутри одной issue: сколько раз агент возвращался чинить проверки
      // и сколько раз его работу заворачивало ревью. Лимиты стоят рядом, иначе
      // число «2» не говорит, близко ли задача к отказу.
      validationFixAttempts: issue?.validationFixAttempts ?? null,
      maxTestFixAttempts: config?.maxTestFixAttempts ?? null,
      reviewFixAttempts: issue?.reviewFixAttempts ?? null,
      maxReviewFixAttempts: config?.maxReviewFixAttempts ?? null,
      // Шаг и очередь приходят из журнала: в состоянии их нет.
      turn: progress.turn,
      turnLimit: progress.turnLimit,
      turnFinished: progress.sessionFinished,
      issuesRemaining: progress.issuesRemaining,
      stateUpdatedAt: state?.updatedAt ?? null,
      logUpdatedAt: fileModifiedAt(path.join(directory, 'run.log')),
    },
  };
}

// -----------------------------------------------------------------------------
// Расход по задачам
// -----------------------------------------------------------------------------

function emptyTokens() {
  return Object.fromEntries(tokenKinds.map((kind) => [kind, 0]));
}

function addTokens(target, source) {
  for (const kind of tokenKinds) target[kind] += source[kind];

  return target;
}

export function totalTokens(tokens) {
  return tokenKinds.reduce((total, kind) => total + numberOrZero(tokens?.[kind]), 0);
}

const tokenCounterFields = [
  'uncachedInputTokens',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
];

function hasTokenCounters(agent) {
  return tokenCounterFields.some((field) => typeof agent[field] === 'number');
}

function agentTokens(agent) {
  const output = numberOrZero(agent.outputTokens);
  // Рассуждения не могут превышать выход: иначе `answer` уйдёт в минус и сумма
  // частей разойдётся с итогом.
  const reasoning = Math.min(numberOrZero(agent.thinkingTokens), output);

  return {
    // Читаются оба имени поля входа: `inputTokens` в записях старого формата и
    // `uncachedInputTokens` в новых. Смысл один — вход мимо кэша, — и в одной
    // записи оба имени не встречаются.
    uncachedInput: numberOrZero(agent.uncachedInputTokens) + numberOrZero(agent.inputTokens),
    cacheCreation: numberOrZero(agent.cacheCreationTokens),
    cacheRead: numberOrZero(agent.cacheReadTokens),
    reasoning,
    answer: output - reasoning,
  };
}

/**
 * Роль — это операция прогона: реализация, ревью задачи, ревью milestone. Сессии
 * одной роли складываются: попытка вправе запустить их несколько, и человеку
 * нужна цена операции, а не порядковый номер сессии.
 *
 * `costUsd` складывается только по сессиям, которые его прислали, а их число
 * едет рядом: у Codex цену не присылает ни одна сессия, и ноль читался бы как
 * «бесплатно».
 */
function groupAgentsByRole(agents) {
  const byRole = new Map();
  for (const agent of agents) {
    const role = agent.role ?? null;
    const key = String(role);
    let group = byRole.get(key);
    if (!group) {
      group = {
        role,
        sessions: 0,
        turns: 0,
        models: [],
        tokens: emptyTokens(),
        sessionsWithoutTokens: 0,
        costUsd: null,
        costReportedBy: 0,
      };
      byRole.set(key, group);
    }
    group.sessions += 1;
    group.turns += numberOrZero(agent.turns);
    // Считается отсутствие счётчиков, а не нулевой объём: сессия, оборвавшаяся
    // до первого запроса, честно присылает нули, а убитая лимитом шагов не
    // присылает ничего — и её объём в итог не попадает вовсе.
    if (!hasTokenCounters(agent)) group.sessionsWithoutTokens += 1;
    for (const model of Array.isArray(agent.models) ? agent.models : []) {
      if (!group.models.includes(model)) group.models.push(model);
    }
    addTokens(group.tokens, agentTokens(agent));
    if (typeof agent.costUsd === 'number') {
      group.costUsd = roundMoney(numberOrZero(group.costUsd) + agent.costUsd);
      group.costReportedBy += 1;
    }
  }

  return [...byRole.values()].map((group) => ({
    ...group,
    tokensTotal: totalTokens(group.tokens),
  }));
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
  const roles = groupAgentsByRole(Array.isArray(entry.agents) ? entry.agents : []);
  const tokens = roles.reduce((sum, role) => addTokens(sum, role.tokens), emptyTokens());
  const silentSessions = roles.reduce((count, role) => count + role.sessionsWithoutTokens, 0);

  return {
    iteration: entry.iteration ?? null,
    startedAt: entry.startedAt ?? null,
    finishedAt: entry.finishedAt ?? null,
    outcome: entry.outcome ?? null,
    reason: entry.reason ?? null,
    wallMs: numberOrZero(entry.wallMs),
    agentCli: entry.agentCli ?? null,
    stages: normalizeStages(entry.stages),
    roles,
    tokens,
    tokensTotal: totalTokens(tokens),
    sessionsWithoutTokens: silentSessions,
  };
}

function emptySpend(metricsUnreadable = false) {
  return {
    totals: {
      tasks: 0,
      attempts: 0,
      milestoneReviews: 0,
      completed: 0,
      parked: 0,
      bugsCompleted: 0,
      bugsParked: 0,
      wallMs: 0,
      sessions: 0,
      sessionsWithoutTokens: 0,
      tokens: emptyTokens(),
      tokensTotal: 0,
      missesMilestoneReview: true,
      metricsUnreadable,
    },
    period: { fromIso: null, toIso: null, storedAttempts: 0, maxStored: maxStoredIssueRecords },
    phases: [],
    tasks: [],
  };
}

/**
 * Свод по фазам: та же история, но собранная так, как её ведут — фазами плана,
 * а не строками по убыванию объёма.
 *
 * Задача считается закрытой или отложенной по последней попытке: до неё issue
 * могла падать на проверках сколько угодно раз, и каждая такая попытка — не
 * отдельная судьба задачи, а её ход.
 */
function phaseRollup(tasks, plannedOrder) {
  const byMilestone = new Map();
  for (const task of tasks) {
    const milestone = task.milestone ?? null;
    let phase = byMilestone.get(milestone);
    if (!phase) {
      phase = {
        milestone,
        planned: plannedOrder.includes(milestone),
        tasks: 0,
        attempts: 0,
        completed: 0,
        parked: 0,
        bugsCompleted: 0,
        bugsParked: 0,
        milestoneReviews: 0,
        wallMs: 0,
        sessions: 0,
        sessionsWithoutTokens: 0,
        tokens: emptyTokens(),
        firstStartedAt: null,
      };
      byMilestone.set(milestone, phase);
    }
    phase.wallMs += task.wallMs;
    phase.sessions += task.sessions;
    phase.sessionsWithoutTokens += task.sessionsWithoutTokens;
    addTokens(phase.tokens, task.tokens);
    if (
      task.firstStartedAt &&
      (phase.firstStartedAt === null || task.firstStartedAt < phase.firstStartedAt)
    ) {
      phase.firstStartedAt = task.firstStartedAt;
    }
    if (task.issue === null) {
      phase.milestoneReviews += task.attempts;
      continue;
    }
    phase.tasks += 1;
    phase.attempts += task.attempts;
    if (task.lastOutcome === 'completed') {
      phase.completed += 1;
      if (task.isBug) phase.bugsCompleted += 1;
    } else if (task.lastOutcome === 'review-parked') {
      phase.parked += 1;
      if (task.isBug) phase.bugsParked += 1;
    }
  }

  return [...byMilestone.values()]
    .sort((left, right) => {
      const leftIndex = plannedOrder.indexOf(left.milestone);
      const rightIndex = plannedOrder.indexOf(right.milestone);
      // Фазы плана идут его порядком, всё остальное — за ними по времени первой
      // попытки: milestone прошлого прогона или заведённый мимо конфигурации не
      // должен разрывать план.
      if (leftIndex !== -1 || rightIndex !== -1) {
        if (leftIndex === -1) return 1;
        if (rightIndex === -1) return -1;
        return leftIndex - rightIndex;
      }
      return String(left.firstStartedAt ?? '').localeCompare(String(right.firstStartedAt ?? ''));
    })
    .map((phase) => ({ ...phase, tokensTotal: totalTokens(phase.tokens) }));
}

/**
 * Одна запись метрик — одна попытка, а не задача, поэтому попытки группируются
 * по номеру issue. `title` берётся из первой записи, где он есть: у попыток
 * старого формата заголовка нет, и тогда он остаётся `null`.
 *
 * Запись без номера issue — это ревью milestone, а не задача. Такие записи стоят в
 * списке отдельной строкой с `issue: null` и группируются по milestone: два ревью
 * разных milestone — разные строки и разная цена.
 *
 * @returns {{ totals: object, period: object, tasks: object[] }} задачи по
 * убыванию объёма токенов.
 */
export function readTaskSpend(dependencies = {}) {
  const metricsPath =
    dependencies.metricsPath ??
    path.join(resolveRuntimeDirectory(dependencies), 'issue-metrics.json');
  // Битый журнал и пустая история — разные беды. Файла нет — `readJsonFile`
  // вернёт `null`; файл есть и не разбирается — бросит, и страница должна
  // сказать про поломку, а не про то, что прогонов не было.
  let stored = null;
  let metricsUnreadable = false;
  try {
    stored = readJsonFile(metricsPath, null);
  } catch {
    metricsUnreadable = true;
  }
  if (stored !== null && !Array.isArray(stored.entries)) metricsUnreadable = true;

  const entries = Array.isArray(stored?.entries) ? stored.entries : [];
  if (entries.length === 0) return emptySpend(metricsUnreadable);

  const byIssue = new Map();
  for (const entry of entries) {
    const issue = entry.issue ?? null;
    const key =
      issue === null ? `${milestoneReviewKeyPrefix}${entry.milestone ?? ''}` : String(issue);
    let task = byIssue.get(key);
    if (!task) {
      task = {
        issue,
        title: null,
        milestone: entry.milestone ?? null,
        attempts: 0,
        lastOutcome: null,
        lastReason: null,
        sessions: 0,
        sessionsWithoutTokens: 0,
        tokens: emptyTokens(),
        wallMs: 0,
        runs: [],
      };
      byIssue.set(key, task);
    }
    if (task.title === null && typeof entry.issueTitle === 'string' && entry.issueTitle !== '') {
      task.title = entry.issueTitle;
    }
    const run = normalizeRun(entry);
    task.attempts += 1;
    task.wallMs += run.wallMs;
    task.sessions += run.roles.reduce((count, role) => count + role.sessions, 0);
    task.sessionsWithoutTokens += run.sessionsWithoutTokens;
    addTokens(task.tokens, run.tokens);
    task.runs.push(run);
  }

  const startTimes = entries.map((entry) => entry.startedAt).filter(Boolean).sort();
  const tasks = [...byIssue.values()].map((task) => {
    // В файле записи лежат от новых к старым; человеку нужен ход попыток.
    task.runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const last = task.runs.at(-1);
    task.lastOutcome = last?.outcome ?? null;
    task.lastReason = last?.reason ?? null;
    task.tokensTotal = totalTokens(task.tokens);
    // Время первой попытки — порядок работы внутри фазы. Номер issue его не
    // задаёт: баги ревью заводятся позже задач плана и получают большие номера.
    task.firstStartedAt = task.runs[0]?.startedAt ?? null;
    task.isBug = typeof task.title === 'string' && bugTitlePattern.test(task.title);

    return task;
  });
  tasks.sort((a, b) => b.tokensTotal - a.tokensTotal);

  // Ревью milestone считается отдельно от задач и попыток: это объём прогона, а не
  // работы над issue. Во время и токены оно входит — их прогон потратил.
  const totals = tasks.reduce(
    (sum, task) => ({
      tasks: sum.tasks + (task.issue === null ? 0 : 1),
      attempts: sum.attempts + (task.issue === null ? 0 : task.attempts),
      milestoneReviews: sum.milestoneReviews + (task.issue === null ? task.attempts : 0),
      wallMs: sum.wallMs + task.wallMs,
      sessions: sum.sessions + task.sessions,
      sessionsWithoutTokens: sum.sessionsWithoutTokens + task.sessionsWithoutTokens,
      tokens: addTokens(sum.tokens, task.tokens),
    }),
    {
      tasks: 0,
      attempts: 0,
      milestoneReviews: 0,
      wallMs: 0,
      sessions: 0,
      sessionsWithoutTokens: 0,
      tokens: emptyTokens(),
    },
  );

  const phases = phaseRollup(
    tasks,
    plannedPhaseMilestones(readJsonSafely(dependencies.configPath ?? configFilePath, null)),
  );
  const progress = phases.reduce(
    (sum, phase) => ({
      completed: sum.completed + phase.completed,
      parked: sum.parked + phase.parked,
      bugsCompleted: sum.bugsCompleted + phase.bugsCompleted,
      bugsParked: sum.bugsParked + phase.bugsParked,
    }),
    { completed: 0, parked: 0, bugsCompleted: 0, bugsParked: 0 },
  );

  return {
    totals: {
      ...totals,
      ...progress,
      tokensTotal: totalTokens(totals.tokens),
      missesMilestoneReview: totals.milestoneReviews === 0,
      metricsUnreadable,
    },
    period: {
      fromIso: startTimes[0] ?? null,
      toIso: startTimes.at(-1) ?? null,
      storedAttempts: entries.length,
      maxStored: maxStoredIssueRecords,
    },
    phases,
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
