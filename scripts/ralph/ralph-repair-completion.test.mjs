import assert from 'node:assert/strict';
import test from 'node:test';
import { closeIssueOnce, ensurePullRequestForBranch } from './ralph-github-client.mjs';
import { runContinuousLoop } from './ralph-loop.mjs';
import { committedValidationFailurePatch, hasAcceptedLisaIssueRepair } from './ralph-recovery.mjs';
import { actions, context, withFakeGh } from './ralph-test-support.mjs';
import { run } from './ralph-process-runner.mjs';

for (const scenario of ['closed', 'lost-response', 'unconfirmed']) {
  test(`issue close reconciles ${scenario} without a second PATCH`, () => {
    let reads = 0;
    let patches = 0;
    const failure = new Error('response lost');
    const operation = () => closeIssueOnce('owner/repo', 12, {
      issueState: () => {
        reads += 1;
        if (scenario === 'unconfirmed' && reads > 1) throw new Error('GET unavailable');
        return scenario === 'closed' || reads > 1 ? 'CLOSED' : 'OPEN';
      },
      patchIssue: () => { patches += 1; throw failure; },
    });
    if (scenario === 'unconfirmed') assert.throws(operation, /GET unavailable/);
    else operation();
    assert.equal(patches, scenario === 'closed' ? 0 : 1);
  });
}

test('PR creation lost response is reconciled to its existing PR', async () => {
  const head = run('git', ['rev-parse', 'HEAD']).stdout;
  const details = { number: 12, url: 'https://github.com/owner/repo/pull/12',
    headRefOid: head, headRefName: 'phase', baseRefName: 'main' };
  await withFakeGh(`
    const fs = require('node:fs');
    const marker = require('node:path').join(__dirname, 'created');
    const joined = ghArguments.join(' ');
    if (joined.startsWith('pr list')) console.log(fs.existsSync(marker) ? JSON.stringify([{ number: 12, url: ${JSON.stringify(details.url)} }]) : '[]');
    else if (joined.startsWith('pr create')) { fs.writeFileSync(marker, 'yes'); process.stderr.write('response lost'); process.exit(1); }
    else if (joined.startsWith('pr view')) console.log(${JSON.stringify(JSON.stringify(details))});
    else throw new Error(joined);
  `, async () => {
    assert.deepEqual(ensurePullRequestForBranch({ branch: 'phase', baseBranch: 'main', milestone: 'phase' }, 'owner/repo'), details);
  });
});

function repairStore() {
  const state = { runId: 'run', phaseIndex: 0, issue: { number: 12, title: 'Preserved task',
    body: 'Preserve requirements', phase: 'working-tree', lisaRepairId: 'repair' },
  lisaRepair: { repairId: 'repair', runId: 'run', phaseIndex: 0, issueNumber: 12, status: 'resuming', acceptedTreeHash: 'checked' } };
  return { state, get issue() { return state.issue; }, clearIssue() { state.issue = null; }, finish() {},
    reserveIteration() { throw new Error('accepted repair must not run development'); } };
}

test('receipt cannot authorize a different issue or a different run', () => {
  const store = repairStore();
  assert.equal(hasAcceptedLisaIssueRepair(store.state), true);
  store.state.lisaRepair.issueNumber = 13;
  assert.equal(hasAcceptedLisaIssueRepair(store.state), false);
  store.state.lisaRepair.issueNumber = 12;
  store.state.lisaRepair.runId = 'other';
  assert.equal(hasAcceptedLisaIssueRepair(store.state), false);
});

test('closed issue keeps its accepted dirty repair in the current queue', async () => {
  const store = repairStore();
  let finished = false;
  await runContinuousLoop(context({ config: { stopAfterFirstIssue: true }, stateStore: store }), actions({
    openIssues: () => [], issueState: () => 'CLOSED', workingTreeStatus: () => ' M scripts/ralph/repair.mjs',
    refreshIssue: (_repo, _number, issue) => ({ ...issue, state: 'CLOSED' }),
    runAgentOnIssue: async (_config, _repo, issue) => {
      assert.equal(issue.number, 12);
      assert.equal(store.issue.lisaRepairId, 'repair');
      finished = true;
      store.clearIssue();
      return { completed: true };
    },
  }));
  assert.equal(finished, true);
  assert.equal(store.issue, null);
});

