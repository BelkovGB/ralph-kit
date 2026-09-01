import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test, { after } from 'node:test';

import { readRunProgress, readRunState, readTaskSpend } from './ralph-gui-data.mjs';
import { temporaryProjectTree } from './ralph-test-support.mjs';

// Каталоги фикстур удаляет тот, кто их создал; журнал в тесте хвоста весит
// сотни килобайт, и остаться на диске он не должен.
const temporaryRoots = [];

function tree(files) {
  const root = temporaryProjectTree(files);
  temporaryRoots.push(root);

  return root;
}

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * Чтение рантайма для пульта.
 *
 * Разбор `run.log` проверяется построчно, потому что формат этих строк —
 * договор между циклом и пультом: цикл их печатает, пульт по ним показывает ход
 * прогона. Правка текста в цикле обязана ронять этот тест, а не молча гасить
 * числа на странице.
 */

function metricsEntry(overrides = {}) {
  return {
    issue: 1,
    issueTitle: 'Задача',
    milestone: 'Фаза 1',
    outcome: 'completed',
    startedAt: '2026-09-01T10:00:00.000Z',
    finishedAt: '2026-09-01T10:10:00.000Z',
    wallMs: 600_000,
    stages: {},
    agents: [{ role: 'development', turns: 4, outputTokens: 100, cacheReadTokens: 900 }],
    ...overrides,
  };
}

function metricsTree(entries, extra = {}) {
  return tree({
    'issue-metrics.json': JSON.stringify({ version: 1, entries }),
    // Конфигурация набора здесь своя: план фаз этого репозитория менял бы
    // порядок групп и ронял тест у потребителя с другой настройкой.
    'ralph.config.json': JSON.stringify({}),
    ...extra,
  });
}

/**
 * Строка журнала в том виде, в каком её пишет `initializePersistentLog`:
 * отметка времени, уровень, текст. Разбор обязан работать по этому виду, а не
 * по сообщению, каким оно ушло в консоль.
 */
function logLine(text, level = 'INFO') {
  return `2026-09-01T10:00:00.000Z ${level} ${text}`;
}

test('пульт берёт ход прогона из последних строк run.log', () => {
  const root = tree({
    'run.log': [
      logLine('Итерация 4/20; осталось issues: 9.'),
      logLine('[claude step 3/50] чтение файла'),
      logLine('claude: использовано шагов 7/50.'),
      logLine('Итерация 5/20; осталось issues: 8.'),
      logLine('[claude step 12/50] правка файла'),
      '',
    ].join('\n'),
  });

  const progress = readRunProgress({ runtimeDir: root });

  assert.equal(progress.iteration, 5);
  assert.equal(progress.maxIterations, 20);
  assert.equal(progress.issuesRemaining, 8);
  assert.equal(progress.turn, 12);
  assert.equal(progress.turnLimit, 50);
  assert.equal(progress.sessionFinished, false);
});

test('строка «Resume» тоже считается началом итерации', () => {
  const root = tree({
    'run.log': `${logLine('Resume 6/20; осталось issues: 3.')}\n`,
  });

  const progress = readRunProgress({ runtimeDir: root });

  assert.equal(progress.iteration, 6);
  assert.equal(progress.issuesRemaining, 3);
});

test('закрытая сессия показывает итоговое число шагов, а не шаг в работе', () => {
  const root = tree({
    'run.log': [
      logLine('[codex step 9/40] правка'),
      logLine('codex: использовано шагов 9/40.'),
      '',
    ].join('\n'),
  });

  const progress = readRunProgress({ runtimeDir: root });

  assert.equal(progress.turn, 9);
  assert.equal(progress.turnLimit, 40);
  assert.equal(progress.sessionFinished, true);
});

test('сессия, убитая лимитом шагов, тоже считается закрытой', () => {
  const root = tree({
    // Шаг в окне остался от прошлой сессии; число берётся из строки breaker,
    // потому что он срабатывает ровно на лимите.
    'run.log': [
      logLine('[claude step 7/50] правка'),
      logLine('Circuit breaker: Ревью issue #11 попытался превысить лимит 30 шагов.', 'ERROR'),
      '',
    ].join('\n'),
  });

  const progress = readRunProgress({ runtimeDir: root });

  assert.equal(progress.turn, 30);
  assert.equal(progress.turnLimit, 30);
  assert.equal(progress.sessionFinished, true);
});

