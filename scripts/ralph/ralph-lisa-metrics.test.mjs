import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as metrics from './ralph-run-metrics.mjs';
import { readTaskSpend } from './ralph-gui-data.mjs';

function fixture(operation) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-lisa-metrics-'));
  const dependencies = { metricsPath: path.join(directory, 'issue-metrics.json'), now: () => 1000 };
  const store = { state: { runId: 'run-1', phaseIndex: 0 },
    issue: { number: 206, title: 'Repair item' } };
  const config = { branch: 'phase', milestone: 'One' };
  try { operation({ dependencies, store, config }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('repair acceptance has a correlated outcome after the proposed session', () => {
  fixture(({ dependencies, store, config }) => {
    metrics.appendIssueMetrics({ issue: 206, outcome: 'supervisor-proposed', reason: 'resume proposed' }, dependencies);
    const record = metrics.recordLisaRepairOutcome(config, store,
      { repairId: 'repair-1', verdict: 'human', reason: 'external permission required' }, dependencies);
    assert.equal(record.outcome, 'supervisor-human');
    assert.equal(record.recordKind, 'lisa-repair-outcome');
    assert.equal(record.issue, 206);
    assert.equal(record.runId, 'run-1');
    assert.equal(record.phaseIndex, 0);
    assert.equal(record.repairId, 'repair-1');
    assert.equal(record.reason, 'external permission required');
    assert.equal(record.wallMs, null);
    assert.equal(record.totals.inputTokens, null);
    assert.equal(record.totals.costUsd, null);
    const stored = JSON.parse(readFileSync(dependencies.metricsPath, 'utf8')).entries;
    assert.deepEqual(stored.map(entry => entry.outcome), ['supervisor-human', 'supervisor-proposed']);
    assert.doesNotMatch(metrics.formatIssueMetrics(record), /Стоимость|0s|0 сессий/u);
  });
});

test('one final repair outcome is idempotent but another repair has its own outcome', () => {
  fixture(({ dependencies, store, config }) => {
    const event = { repairId: 'repair-1', verdict: 'human', reason: 'required permission' };
    const first = metrics.recordLisaRepairOutcome(config, store, event, dependencies);
    const repeated = metrics.recordLisaRepairOutcome(config, store, { ...event, reason: 'outer catch' }, dependencies);
    assert.deepEqual(repeated, first);
    metrics.recordLisaRepairOutcome(config, store, { ...event, repairId: 'repair-2' }, dependencies);
    const stored = JSON.parse(readFileSync(dependencies.metricsPath, 'utf8')).entries;
    assert.equal(stored.length, 2);
  });
});

test('repair retries preserve their attempt identity and accepted is separate from human', () => {
  fixture(({ dependencies, store, config }) => {
    const event = { repairId: 'repair-1', verdict: 'retry', reason: 'validation failed' };
    metrics.recordLisaRepairOutcome(config, store, { ...event, eventId: 'attempt-1' }, dependencies);
    metrics.recordLisaRepairOutcome(config, store, { ...event, eventId: 'attempt-2' }, dependencies);
    metrics.recordLisaRepairOutcome(config, store,
      { repairId: 'repair-1', verdict: 'accepted', reason: 'validation passed' }, dependencies);
    const stored = JSON.parse(readFileSync(dependencies.metricsPath, 'utf8')).entries;
    assert.deepEqual(stored.map(entry => entry.outcome), ['supervisor-accepted', 'supervisor-retry', 'supervisor-retry']);
    assert.throws(() => metrics.recordLisaRepairOutcome(config, store,
      { ...event, verdict: 'paused' }, dependencies), /verdict/u);
  });
});

test('repair outcome does not close or replace an active session recorder', () => {
  fixture(({ dependencies, store, config }) => {
    const active = metrics.beginIssueMetrics({ issue: 206 }, { now: () => 0 });
    metrics.recordAgentTelemetry('supervisor', { outputTokens: 12 });
    metrics.recordLisaRepairOutcome(config, store,
      { repairId: 'repair-1', verdict: 'accepted', reason: 'checked' }, dependencies);
    assert.equal(metrics.currentIssueMetrics(), active);
    const session = metrics.finishIssueMetrics({ outcome: 'supervisor-proposed' }, dependencies);
    assert.equal(session.totals.outputTokens, 12);
    assert.equal(metrics.currentIssueMetrics(), null);
  });
});

test('a proposed verdict remains separate from the lifecycle acceptance outcome', () => {
  fixture(({ dependencies }) => {
    metrics.beginIssueMetrics({ issue: 206 }, { now: () => 0 });
    const session = metrics.finishIssueMetrics({ outcome: 'supervisor-proposed',
      proposalVerdict: 'human', reason: 'external permission proposed' }, dependencies);
    assert.equal(session.proposalVerdict, 'human');
    assert.equal(session.outcome, 'supervisor-proposed');
  });
});

test('a budget stop without a Lisa session is recorded for the current issue', () => {
  fixture(({ dependencies, store, config }) => {
    const event = { verdict: 'human', reason: 'repair budget exhausted' };
    metrics.recordLisaRepairOutcome(config, store, event, dependencies);
    metrics.recordLisaRepairOutcome(config, store, event, dependencies);
    const stored = JSON.parse(readFileSync(dependencies.metricsPath, 'utf8')).entries;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].repairId, null);
    assert.equal(stored[0].issue, 206);
    assert.equal(stored[0].reason, event.reason);
  });
});

