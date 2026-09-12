import assert from 'node:assert/strict';
import test from 'node:test';
import { runContinuousLoop } from './ralph-loop.mjs';
import { readLiveStatus, resetLiveStatus } from './ralph-live-status.mjs';
import { actions, context } from './ralph-test-support.mjs';

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