/**
 * Журнал ставит отметку только первой строке записи, а продолжение уводит под
 * отступ. Поэтому отметка и служит границей: хвост журнала, который агент читает
 * при разборе падения и печатает обратно, своих чисел пульту не навязывает.
 */
test('процитированный хвост журнала не подменяет числа прогона', () => {
  const quoted = [
    'вывод инструмента: cat .git/ralph-loop/run.log',
    '  2026-08-31T10:00:00.000Z INFO Итерация 99/99; осталось issues: 0.',
    '  2026-08-31T10:00:01.000Z INFO [claude step 49/50] чтение файла',
    '  2026-08-31T10:00:02.000Z INFO claude: использовано шагов 49/50.',
  ].join('\n');
  const root = tree({
    'run.log': [
      logLine('Итерация 5/20; осталось issues: 8.'),
      logLine('[claude step 3/50] чтение run.log'),
      logLine(quoted),
      '',
    ].join('\n'),
  });

  const progress = readRunProgress({ runtimeDir: root });

  assert.equal(progress.iteration, 5);
  assert.equal(progress.issuesRemaining, 8);
  assert.equal(progress.turn, 3);
  assert.equal(progress.sessionFinished, false);
});

test('окно без единого перевода строки не даёт чисел', () => {
  const root = tree({
    'run.log': `${logLine('начало')}\n${'x'.repeat(9_000)}\n`,
  });

  const progress = readRunProgress({ runtimeDir: root, maxBytes: 4_096 });

  assert.equal(progress.iteration, null);
  assert.equal(progress.turn, null);
});

test('между сессиями текущего шага нет', () => {
  const root = tree({
    'run.log': [
      logLine('[claude step 12/50] правка'),
      logLine('claude: использовано шагов 12/50.'),
      logLine('Итерация 6/20; осталось issues: 4.'),
      '',
    ].join('\n'),
  });

  const progress = readRunProgress({ runtimeDir: root });

  assert.equal(progress.iteration, 6);
  assert.equal(progress.turn, null);
  assert.equal(progress.turnLimit, null);
});

/**
 * Вывод инструментов агента попадает в журнал целиком, и внутренние строки
 * многострочного сообщения отметки времени не получают. Считать их строками
 * цикла нельзя: агенту велено читать `run.log` при разборе падения, и
 * прочитанный хвост возвращается в журнал.
 */
test('строка без отметки журнала числами прогона не считается', () => {
  const root = tree({
    'run.log': [
      logLine('Итерация 5/20; осталось issues: 8.'),
      logLine('[claude step 3/50] чтение run.log'),
      'Итерация 99/99; осталось issues: 0.',
      'подделка: использовано шагов 1/1.',
      '[claude step 42/50] строка из чужого вывода',
      '',
    ].join('\n'),
  });

  const progress = readRunProgress({ runtimeDir: root });

  assert.equal(progress.iteration, 5);
  assert.equal(progress.issuesRemaining, 8);
  assert.equal(progress.turn, 3);
  assert.equal(progress.sessionFinished, false);
});

test('пульт читает хвост, а не весь журнал прогона', () => {
  const noise = `${logLine('x'.repeat(200))}\n`.repeat(2_000);
  const root = tree({
    'run.log':
      `${logLine('Итерация 1/20; осталось issues: 40.')}\n` +
      `${noise}${logLine('Итерация 33/40; осталось issues: 2.')}\n`,
  });

  const progress = readRunProgress({ runtimeDir: root, maxBytes: 4_096 });

  assert.equal(progress.iteration, 33);
  assert.equal(progress.issuesRemaining, 2);
});

test('без журнала прогона числа остаются пропуском, а не нулём', () => {
  const progress = readRunProgress({ runtimeDir: tree({}) });

  assert.deepEqual(progress, {
    iteration: null,
    maxIterations: null,
    issuesRemaining: null,
    turn: null,
    turnLimit: null,
    sessionFinished: false,
  });
});

