import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { reviewAlreadyPassed, runPhasePlan } from './ralph-loop.mjs';
import { configForPhase, normalizePhases } from './ralph-config.mjs';
import { githubPagedArray } from './ralph-github-client.mjs';
import { createStateStore, setActiveStateStore } from './ralph-state-store.mjs';

test('persistent state survives restart and enforces branch identity', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-state-'));
  const statePath = path.join(directory, 'state.json');
  const config = {
    branch: 'feature/state',
    baseBranch: 'master',
    milestone: 'State milestone',
  };

  try {
    const first = createStateStore(config, '--run', statePath);
    assert.equal(first.iterationsUsed, 0);
    first.reserveIteration();
    first.beginIssue(
      {
        number: 42,
        title: 'Resume me',
        body: 'Requirements',
        url: 'https://example.test/issues/42',
      },
      'a'.repeat(40),
    );

    const resumed = createStateStore(config, '--run', statePath);
    assert.equal(resumed.iterationsUsed, 1);
    assert.equal(resumed.issue.number, 42);
    assert.equal(resumed.issue.phase, 'agent-running');
    assert.equal(resumed.issue.body, 'Requirements');
    assert.throws(
      () => createStateStore({ ...config, branch: 'feature/another' }, '--run', statePath),
      /относится к другой ветке/,
    );

    resumed.finish();
    assert.equal(existsSync(statePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('automatic issue approvals survive an AFK process restart', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-state-approvals-'));
  const statePath = path.join(directory, 'state.json');
  const config = {
    branch: 'feature/approved',
    baseBranch: 'master',
    milestone: 'Approved phase',
  };
  const snapshot = { title: 'Trusted task', body: 'Frozen requirements.' };

  try {
    const first = createStateStore(config, '--run', statePath);
    first.approveIssueSnapshot(26, snapshot);

    const resumed = createStateStore(config, '--run', statePath);
    assert.deepEqual(resumed.approvedIssueSnapshots, { 26: snapshot });
    resumed.finish();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check mode does not create persistent state', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-state-check-'));
  const statePath = path.join(directory, 'state.json');
  try {
    const store = createStateStore(
      { branch: 'feature/check', baseBranch: 'master', milestone: 'Check' },
      '--check',
      statePath,
    );
    assert.equal(store.state, null);
    assert.equal(existsSync(statePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('phase config supports an ordered plan and rejects a config without a phases array', () => {
  const phases = normalizePhases({
    baseBranch: 'master',
    phases: [
      { milestone: 'API', branch: 'feature/api' },
      { milestone: 'Web', branch: 'feature/web', baseBranch: 'develop' },
    ],
  });
  assert.deepEqual(phases, [
    { milestone: 'API', branch: 'feature/api', baseBranch: 'master' },
    { milestone: 'Web', branch: 'feature/web', baseBranch: 'develop' },
  ]);
  assert.throws(
    () => normalizePhases({ milestone: 'Legacy', branch: 'feature/legacy', baseBranch: 'master' }),
    /Добавьте непустой массив "phases"/,
  );
  assert.throws(
    () =>
      normalizePhases({
        baseBranch: 'master',
        phases: [
          { milestone: 'One', branch: 'feature/same' },
          { milestone: 'Two', branch: 'feature/same' },
        ],
      }),
    /повторяющиеся значения "branch"/,
  );
});

test('persistent state advances a phase atomically and resets its iteration budget', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-phases-state-'));
  const statePath = path.join(directory, 'state.json');
  const plan = {
    phases: [
      { milestone: 'One', branch: 'feature/one', baseBranch: 'master' },
      { milestone: 'Two', branch: 'feature/two', baseBranch: 'master' },
    ],
    phasePlanId: 'stable-plan',
  };
  const firstConfig = configForPhase(plan, 0);
  const secondConfig = configForPhase(plan, 1);

  try {
    const first = createStateStore(firstConfig, '--run', statePath);
    first.reserveIteration();
    assert.equal(first.iterationsUsed, 1);
    assert.equal(first.advancePhase(secondConfig), true);
    assert.equal(first.phaseIndex, 1);
    assert.equal(first.iterationsUsed, 0);

    const resumed = createStateStore(secondConfig, '--run', statePath);
    assert.equal(resumed.phaseIndex, 1);
    assert.equal(resumed.state.milestone, 'Two');
    assert.equal(resumed.state.branch, 'feature/two');
    resumed.finish();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('active state from an older Ralph version stops the run instead of migrating', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-phases-legacy-'));
  const statePath = path.join(directory, 'state.json');
  const plan = {
    phases: [
      { milestone: 'One', branch: 'feature/one', baseBranch: 'master' },
      { milestone: 'Two', branch: 'feature/two', baseBranch: 'master' },
    ],
    phasePlanId: 'stable-plan',
  };
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      runId: 'legacy',
      status: 'active',
      branch: 'feature/one',
      baseBranch: 'master',
      milestone: 'One',
      iterationsUsed: 1,
      issue: { number: 42, phase: 'reviewing' },
    }),
  );

  try {
    assert.throws(
      () => createStateStore(configForPhase(plan, 0), '--run', statePath),
      /относится к другой ветке, базе или milestone/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('phase plan completes every phase in order and persists each transition', async () => {
  const plan = {
    phases: [
      { milestone: 'One', branch: 'feature/one', baseBranch: 'master' },
      { milestone: 'Two', branch: 'feature/two', baseBranch: 'master' },
    ],
    phasePlanId: 'stable-plan',
  };
  let phaseIndex = 0;
  let finished = false;
  const transitions = [];
  const stateStore = {
    get phaseIndex() {
      return phaseIndex;
    },
    advancePhase(nextConfig) {
      transitions.push(nextConfig.milestone);
      phaseIndex = nextConfig.phaseIndex;
    },
    finish() {
      finished = true;
    },
  };
  const executed = [];

  const result = await runPhasePlan(plan, stateStore, async (config) => {
    executed.push(config.milestone);
    return { verdict: 'pass', pullRequest: { number: executed.length } };
  });

  assert.equal(result.verdict, 'pass');
  assert.deepEqual(executed, ['One', 'Two']);
  assert.deepEqual(transitions, ['Two']);
  assert.equal(finished, true);
});

test('phase plan never advances after an incomplete milestone result', async () => {
  const plan = {
    phases: [
      { milestone: 'One', branch: 'feature/one', baseBranch: 'master' },
      { milestone: 'Two', branch: 'feature/two', baseBranch: 'master' },
    ],
    phasePlanId: 'stable-plan',
  };
  let transitions = 0;
  let finishes = 0;
  const result = await runPhasePlan(
    plan,
    {
      phaseIndex: 0,
      advancePhase: () => (transitions += 1),
      finish: () => (finishes += 1),
    },
    async () => ({ verdict: 'fail' }),
  );

  assert.equal(result.verdict, 'fail');
  assert.equal(transitions, 0);
  assert.equal(finishes, 0);
});

test('GitHub pagination combines pages and fails instead of silently truncating', () => {
  const makePage = (prefix, length) =>
    Array.from({ length }, (_, index) => ({ id: `${prefix}-${index}` }));
  const pages = [makePage('first', 100), makePage('second', 1)];
  const calls = [];
  const combined = githubPagedArray(
    'owner/repository',
    'issues',
    [['state', 'open']],
    'test issues',
    {
      maxPages: 2,
      runNetwork: (_name, args) => {
        const page = Number(args.at(-1).split('=')[1]);
        calls.push(page);
        return { stdout: JSON.stringify(pages[page - 1]) };
      },
    },
  );
  assert.equal(combined.length, 101);
  assert.deepEqual(calls, [1, 2]);

  assert.throws(
    () =>
      githubPagedArray('owner/repository', 'issues', [], 'bounded issues', {
        maxPages: 2,
        runNetwork: () => ({ stdout: JSON.stringify(makePage('full', 100)) }),
      }),
    /достиг лимита 200 объектов/,
  );
});

test('вердикт PASS переживает падение на закрытии issue и не повторяет ревью', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-passed-'));
  const statePath = path.join(directory, 'state.json');
  const config = { branch: 'feature/pass', baseBranch: 'master', milestone: 'Pass milestone' };
  const issue = {
    number: 81,
    title: 'Reviewed already',
    body: 'Requirements',
    url: 'https://example.test/issues/81',
  };

  try {
    const store = createStateStore(config, '--run', statePath);
    store.reserveIteration();
    store.beginIssue(issue, 'a'.repeat(40));
    setActiveStateStore(store);

    // Фаза после PASS: тот же commit повторно ревьюить незачем.
    store.updateIssue({ phase: 'closing', commit: 'b'.repeat(40), reviewedCommit: 'b'.repeat(40) });
    assert.equal(reviewAlreadyPassed(issue, 'b'.repeat(40)), true);

    // Другой commit — другое дерево, вердикт к нему не относится.
    assert.equal(reviewAlreadyPassed(issue, 'c'.repeat(40)), false);
    assert.equal(reviewAlreadyPassed({ ...issue, number: 82 }, 'b'.repeat(40)), false);

    // Ключевое различие: review-failed хранит тот же reviewedCommit, но вердикт
    // там противоположный. Пропуск ревью по одному лишь совпадению commit
    // закрыл бы issue, которую ревью отклонило.
    store.updateIssue({ phase: 'review-failed' });
    assert.equal(reviewAlreadyPassed(issue, 'b'.repeat(40)), false);
  } finally {
    setActiveStateStore(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('остановка host-проверки не мешает продолжить работу с грязным деревом', () => {
  // Host-проверка останавливает цикл фазой `validation-mutated`, а работа
  // агента остаётся незакоммиченной в дереве. Пока эта фаза не разрешает
  // грязное восстановление, следующий запуск падает на проверке чистоты
  // дерева и до восстановления diff дело не доходит.
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-state-mutated-'));
  const statePath = path.join(directory, 'state.json');
  const config = { branch: 'feature/host', baseBranch: 'main', milestone: 'Host phase' };
  const startingCommit = 'b'.repeat(40);

  try {
    const store = createStateStore(config, '--run', statePath);
    store.reserveIteration();
    store.beginIssue(
      { number: 7, title: 'Host', body: 'Body', url: 'https://example.test/issues/7' },
      startingCommit,
    );
    store.updateIssue({ phase: 'validation-mutated' });

    assert.equal(store.allowsDirtyRecovery(config.branch, startingCommit), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
