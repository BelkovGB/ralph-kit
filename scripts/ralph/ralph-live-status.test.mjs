import test from 'node:test';
import assert from 'node:assert/strict';
import { publishLiveStatus, readLiveStatus, resetLiveStatus, subscribeLiveStatus } from './ralph-live-status.mjs';
import { retryTransientOperation } from './ralph-runtime.mjs';
import { createSandboxRoot, runAgentSession, runReviewWithRetries } from './ralph-agent-session.mjs';
import { run, runtimeSettings } from './ralph-process-runner.mjs';

test('session observations reset counts and retain actual final counters', () => {
  resetLiveStatus();
  publishLiveStatus({ type: 'session-start', startedMs: 100, maxTurns: 5 });
  assert.equal(readLiveStatus().session.lastEventMs, null);
  publishLiveStatus({ type: 'session-progress', turns: 2, toolResults: 4, lastEventMs: 150 });
  publishLiveStatus({ type: 'session-end', endedMs: 200 });
  assert.deepEqual(readLiveStatus().session, { startedMs: 100, maxTurns: 5, turns: 2, toolResults: 4, lastEventMs: 150, active: false, endedMs: 200 });
  publishLiveStatus({ type: 'session-start', startedMs: 300, maxTurns: 8 });
  assert.equal(readLiveStatus().session.turns, 0);
  const snapshot = readLiveStatus();
  snapshot.session.turns = 99;
  assert.equal(readLiveStatus().session.turns, 0);
});

test('phase transition clears phase-bound observations', () => {
  resetLiveStatus();
  publishLiveStatus({ type: 'session-start', startedMs: 100, maxTurns: 5 });
  publishLiveStatus({ type: 'review-attempt', attempt: 2, attempts: 3 });
  publishLiveStatus({ type: 'phase-config', phaseConfig: { maxIterations: 8 } });
  assert.equal(readLiveStatus().session, null);
  assert.equal(readLiveStatus().review, null);
});

test('network observations count the first attempt and settle on success or failure', () => {
  resetLiveStatus();
  const observed = [];
  const unsubscribe = subscribeLiveStatus(() => observed.push(readLiveStatus().network));
  assert.equal(retryTransientOperation((attempt) => {
    assert.equal(readLiveStatus().network.attempt, attempt);
    if (attempt === 1) throw new Error('temporary');
    return 'ok';
  }, { attempts: 3, label: 'gh', wait() {}, isTransient: () => true }), 'ok');
  unsubscribe();
  assert.deepEqual(observed.map((state) => [state.attempt, state.active]), [[1, true], [2, true], [2, false]]);
  assert.throws(() => retryTransientOperation(() => { throw new Error('fatal'); }, { attempts: 3, isTransient: () => false }), /fatal/);
  assert.equal(readLiveStatus().network.active, false);
  assert.equal(readLiveStatus().network.attempt, 1);
});

test('running agent publishes unique steps, tool outputs, activity and effective limits', async () => {
  resetLiveStatus();
  const events = [{ stepId: 'a', toolResults: 1 }, { stepId: 'a' }, { stepId: 'b', toolResults: 2 }];
  await runAgentSession({
    binary: 'node', label: 'probe',
    createSandboxedEnvironment: (env) => createSandboxRoot(env, 'ralph-live-test-'),
    readEvent: JSON.parse,
  }, ['-e', `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`], {
    label: 'probe', maxTurns: 4, timeoutMs: 10_000, firstEventTimeoutMs: 5_000, idleTimeoutMs: 3_000,
    input: '',
  });
  const { session } = readLiveStatus();
  assert.equal(session.turns, 2);
  assert.equal(session.toolResults, 3);
  assert.equal(session.maxTurns, 4);
  assert.equal(session.timeoutMs, 10_000);
  assert.equal(session.firstEventTimeoutMs, 5_000);
  assert.equal(session.idleTimeoutMs, 3_000);
  assert.ok(session.lastEventMs >= session.startedMs);
  assert.ok(session.endedMs >= session.lastEventMs);
  assert.equal(session.active, false);
});

test('review retry observation includes the first launch and ends after success', async () => {
  resetLiveStatus();
  let calls = 0;
  let startedMs;
  await runReviewWithRetries({ runtime: { reviewRetryAttempts: 2, networkRetryBaseDelayMs: 0 } }, async () => {
    calls += 1;
    assert.equal(readLiveStatus().review.attempt, calls);
    assert.equal(typeof readLiveStatus().review.startedMs, 'number');
    startedMs ??= readLiveStatus().review.startedMs;
    assert.equal(readLiveStatus().review.startedMs, startedMs);
    if (calls === 1) throw new Error('temporary');
  }, 'review');
  assert.deepEqual(readLiveStatus().review, { label: 'review', attempt: 2, attempts: 2, startedMs, active: false });
});

test('command observation exposes its effective timeout and settles on all exits', () => {
  resetLiveStatus();
  const observations = [];
  const unsubscribe = subscribeLiveStatus((state) => observations.push(state.operation));
  try {
    run('node', ['-e', 'process.exit(0)'], { timeoutMs: 7_000 });
    assert.equal(observations[0].active, true);
    assert.equal(observations[0].timeoutMs, 7_000);
    assert.equal(observations[0].label, 'node -e');
    assert.equal(readLiveStatus().operation.active, false);
    assert.ok(readLiveStatus().operation.endedMs >= readLiveStatus().operation.startedMs);
    assert.throws(() => run('node', ['-e', 'process.exit(1)']), /кодом 1/);
    assert.equal(readLiveStatus().operation.timeoutMs, runtimeSettings().commandTimeoutMs);
    assert.equal(readLiveStatus().operation.active, false);
  } finally {
    unsubscribe();
  }
});