test('состояние прогона называет круги проверок и ревью вместе с их лимитами', () => {
  const root = tree({
    'run.lock': JSON.stringify({ pid: 4242, mode: '--run', startedAt: '2026-09-01T10:00:00.000Z' }),
    'state.json': JSON.stringify({
      version: 2,
      branch: 'ralph/phase-2',
      milestone: 'Фаза 2',
      phaseIndex: 1,
      phaseCount: 3,
      iterationsUsed: 12,
      issue: { number: 11, phase: 'validating', validationFixAttempts: 2, reviewFixAttempts: 1 },
    }),
    'run.log': `${logLine('[claude step 12/50] запуск проверок')}\n`,
    'ralph.config.json': JSON.stringify({
      maxIterations: 20,
      maxTestFixAttempts: 5,
      maxReviewFixAttempts: 3,
      phases: [{ milestone: 'Фаза 1' }, { milestone: 'Фаза 2' }, { milestone: 'Фаза 3' }],
    }),
  });

  const state = readRunState({
    runtimeDir: root,
    configPath: `${root}/ralph.config.json`,
    isProcessAlive: () => true,
  });

  assert.equal(state.running, true);
  assert.equal(state.run.validationFixAttempts, 2);
  assert.equal(state.run.maxTestFixAttempts, 5);
  assert.equal(state.run.reviewFixAttempts, 1);
  assert.equal(state.run.maxReviewFixAttempts, 3);
  assert.equal(state.run.phaseCount, 3);
  assert.equal(state.run.turn, 12);
  assert.equal(state.run.turnLimit, 50);
});

test('брошенный лок не выдаёт свой последний шаг за текущий', () => {
  const root = tree({
    'run.lock': JSON.stringify({ pid: 4242, mode: '--run' }),
    'run.log': `${logLine('[claude step 12/50] правка')}\n`,
    'ralph.config.json': JSON.stringify({}),
  });

  const state = readRunState({
    runtimeDir: root,
    configPath: `${root}/ralph.config.json`,
    isProcessAlive: () => false,
  });

  assert.equal(state.staleLock, true);
  assert.equal(state.run.turn, null);
  assert.equal(state.run.issuesRemaining, null);
});

test('без прогона фазы берутся из конфигурации, а не из состояния', () => {
  const root = tree({
    'ralph.config.json': JSON.stringify({
      phases: [{ milestone: 'Фаза 1' }, { milestone: 'Фаза 2' }],
    }),
  });

  const state = readRunState({ runtimeDir: root, configPath: `${root}/ralph.config.json` });

  assert.equal(state.running, false);
  assert.equal(state.run, null);
  assert.deepEqual(state.plannedPhases, ['Фаза 1', 'Фаза 2']);
});

test('задачи группируются по фазам в порядке плана, а не по объёму', () => {
  const root = metricsTree(
    [
      metricsEntry({ issue: 5, milestone: 'Фаза 2', startedAt: '2026-09-01T12:00:00.000Z' }),
      metricsEntry({ issue: 2, milestone: 'Фаза 1', startedAt: '2026-09-01T11:00:00.000Z' }),
      metricsEntry({
        issue: 9,
        milestone: 'Фаза 3: вне плана',
        startedAt: '2026-09-01T13:00:00.000Z',
      }),
    ],
    {
      'ralph.config.json': JSON.stringify({
        phases: [{ milestone: 'Фаза 1' }, { milestone: 'Фаза 2' }],
      }),
    },
  );

  const spend = readTaskSpend({
    metricsPath: `${root}/issue-metrics.json`,
    configPath: `${root}/ralph.config.json`,
  });

  assert.deepEqual(
    spend.phases.map((phase) => phase.milestone),
    ['Фаза 1', 'Фаза 2', 'Фаза 3: вне плана'],
  );
  assert.deepEqual(
    spend.phases.map((phase) => phase.planned),
    [true, true, false],
  );
});