test('an outcome for a saved repair retains its issue, phase and run after the next task starts', () => {
  fixture(({ dependencies, store, config }) => {
    store.state = { runId: 'run-next', phaseIndex: 1, lisaRepair: {
      repairId: 'repair-205', runId: 'run-original', phaseIndex: 0, issueNumber: 205,
    } };
    const event = { repairId: 'repair-205', verdict: 'human', reason: 'repair outcome' };
    const record = metrics.recordLisaRepairOutcome(config, store, event, dependencies);
    assert.equal(record.issue, 205);
    assert.equal(record.issueTitle, null);
    assert.equal(record.runId, 'run-original');
    assert.equal(record.phaseIndex, 0);
    assert.equal(record.milestone, null);
    assert.equal(record.branch, null);
    store.state.runId = 'run-later';
    store.state.phaseIndex = 2;
    const repeated = metrics.recordLisaRepairOutcome(config, store, event, dependencies);
    assert.deepEqual(repeated, record);
    assert.equal(JSON.parse(readFileSync(dependencies.metricsPath, 'utf8')).entries.length, 1);
  });
});

test('a budget outcome with explicit null repair ID belongs to the current task', () => {
  fixture(({ dependencies, store, config }) => {
    store.state = { runId: 'run-next', phaseIndex: 1, lisaRepair: {
      repairId: 'repair-205', runId: 'run-original', phaseIndex: 0, issueNumber: 205,
    } };
    const record = metrics.recordLisaRepairOutcome(config, store,
      { repairId: null, verdict: 'human', reason: 'repair budget exhausted' }, dependencies);
    assert.equal(record.issue, 206);
    assert.equal(record.issueTitle, 'Repair item');
    assert.equal(record.runId, 'run-next');
    assert.equal(record.phaseIndex, 1);
    assert.equal(record.repairId, null);
  });
});

test('repair outcomes remain visible without inventing duration or another task attempt', () => {
  fixture(({ dependencies, store, config }) => {
    metrics.recordLisaRepairOutcome(config, store,
      { repairId: 'repair-1', verdict: 'human', reason: 'external permission required' }, dependencies);
    const spend = readTaskSpend({ metricsPath: dependencies.metricsPath });
    const [run] = spend.tasks[0].runs;
    assert.equal(run.kind, 'supervisor');
    assert.equal(run.wallMs, null);
    assert.equal(run.repairId, 'repair-1');
    assert.equal(run.runId, 'run-1');
    assert.equal(run.phaseIndex, 0);
    assert.equal(spend.tasks[0].wallMs, null);
    assert.equal(spend.phases[0].wallMs, null);
    assert.equal(spend.totals.wallMs, null);
    assert.equal(spend.tasks[0].attempts, 0);
    assert.equal(spend.tasks[0].lastOutcome, 'supervisor-human');
    for (const outcome of ['supervisor-proposed', 'supervisor-accepted', 'supervisor-retry']) {
      assert.notEqual(metrics.describeOutcome(outcome), outcome);
    }
  });
});

test('proposal and acceptance events do not double actual Lisa sessions or telemetry', () => {
  fixture(({ dependencies, store, config }) => {
    for (const [outputTokens, wallMs] of [[12, 200], [24, 300]]) {
      let now = 1000;
      metrics.beginIssueMetrics({ issue: 206 }, { now: () => now });
      metrics.recordAgentTelemetry('supervisor', { outputTokens });
      now += wallMs;
      metrics.finishIssueMetrics({ outcome: 'supervisor-proposed', reason: 'proposal' }, dependencies);
      metrics.recordLisaRepairOutcome(config, store, { repairId: 'repair-1',
        verdict: 'retry', eventId: String(outputTokens), reason: 'another attempt' }, dependencies);
    }
    metrics.recordLisaRepairOutcome(config, store,
      { repairId: 'repair-1', verdict: 'accepted', reason: 'accepted' }, dependencies);
    metrics.recordLisaRepairOutcome(config, store,
      { repairId: 'repair-1', verdict: 'human', reason: 'external permission' }, dependencies);
    const spend = readTaskSpend({ metricsPath: dependencies.metricsPath });
    assert.equal(spend.totals.sessions, 2);
    assert.equal(spend.totals.attempts, 0);
    assert.equal(spend.tasks[0].tokens.answer, 36);
    assert.equal(spend.tasks[0].wallMs, 500);
    assert.equal(spend.phases[0].wallMs, 500);
    assert.equal(spend.totals.wallMs, 500);
    assert.equal(spend.tasks[0].lastOutcome, 'supervisor-human');
    assert.equal(spend.tasks[0].lastReason, 'external permission');
    const records = JSON.parse(readFileSync(dependencies.metricsPath, 'utf8')).entries;
    for (const record of records.filter(entry => entry.recordKind === 'lisa-repair-outcome')) {
      assert.equal(record.totals.inputTokens, null);
      assert.equal(record.totals.costUsd, null);
    }
  });
});