test('closed issue without an accepted receipt still rejects dirty work', async () => {
  const store = repairStore();
  store.state.lisaRepair = null;
  await assert.rejects(runContinuousLoop(context({ stateStore: store }), actions({
    openIssues: () => [], issueState: () => 'CLOSED', workingTreeStatus: () => ' M user.txt',
  })), /закрыта.*рабочее дерево/s);
});

for (const hasNextIssue of [false, true]) {
  test(`a local rejected commit blocks publication of the phase (next issue: ${hasNextIssue})`, async () => {
    const issue = { number: 12, title: 'Local issue', body: 'Preserve this commit' };
    const store = repairStore();
    store.state.lisaRepair = null;
    store.state.issue = { ...issue, phase: 'review-failed', commit: 'local-head', recoveryHead: 'local-head' };
    store.reserveIteration = () => 1;
    const nextIssue = { number: 13, title: 'Next issue', body: 'Work waits' };
    const result = await runContinuousLoop(context({ stateStore: store }), actions({
      openIssues: () => hasNextIssue ? [issue, nextIssue] : [issue],
      runAgentOnIssue: async (_config, _repo, current) => {
        assert.equal(current.number, 12);
        return { completed: false, parked: true, publicationBlocked: true };
      },
      createPullRequest: () => { throw new Error('Do not publish this phase'); },
    }));
    assert.equal(result.verdict, 'parked');
    assert.equal(store.issue?.commit, 'local-head');
  });
}

test('a closed issue cannot clear an unpublished commit from the queue', async () => {
  const store = repairStore();
  store.state.lisaRepair = null;
  Object.assign(store.issue, { phase: 'review-failed', commit: 'local-head', recoveryHead: 'local-head' });
  await assert.rejects(runContinuousLoop(context({ stateStore: store }), actions({
    openIssues: () => [], issueState: () => 'CLOSED',
    createPullRequest: () => { throw new Error('Do not publish this phase'); },
  })), /Неопубликованный коммит сохранён/u);
  assert.equal(store.issue.commit, 'local-head');
});

test('a failed revalidation retains the unpublished barrier when the issue is closed', async () => {
  const store = repairStore();
  store.state.lisaRepair = null;
  Object.assign(store.issue, { phase: 'reviewing', commit: 'local-head', recoveryHead: 'local-head',
    reviewReceipt: { head: 'local-head', result: { verdict: 'pass', summary: 'Reviewed', findings: [] } } });
  Object.assign(store.issue, committedValidationFailurePatch(store.issue, { code: 'RALPH_VALIDATION_FAILED' }));
  assert.equal(store.issue.commit, null);
  await assert.rejects(runContinuousLoop(context({ stateStore: store }), actions({
    openIssues: () => [], issueState: () => 'CLOSED', workingTreeStatus: () => '',
    createPullRequest: () => { throw new Error('Do not publish this phase'); },
  })), /Неопубликованный коммит сохранён/u);
  assert.equal(store.issue.pendingPublishHead, 'local-head');
});

test('review failure after an accepted repair returns directly to Lisa', async () => {
  const store = repairStore();
  Object.assign(store.issue, { phase: 'review-failed', commit: 'reviewed-head' });
  let iterations = 0;
  store.reserveIteration = () => ++iterations;
  const result = await runContinuousLoop(context({ config: { stopAfterFirstIssue: true }, stateStore: store }), actions({
    openIssues: () => [store.issue], issueState: () => 'OPEN',
    runAgentOnIssue: async () => assert.fail('A rejected Lisa repair must not return to the ordinary developer'),
  }));
  assert.equal(result.verdict, 'parked');
  assert.equal(iterations, 0);
  assert.equal(store.issue.commit, 'reviewed-head');
});

test('a ready accepted Lisa repair passes the exhausted development budget without reserving an iteration', async () => {
  const store = repairStore();
  store.iterationsUsed = 3;
  store.state.iterationsUsed = 3;
  let checked = false;
  const result = await runContinuousLoop(context({ config: { maxIterations: 3, stopAfterFirstIssue: true }, stateStore: store }), actions({
    openIssues: () => [store.issue], issueState: () => 'OPEN',
    runAgentOnIssue: async () => { checked = true; store.clearIssue(); return { completed: true }; },
  }));
  assert.equal(checked, true);
  assert.equal(result.completed, 1);
  assert.equal(store.iterationsUsed, 3);
});