test('фаза считает закрытые, отложенные задачи и баги из ревью', () => {
  const root = metricsTree([
    metricsEntry({ issue: 1, outcome: 'completed' }),
    metricsEntry({ issue: 2, outcome: 'review-parked' }),
    metricsEntry({ issue: 3, issueTitle: '[P1] page.tsx: 2 review findings', outcome: 'completed' }),
    metricsEntry({ issue: 4, issueTitle: '[P2] лишний запрос', outcome: 'review-parked' }),
    metricsEntry({ issue: null, outcome: 'milestone-review', reason: 'вердикт pass' }),
  ]);

  const spend = readTaskSpend({
    metricsPath: `${root}/issue-metrics.json`,
    configPath: `${root}/ralph.config.json`,
  });
  const [phase] = spend.phases;

  assert.equal(phase.completed, 2);
  assert.equal(phase.parked, 2);
  assert.equal(phase.bugsCompleted, 1);
  assert.equal(phase.bugsParked, 1);
  assert.equal(phase.milestoneReviews, 1);
  assert.equal(spend.totals.completed, 2);
  assert.equal(spend.totals.parked, 2);
  assert.equal(spend.totals.bugsCompleted, 1);
  assert.equal(spend.totals.bugsParked, 1);
});

test('последняя попытка задачи решает, закрыта она или отложена', () => {
  const root = metricsTree([
    metricsEntry({ issue: 7, outcome: 'validation-failed', startedAt: '2026-09-01T10:00:00.000Z' }),
    metricsEntry({ issue: 7, outcome: 'completed', startedAt: '2026-09-01T10:30:00.000Z' }),
  ]);

  const spend = readTaskSpend({
    metricsPath: `${root}/issue-metrics.json`,
    configPath: `${root}/ralph.config.json`,
  });

  assert.equal(spend.totals.completed, 1);
  assert.equal(spend.phases[0].tasks, 1);
  assert.equal(spend.phases[0].attempts, 2);
});

test('порядок работы внутри фазы читается по первой попытке задачи', () => {
  const root = metricsTree([
    metricsEntry({ issue: 8, startedAt: '2026-09-01T11:00:00.000Z' }),
    metricsEntry({ issue: 3, startedAt: '2026-09-01T09:00:00.000Z' }),
    metricsEntry({ issue: 3, startedAt: '2026-09-01T12:00:00.000Z' }),
  ]);

  const spend = readTaskSpend({
    metricsPath: `${root}/issue-metrics.json`,
    configPath: `${root}/ralph.config.json`,
  });
  const byIssue = new Map(spend.tasks.map((task) => [task.issue, task]));

  assert.equal(byIssue.get(3).firstStartedAt, '2026-09-01T09:00:00.000Z');
  assert.equal(byIssue.get(8).firstStartedAt, '2026-09-01T11:00:00.000Z');
});

test('пустой журнал прогона и журнал без строк цикла дают пропуск', () => {
  assert.equal(readRunProgress({ runtimeDir: tree({ 'run.log': '' }) }).turn, null);

  const started = tree({ 'run.log': `${logLine('Ralph process started {"pid":1}')}\n` });

  assert.deepEqual(readRunProgress({ runtimeDir: started }), {
    iteration: null,
    maxIterations: null,
    issuesRemaining: null,
    turn: null,
    turnLimit: null,
    sessionFinished: false,
  });
});

test('число фаз берётся из плана, когда состояние его не знает', () => {
  const root = tree({
    'run.lock': JSON.stringify({ pid: 4242, mode: '--run' }),
    // Состояние прошлого формата: `phaseCount` в нём не записан.
    'state.json': JSON.stringify({ version: 2, phaseIndex: 1, milestone: 'Фаза 2' }),
    'ralph.config.json': JSON.stringify({
      phases: [{ milestone: 'Фаза 1' }, { milestone: 'Фаза 2' }, { milestone: 'Фаза 3' }],
    }),
  });

  const state = readRunState({
    runtimeDir: root,
    configPath: `${root}/ralph.config.json`,
    isProcessAlive: () => true,
  });

  assert.equal(state.run.phaseCount, 3);
});

