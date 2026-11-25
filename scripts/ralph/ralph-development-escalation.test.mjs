import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStateStore } from './ralph-state-store.mjs';
import { developmentFeedback, developmentRetryDecision, developmentSessionConfig } from './ralph-development-escalation.mjs';

const config = { developmentEffort: 'medium', developmentEscalation: { effort: 'high' },
  agentCli: 'codex', developmentModel: 'fixture-model', phasePlanId: 'plan',
  branch: 'feature', baseBranch: 'main', milestone: 'Tests', maxIterations: 5, maxTestFixAttempts: 3 };
const testFailure = { code: 'RALPH_VALIDATION_FAILED', failedTests: ['saves draft'] };
const blockers = { kind: 'validation', keys: testFailure.failedTests };

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-escalation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reopen = () => createStateStore(config, '--run', path.join(directory, 'state.json'));
  const store = reopen();
  store.beginIssue({ number: 17 }, 'base');
  store.updateIssue({ phase: 'working-tree', validationFailureFingerprint: 'tree', lastFailureSummary: testFailure });
  return { store, reopen };
}

test('only an addressed repeated named blocker can use a remaining ordinary fix attempt', t => {
  const { store } = fixture(t);
  assert.deepEqual(developmentFeedback(store.issue), blockers);
  assert.deepEqual(developmentRetryDecision(config, store, blockers, true), {});
  store.updateIssue({ addressedDevelopmentFeedback: blockers });
  for (const [settings, current, hasBudget] of [
    [{ ...config, developmentEscalation: undefined }, blockers, true], [config, blockers, false],
    [config, { kind: 'validation', keys: ['other'] }, true], [config, { kind: 'review', keys: blockers.keys }, true],
  ]) assert.deepEqual(developmentRetryDecision(settings, store, current, hasBudget), {});
  const { pending } = developmentRetryDecision(config, store, blockers, true);
  assert.deepEqual(pending.keys, ['saves draft']);
  store.updateIssue({ pendingDevelopmentEscalation: pending });
  assert.deepEqual(developmentSessionConfig(config, store, blockers), { ...config, developmentEffort: 'high' });
  assert.equal(developmentSessionConfig(config, store, blockers), config);
  assert.equal(developmentRetryDecision(config, store, blockers, true).stop, true);
  assert.deepEqual(developmentRetryDecision(config, store, { kind: 'validation', keys: ['other'] }, true), {});
});

test('one reservation survives process restarts, clear and reopen, and the same issue moving phases', t => {
  const { store, reopen } = fixture(t);
  store.updateIssue({ addressedDevelopmentFeedback: blockers });
  const { pending } = developmentRetryDecision(config, store, blockers, true);
  store.updateIssue({ pendingDevelopmentEscalation: pending });
  const beforeStart = reopen();
  assert.equal(developmentSessionConfig(config, beforeStart, blockers).developmentEffort, 'high');
  const afterReservation = reopen();
  assert.equal(developmentSessionConfig(config, afterReservation, blockers), config);
  afterReservation.clearIssue();
  afterReservation.beginIssue({ number: 17 }, 'new base');
  afterReservation.updateIssue({ addressedDevelopmentFeedback: blockers });
  assert.equal(developmentRetryDecision(config, afterReservation, blockers, true).stop, true);
  afterReservation.clearIssue();
  afterReservation.advancePhase({ ...config, phaseIndex: 1 });
  afterReservation.beginIssue({ number: 17 }, 'new phase');
  afterReservation.updateIssue({ addressedDevelopmentFeedback: blockers });
  assert.equal(developmentRetryDecision(config, afterReservation, blockers, true).stop, true);
  afterReservation.clearIssue();
  afterReservation.beginIssue({ number: 18 }, 'another issue');
  afterReservation.updateIssue({ addressedDevelopmentFeedback: blockers });
  assert.ok(developmentRetryDecision(config, afterReservation, blockers, true).pending);
});

test('a queued boost cannot start after the operator lowers a limit or supersedes the failure', t => {
  const { store } = fixture(t);
  store.updateIssue({ addressedDevelopmentFeedback: blockers });
  const { pending } = developmentRetryDecision(config, store, blockers, true);
  for (const [settings, feedback] of [
    [config, { kind: 'validation', keys: ['different test'] }],
    [{ ...config, developmentEscalation: undefined }, blockers],
    [{ ...config, maxTestFixAttempts: 2 }, blockers],
  ]) {
    store.updateIssue({ pendingDevelopmentEscalation: pending, validationFixAttempts: 2 });
    assert.equal(developmentSessionConfig(settings, store, feedback), settings);
    assert.equal(store.issue.pendingDevelopmentEscalation, null);
    assert.equal(store.state.developmentEscalations, undefined);
  }
  store.reserveIteration();
  assert.deepEqual(developmentRetryDecision({ ...config, maxIterations: 1 }, store, blockers, true), {});
});

test('one boosted attempt covers every named blocker that triggered it', t => {
  const { store } = fixture(t);
  const repeated = { kind: 'validation', keys: ['first', 'second'] };
  store.updateIssue({ addressedDevelopmentFeedback: repeated });
  const { pending } = developmentRetryDecision(config, store, repeated, true);
  store.updateIssue({ pendingDevelopmentEscalation: pending });
  assert.equal(developmentSessionConfig(config, store, repeated).developmentEffort, 'high');
  assert.equal(developmentRetryDecision(config, store, { kind: 'validation', keys: ['second'] }, true).stop, true);
});

test('a moved Playwright failure keeps its project, normalized file and full title identity', t => {
  const { store } = fixture(t);
  const previous = '[desktop] › ui\\dialog.spec.ts:20:4 › modal › saves draft';
  const moved = '[desktop] › ui/dialog.spec.ts:38:10 › modal › saves draft';
  const tests = name => ({ kind: 'validation', keys: [name] });
  store.updateIssue({ addressedDevelopmentFeedback: tests(previous) });
  for (const other of [moved.replace('desktop', 'mobile'), moved.replace('dialog', 'other'),
    moved.replace('modal › ', 'popover › '), moved.replace('saves draft', 'saves as new')]) {
    assert.deepEqual(developmentRetryDecision(config, store, tests(other), true), {});
  }
  const { pending } = developmentRetryDecision(config, store, tests(moved), true);
  assert.deepEqual(pending.keys, [moved]);
  store.updateIssue({ pendingDevelopmentEscalation: pending });
  assert.equal(developmentSessionConfig(config, store, tests(moved)).developmentEffort, 'high');
  assert.equal(developmentRetryDecision(config, store, tests(moved.replace(':38:', ':55:')), true).stop, true);
});
