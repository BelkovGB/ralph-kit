import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStateStore } from './ralph-state-store.mjs';
import { issueProcessSnapshot, phaseProcessSnapshot } from './ralph-process.mjs';
import { readLiveStatus, resetLiveStatus } from './ralph-live-status.mjs';
import { terminalSnapshot } from './ralph-terminal.mjs';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-process-time-'));
  const statePath = path.join(directory, 'state.json');
  const config = { branch: 'phase', baseBranch: 'main', milestone: 'One', phaseIndex: 0, phaseCount: 1 };
  let now = 1000;
  const options = { now: () => now };
  const store = createStateStore(config, '--run', statePath, options);
  store.beginIssue({ number: 42, title: 'Measured issue' }, 'base');
  resetLiveStatus();
  return { store, statePath, config, options, setNow(value) { now = value; },
    snapshot: () => issueProcessSnapshot(store.issue, { timing: readLiveStatus().processTiming, now }),
    close() { resetLiveStatus(); rmSync(directory, { recursive: true, force: true }); } };
}

test('phase metrics retain measured issue stages across queue refresh and restart', () => {
  const f = fixture();
  try {
    for (const [stage, start, end] of [
      ['implementation', 1000, 2000], ['validation', 2000, 4000],
      ['review', 4000, 7000], ['fixing', 7000, 11000],
    ]) {
      f.setNow(start);
      f.store.recordIssueProcess({ type: 'stage-start', stage });
      f.setNow(end);
      f.store.recordIssueProcess({ type: 'stage-complete', stage });
    }
    f.store.clearIssue();
    f.store.clearIssue();
    const resumed = createStateStore(f.config, '--run', f.statePath, f.options);
    resumed.recordPhaseProcess({ type: 'stage-start', stage: 'validation' });
    f.setNow(16000);
    resumed.recordPhaseProcess({ type: 'stage-complete', stage: 'validation' });
    resumed.recordPhaseProcess({ type: 'stage-start', stage: 'publishing' });
    assert.deepEqual(phaseProcessSnapshot(resumed.state, { timing: readLiveStatus().processTiming, now: 17000 }).stageMs,
      { implementation: 1000, validation: 7000, review: 3000, fixing: 4000, publishing: 1000 });
  } finally { f.close(); }
});

test('terminal snapshots advance the live stage while the worker has not sent another event', () => {
  const f = fixture();
  try {
    f.store.recordIssueProcess({ type: 'stage-start', stage: 'implementation' });
    const live = readLiveStatus();
    assert.equal(terminalSnapshot(f.store, null, 0, 1500, live).process.stageMs.implementation, 500);
    assert.equal(terminalSnapshot(f.store, null, 0, 2500, live).process.stageMs.implementation, 1500);
  } finally { f.close(); }
});

test('stage durations use measured intervals and a live timer, leaving absent stages unknown', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.snapshot().stageMs,
      { implementation: null, validation: null, review: null, fixing: null, publishing: null });
    f.store.recordIssueProcess({ type: 'stage-start', stage: 'implementation' });
    f.setNow(1600);
    assert.equal(f.snapshot().stageMs.implementation, 600);
    f.setNow(2000);
    f.store.recordIssueProcess({ type: 'stage-complete', stage: 'implementation' });
    assert.equal(readLiveStatus().processTiming, null);
    f.setNow(5000);
    assert.equal(f.snapshot().stageMs.implementation, 1000);
    f.store.recordIssueProcess({ type: 'stage-start', stage: 'validation' });
    f.setNow(6000);
    f.store.recordIssueProcess({ type: 'stage-fail', stage: 'validation' });
    f.setNow(9000);
    f.store.recordIssueProcess({ type: 'stage-start', stage: 'implementation' });
    f.setNow(11000);
    f.store.recordIssueProcess({ type: 'stage-complete', stage: 'implementation' });
    assert.deepEqual(f.snapshot().stageMs,
      { implementation: 1000, validation: 1000, review: null, fixing: 2000, publishing: null });
    assert.ok(f.snapshot().completed.includes('fixing'));
    assert.equal(f.snapshot().timingPartial, false);
  } finally { f.close(); }
});