test('состояние отдаёт заголовок задачи, очередь и признак закрытой сессии', () => {
  const root = tree({
    'run.lock': JSON.stringify({ pid: 4242, mode: '--run' }),
    'state.json': JSON.stringify({
      version: 2,
      milestone: 'Фаза 2',
      issue: { number: 11, title: 'Перенести цены', phase: 'reviewing' },
    }),
    'run.log': [
      logLine('Итерация 12/20; осталось issues: 5.'),
      logLine('[claude step 27/50] правка'),
      logLine('Ревью issue #11: использовано шагов 27/50.'),
      '',
    ].join('\n'),
    'ralph.config.json': JSON.stringify({}),
  });

  const state = readRunState({
    runtimeDir: root,
    configPath: `${root}/ralph.config.json`,
    isProcessAlive: () => true,
  });

  assert.equal(state.run.issueTitle, 'Перенести цены');
  assert.equal(state.run.issuesRemaining, 5);
  assert.equal(state.run.turn, 27);
  assert.equal(state.run.turnFinished, true);
});

test('фаза складывает время, сессии и токены своих задач', () => {
  const root = metricsTree([
    metricsEntry({ issue: 1, wallMs: 600_000 }),
    metricsEntry({
      issue: 2,
      wallMs: 300_000,
      agents: [
        { role: 'development', turns: 3, outputTokens: 200, cacheReadTokens: 1_800 },
        { role: 'review', turns: 2, outputTokens: 100, cacheReadTokens: 900 },
      ],
    }),
  ]);

  const [phase] = readTaskSpend({
    metricsPath: `${root}/issue-metrics.json`,
    configPath: `${root}/ralph.config.json`,
  }).phases;

  assert.equal(phase.wallMs, 900_000);
  assert.equal(phase.sessions, 3);
  assert.equal(phase.sessionsWithoutTokens, 0);
  // 100 + 900 у первой задачи и 200 + 1800 + 100 + 900 у второй.
  assert.equal(phase.tokensTotal, 4_000);
  assert.equal(phase.tokens.cacheRead, 3_600);
});

test('сессия без счётчиков считается отдельно от объёма фазы', () => {
  const root = metricsTree([
    metricsEntry({ issue: 1, agents: [{ role: 'development', turns: 3 }] }),
  ]);

  const [phase] = readTaskSpend({
    metricsPath: `${root}/issue-metrics.json`,
    configPath: `${root}/ralph.config.json`,
  }).phases;

  assert.equal(phase.sessions, 1);
  assert.equal(phase.sessionsWithoutTokens, 1);
  assert.equal(phase.tokensTotal, 0);
});

test('запись без заголовка и без milestone не ломает свод', () => {
  const root = metricsTree([
    { issue: 42, outcome: 'completed', startedAt: '2026-09-01T10:00:00.000Z', wallMs: 60_000 },
  ]);

  const spend = readTaskSpend({
    metricsPath: `${root}/issue-metrics.json`,
    configPath: `${root}/ralph.config.json`,
  });

  assert.equal(spend.tasks[0].title, null);
  assert.equal(spend.tasks[0].isBug, false);
  assert.equal(spend.phases[0].milestone, null);
  assert.equal(spend.phases[0].planned, false);
  assert.equal(spend.totals.completed, 1);
  assert.equal(spend.totals.bugsCompleted, 0);
});

test('битый журнал расхода отличается от отсутствующего', () => {
  const broken = tree({ 'issue-metrics.json': '{"version": 1, "entries": [' });
  const wrongShape = tree({ 'issue-metrics.json': JSON.stringify({ version: 1, entries: {} }) });
  const missing = tree({});

  const brokenSpend = readTaskSpend({ metricsPath: `${broken}/issue-metrics.json` });
  const wrongSpend = readTaskSpend({ metricsPath: `${wrongShape}/issue-metrics.json` });
  const missingSpend = readTaskSpend({ metricsPath: `${missing}/issue-metrics.json` });

  assert.equal(brokenSpend.totals.metricsUnreadable, true);
  assert.equal(wrongSpend.totals.metricsUnreadable, true);
  // Файла нет — прогонов не было; это не поломка, и страница говорит другое.
  assert.equal(missingSpend.totals.metricsUnreadable, false);
  for (const spend of [brokenSpend, wrongSpend, missingSpend]) {
    assert.deepEqual(spend.phases, []);
    assert.deepEqual(spend.tasks, []);
    assert.equal(spend.totals.completed, 0);
    assert.equal(spend.totals.tokensTotal, 0);
  }
});
