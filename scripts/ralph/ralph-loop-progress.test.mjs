import assert from 'node:assert/strict';
import test from 'node:test';
import { runContinuousLoop } from './ralph-loop.mjs';
import { createIssueProcess, updateIssueProcess, phaseProcessSnapshot } from './ralph-process.mjs';
import { readLiveStatus, resetLiveStatus } from './ralph-live-status.mjs';
import { actions, context } from './ralph-test-support.mjs';

test('empty queue exposes milestone review and subsequent verification as operator activities', async () => {
  resetLiveStatus();
  await runContinuousLoop(context(), actions({
    openIssues: () => {
      assert.equal(readLiveStatus().activity.kind, 'queue');
      return [];
    },
    validatePhaseForPullRequest: () => {
      assert.equal(readLiveStatus().activity.kind, 'phase-validation');
      return 'checked-head';
    },
    createPullRequest: (_config, _repository, checkedHead) => {
      assert.equal(readLiveStatus().activity.kind, 'pull-request');
      assert.equal(checkedHead, 'checked-head');
      return { number: 227 };
    },
    runMilestoneReview: async () => {
      const activity = readLiveStatus().activity;
      assert.equal(activity.kind, 'milestone-review');
      assert.match(activity.label, /#227/);
      assert.equal(activity.active, true);
      assert.equal(typeof activity.startedMs, 'number');
      return { verdict: 'pass', findings: [] };
    },
    verifyReviewedPullRequestHead: () => assert.equal(readLiveStatus().activity.kind, 'pull-request-verify'),
    closeMilestone: () => assert.equal(readLiveStatus().activity.kind, 'milestone-close'),
  }));
});

test('failed milestone review exposes creation of followup tasks', async () => {
  resetLiveStatus();
  const stop = new Error('stop after observing followup');
  await assert.rejects(runContinuousLoop(context(), actions({
    openIssues: () => [],
    runMilestoneReview: async () => ({ verdict: 'fail', findings: [{}] }),
    createOrReopenReviewIssues: () => {
      assert.equal(readLiveStatus().activity.kind, 'review-results');
      assert.match(readLiveStatus().activity.label, /#10/);
      throw stop;
    },
  })), (error) => error === stop);
});

test('failed phase validation records the checks failure and blocks PR publication', async () => {
  resetLiveStatus();
  let phaseProcess = createIssueProcess();
  const stateStore = {
    get state() { return { phaseProcess }; },
    recordPhaseProcess(event) { phaseProcess = updateIssueProcess(phaseProcess, event); },
  };
  const failure = new Error('regression failed');
  await assert.rejects(runContinuousLoop(context({ stateStore }), actions({
    validatePhaseForPullRequest: () => { throw failure; },
    createPullRequest: () => assert.fail('must wait for successful checks'),
  })), (error) => error === failure && error.ralphFailureStep === 'pull-request');
  assert.equal(phaseProcessSnapshot(stateStore.state).errorStage, 'validation');
  assert.equal(phaseProcessSnapshot(stateStore.state).completed.includes('publishing'), false);
});

test('a successful phase check does not prove that Lisa repaired PR publication', async () => {
  resetLiveStatus();
  const stateStore = { state: { runId: 'run', phaseIndex: 0, issue: null } };
  const failure = new Error('push still fails');
  await assert.rejects(runContinuousLoop(context({ stateStore }), actions({
    validatePhaseForPullRequest: () => 'checked-head',
    createPullRequest: () => {
      assert.equal(readLiveStatus().lastPassedStep, undefined);
      throw failure;
    },
  })), (error) => error === failure && error.ralphFailureStep === 'pull-request');
  assert.equal(readLiveStatus().lastPassedStep, undefined);
  await runContinuousLoop(context({ stateStore }), actions());
  assert.equal(readLiveStatus().lastPassedStep.step, 'pull-request');
});

test('queue progress counts completed work in this run and separates parked issues', async () => {
  resetLiveStatus();
  const observed = [];
  await runContinuousLoop(context(), actions({
    openIssues: () => [1, 2, 3].map((number) => ({ number, title: `Issue ${number}` })),
    refreshIssue: (_repository, number, issue) => ({
      ...issue, state: number === 1 ? 'CLOSED' : 'OPEN',
    }),
    runAgentOnIssue: async (_config, _repository, issue) => {
      observed.push(readLiveStatus().queueProgress);
      return issue.number === 3 ? { completed: false, parked: true } : { completed: true };
    },
  }));
  assert.deepEqual(observed, [
    { completedInRun: 0, remaining: 2, parked: 0 },
    { completedInRun: 1, remaining: 1, parked: 0 },
  ]);
  assert.deepEqual(readLiveStatus().queueProgress, {
    completedInRun: 1, remaining: 0, parked: 1,
  });
});

test('a new loop resets progress and exposes the effective phase limits', async () => {
  await runContinuousLoop(context({ config: {
    maxIterations: 7, maxTestFixAttempts: 4, maxReviewFixAttempts: 2, stopAfterFirstIssue: true,
  } }), actions({
    openIssues: () => {
      assert.equal(readLiveStatus().queueProgress, null);
      return [];
    },
  }));
  assert.equal(readLiveStatus().phaseConfig.maxIterations, 7);
  assert.equal(readLiveStatus().phaseConfig.maxTestFixAttempts, 4);
  assert.equal(readLiveStatus().phaseConfig.maxReviewFixAttempts, 2);
  assert.deepEqual(readLiveStatus().queueProgress, {
    completedInRun: 0, remaining: 0, parked: 0,
  });
});


test('phase review sees confirmed task completion and published PR before the phase closes', async () => {
  let phaseProcess = createIssueProcess();
  const stateStore = {
    get state() { return { phaseProcess }; },
    recordPhaseProcess(event) { phaseProcess = updateIssueProcess(phaseProcess, event); },
  };
  await runContinuousLoop(context({ stateStore }), actions({
    runMilestoneReview: async () => {
      const snapshot = phaseProcessSnapshot(stateStore.state);
      assert.ok(snapshot.completed.includes('implementation'));
      assert.ok(snapshot.completed.includes('publishing'));
      stateStore.recordPhaseProcess({ type: 'review-start' });
      stateStore.recordPhaseProcess({ type: 'review-result', verdict: 'pass', findings: 0 });
      return { verdict: 'pass', findings: [] };
    },
    closeMilestone: () => {
      assert.deepEqual(phaseProcessSnapshot(stateStore.state).completed,
        ['implementation', 'validation', 'publishing', 'review']);
    },
  }));
  assert.equal(phaseProcessSnapshot(stateStore.state).current, 'done');
});

test('a phase with parked tasks does not claim all tasks completed when its runnable queue empties', async () => {
  let phaseProcess = createIssueProcess();
  const stateStore = {
    get state() { return { phaseProcess }; },
    recordPhaseProcess(event) { phaseProcess = updateIssueProcess(phaseProcess, event); },
    finish() {},
    reserveIteration() { return 1; },
  };
  const result = await runContinuousLoop(context({ stateStore }), actions({
    openIssues: () => [{ number: 1, title: 'Park me' }],
    runAgentOnIssue: async () => ({ completed: false, parked: true }),
    closeMilestone: () => assert.fail('a parked task keeps the phase open'),
  }));
  assert.equal(result.verdict, 'parked');
  assert.equal(phaseProcessSnapshot(stateStore.state).completed.includes('implementation'), false);
});