test('technical review retries accumulate only running intervals in the same review circle', () => {
  const f = fixture();
  try {
    f.store.recordIssueProcess({ type: 'review-start' });
    f.setNow(1500);
    f.store.recordIssueProcess({ type: 'review-error' });
    f.setNow(5000);
    f.store.recordIssueProcess({ type: 'review-start' });
    f.setNow(7000);
    f.store.recordIssueProcess({ type: 'review-result', verdict: 'pass', findings: 0 });
    assert.equal(f.snapshot().stageMs.review, 2500);
    assert.equal(f.snapshot().reviewRound, 1);
    assert.equal(f.snapshot().stageMs.publishing, null, 'a verdict does not measure a later publishing stage');
  } finally { f.close(); }
});

test('restart preserves closed measurements and never counts offline time from an interrupted stage', () => {
  const f = fixture();
  try {
    f.store.recordIssueProcess({ type: 'stage-start', stage: 'implementation' });
    f.setNow(1200);
    f.store.recordIssueProcess({ type: 'stage-complete', stage: 'implementation' });
    f.setNow(1300);
    f.store.recordIssueProcess({ type: 'review-start' });
    const staleTiming = readLiveStatus().processTiming;
    f.setNow(100000);
    const resumed = createStateStore(f.config, '--run', f.statePath, f.options);
    const snapshot = () => issueProcessSnapshot(resumed.issue,
      { timing: readLiveStatus().processTiming, now: 100200 });
    assert.equal(snapshot().stageMs.implementation, 200);
    assert.equal(snapshot().stageMs.review, null);
    assert.equal(snapshot().timingPartial, true);
    assert.equal(issueProcessSnapshot(resumed.issue, { timing: staleTiming, now: 100200 }).stageMs.review, null);
    resumed.recordIssueProcess({ type: 'review-start' });
    f.setNow(100200);
    resumed.recordIssueProcess({ type: 'review-result', verdict: 'pass', findings: 0 });
    assert.equal(snapshot().stageMs.review, 200);
    assert.equal(snapshot().timingPartial, true);
  } finally { f.close(); }
});

test('timers match the run, phase, issue and stage before contributing elapsed time', () => {
  const f = fixture();
  try {
    f.store.recordIssueProcess({ type: 'review-start' });
    const timing = readLiveStatus().processTiming;
    for (const wrong of [ { ...timing, scope: 'phase' }, { ...timing, issueNumber: 43 },
      { ...timing, phaseIndex: 1 }, { ...timing, runId: 'another-run' }, { ...timing, stage: 'validation' } ]) {
      assert.equal(issueProcessSnapshot(f.store.issue, { timing: wrong, now: 1500 }).stageMs.review, null);
    }
    assert.equal(phaseProcessSnapshot(f.store.state, { timing, now: 1500 }).stageMs.review, null);
    assert.equal(issueProcessSnapshot(f.store.issue, { timing, now: 1500 }).stageMs.review, 500);
    f.store.recordPhaseProcess({ type: 'stage-start', stage: 'publishing' });
    const phaseTiming = readLiveStatus().processTiming;
    assert.equal(phaseProcessSnapshot(f.store.state, { timing: phaseTiming, now: 1500 }).stageMs.publishing, 500);
    assert.equal(issueProcessSnapshot(f.store.issue, { timing: phaseTiming, now: 1500 }).stageMs.review, null);
  } finally { f.close(); }
});

test('legacy process data has no invented zero durations', () => {
  const old = { version: 1, current: 'review', completed: [], reviews: [], partial: false };
  const snapshot = issueProcessSnapshot({ number: 42, phase: 'reviewing', process: old });
  assert.deepEqual(snapshot.stageMs,
    { implementation: null, validation: null, review: null, fixing: null, publishing: null });
  assert.equal(snapshot.timingPartial, true);
});
