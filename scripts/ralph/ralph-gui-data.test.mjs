import assert from 'node:assert/strict';
import test from 'node:test';

import { readRunProgress, readRunState, readTaskSpend } from './ralph-gui-data.mjs';
import { temporaryProjectTree } from './ralph-test-support.mjs';

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
  return temporaryProjectTree({
    'issue-metrics.json': JSON.stringify({ version: 1, entries }),
    ...extra,
  });
}

test('пульт берёт ход прогона из последних строк run.log', () => {
  const root = temporaryProjectTree({
    'run.log': [
      'Итерация 4/20; осталось issues: 9.',
      '[claude step 3/50] чтение файла',
      'claude: использовано шагов 7/50.',
      'Итерация 5/20; осталось issues: 8.',
      '[claude step 12/50] правка файла',
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
  const root = temporaryProjectTree({ 'run.log': 'Resume 6/20; осталось issues: 3.\n' });

  const progress = readRunProgress({ runtimeDir: root });

  assert.equal(progress.iteration, 6);
  assert.equal(progress.issuesRemaining, 3);
});

test('закрытая сессия показывает итоговое число шагов, а не шаг в работе', () => {
  const root = temporaryProjectTree({
    'run.log': ['[codex step 9/40] правка', 'codex: использовано шагов 9/40.', ''].join('\n'),
  });

  const progress = readRunProgress({ runtimeDir: root });

  assert.equal(progress.turn, 9);
  assert.equal(progress.turnLimit, 40);
  assert.equal(progress.sessionFinished, true);
});

test('пульт читает хвост, а не весь журнал прогона', () => {
  const noise = `${'x'.repeat(200)}\n`.repeat(2_000);
  const root = temporaryProjectTree({
    'run.log': `Итерация 1/20; осталось issues: 40.\n${noise}Итерация 33/40; осталось issues: 2.\n`,
  });

  const progress = readRunProgress({ runtimeDir: root, maxBytes: 4_096 });

  assert.equal(progress.iteration, 33);
  assert.equal(progress.issuesRemaining, 2);
});

test('без журнала прогона числа остаются пропуском, а не нулём', () => {
  const progress = readRunProgress({ runtimeDir: temporaryProjectTree({}) });

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
  const root = temporaryProjectTree({
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
    'run.log': '[claude step 12/50] запуск проверок\n',
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
  const root = temporaryProjectTree({
    'run.lock': JSON.stringify({ pid: 4242, mode: '--run' }),
    'run.log': '[claude step 12/50] правка\n',
  });

  const state = readRunState({ runtimeDir: root, isProcessAlive: () => false });

  assert.equal(state.staleLock, true);
  assert.equal(state.run.turn, null);
  assert.equal(state.run.issuesRemaining, null);
});

test('без прогона фазы берутся из конфигурации, а не из состояния', () => {
  const root = temporaryProjectTree({
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

  const spend = readTaskSpend({ metricsPath: `${root}/issue-metrics.json` });
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

  const spend = readTaskSpend({ metricsPath: `${root}/issue-metrics.json` });

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

  const spend = readTaskSpend({ metricsPath: `${root}/issue-metrics.json` });
  const byIssue = new Map(spend.tasks.map((task) => [task.issue, task]));

  assert.equal(byIssue.get(3).firstStartedAt, '2026-09-01T09:00:00.000Z');
  assert.equal(byIssue.get(8).firstStartedAt, '2026-09-01T11:00:00.000Z');
});
