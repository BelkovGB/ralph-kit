import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createIssueProcess, updateIssueProcess, issueProcessSnapshot, phaseProcessSnapshot } from './ralph-process.mjs';
import { createStateStore, setActiveStateStore } from './ralph-state-store.mjs';
import { runMilestoneReview, milestoneReviewMarker } from './ralph-milestone-review.mjs';
import { withFakeGh } from './ralph-test-support.mjs';

const project = (process) => issueProcessSnapshot({ phase: 'agent-running', process }, { reviewEnabled: true });
const apply = (process, event) => updateIssueProcess(process, event);

test('process records stages and review results without counting technical retries as rounds', () => {
  let process = createIssueProcess();
  process = apply(process, { type: 'stage-start', stage: 'implementation' });
  process = apply(process, { type: 'stage-complete', stage: 'implementation' });
  process = apply(process, { type: 'stage-start', stage: 'validation' });
  process = apply(process, { type: 'stage-complete', stage: 'validation' });
  process = apply(process, { type: 'stage-start', stage: 'publishing' });
  process = apply(process, { type: 'review-start', commit: 'first' });
  assert.equal(project(process).reviewRound, 1);
  process = apply(process, { type: 'review-error' });
  process = apply(process, { type: 'review-start', commit: 'first' });
  assert.equal(project(process).reviewRound, 1);
  process = apply(process, { type: 'review-result', verdict: 'fail', findings: 4 });
  assert.deepEqual(project(process).reviews, [{ round: 1, verdict: 'fail', findings: 4 }]);
  assert.equal(project(process).current, 'fixing');
  assert.equal(project(process).failed, 'review');
  process = apply(process, { type: 'stage-start', stage: 'implementation' });
  assert.equal(project(process).current, 'fixing');
  process = apply(process, { type: 'stage-complete', stage: 'implementation' });
  process = apply(process, { type: 'stage-start', stage: 'validation' });
  process = apply(process, { type: 'stage-complete', stage: 'validation' });
  process = apply(process, { type: 'review-start', commit: 'fixed' });
  process = apply(process, { type: 'review-result', verdict: 'pass', findings: 0 });
  assert.equal(project(process).reviewRound, 2);
  assert.deepEqual(project(process).reviews, [
    { round: 1, verdict: 'fail', findings: 4 }, { round: 2, verdict: 'pass', findings: 0 },
  ]);
  assert.ok(project(process).completed.includes('review'));
  process = apply(process, { type: 'stage-start', stage: 'publishing' });
  assert.equal(project(process).current, 'publishing');
  process = apply(process, { type: 'stage-complete', stage: 'done' });
  assert.equal(project(process).current, 'done');
  assert.equal(project(process).partial, false);
});

test('failed validation shows a return to fixes while preserving a real review history', () => {
  let process = createIssueProcess();
  process = apply(process, { type: 'stage-complete', stage: 'implementation' });
  process = apply(process, { type: 'stage-fail', stage: 'validation' });
  assert.equal(project(process).current, 'fixing');
  assert.equal(project(process).failed, 'validation');
  assert.equal(project(process).reviewRound, null);
  assert.deepEqual(project(process).reviews, []);
  process = apply(process, { type: 'stage-start', stage: 'validation' });
  assert.equal(project(process).current, 'validation');
  assert.equal(project(process).failed, null);
  assert.deepEqual(project(process).completed, ['implementation']);
});

test('legacy state and unknown counts remain explicitly incomplete', () => {
  const legacy = issueProcessSnapshot({ phase: 'reviewing', reviewFixAttempts: 4 }, { reviewEnabled: true });
  assert.equal(legacy.current, 'review');
  assert.equal(legacy.reviewRound, null);
  assert.deepEqual(legacy.reviews, []);
  assert.deepEqual(legacy.completed, []);
  assert.equal(legacy.partial, true);
  let process = updateIssueProcess(null, { type: 'review-start', commit: 'legacy' });
  process = updateIssueProcess(process, { type: 'review-result', verdict: 'fail' });
  assert.equal(project(process).partial, true);
  assert.equal(project(process).reviews[0].findings, null);
  assert.equal(project(process).reviews[0].round, null);
  assert.equal(issueProcessSnapshot({ phase: 'pushed' }, { reviewEnabled: false }).reviewEnabled, false);
  assert.equal(issueProcessSnapshot(null), null);
});

test('process survives restart and beginIssue without resetting recorded review circles', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-process-'));
  const statePath = path.join(directory, 'state.json');
  const config = { branch: 'feature', baseBranch: 'main', milestone: 'Phase' };
  const issue = { number: 42, title: 'Observe the process' };
  try {
    const first = createStateStore(config, '--run', statePath);
    first.beginIssue(issue, 'base');
    first.recordIssueProcess({ type: 'review-start', commit: 'first' });
    first.recordIssueProcess({ type: 'review-result', verdict: 'fail', findings: 3 });
    const resumed = createStateStore(config, '--run', statePath);
    resumed.beginIssue(issue, 'base');
    assert.equal(project(resumed.issue.process).reviewRound, 1);
    assert.deepEqual(project(resumed.issue.process).reviews, [{ round: 1, verdict: 'fail', findings: 3 }]);
    assert.equal(project(resumed.issue.process).current, 'fixing');
    const legacyState = structuredClone(resumed.state);
    delete legacyState.issue.process;
    writeFileSync(statePath, JSON.stringify(legacyState));
    const legacy = createStateStore(config, '--run', statePath);
    legacy.beginIssue(issue, 'base');
    legacy.recordIssueProcess({ type: 'stage-start', stage: 'validation' });
    assert.equal(project(legacy.issue.process).partial, true);
    legacy.clearIssue();
    legacy.beginIssue({ number: 43, title: 'Next issue' }, 'base');
    assert.deepEqual(project(legacy.issue.process).reviews, []);
    assert.equal(project(legacy.issue.process).partial, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('phase review circles persist independently of issue changes and reset for a new phase', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-phase-process-'));
  const statePath = path.join(directory, 'state.json');
  const config = { branch: 'phase-one', baseBranch: 'main', milestone: 'One', phaseIndex: 0, phaseCount: 2,
    phasePlanId: 'plan' };
  try {
    const store = createStateStore(config, '--run', statePath);
    store.recordPhaseProcess({ type: 'review-start' });
    store.recordPhaseProcess({ type: 'review-result', verdict: 'fail', findings: 2 });
    store.beginIssue({ number: 42, title: 'Review followup' }, 'base');
    store.clearIssue();
    const resumed = createStateStore(config, '--run', statePath);
    const snapshot = phaseProcessSnapshot(resumed.state, { reviewEnabled: true });
    assert.equal(snapshot.scope, 'phase');
    assert.equal(snapshot.reviewRound, 1);
    assert.deepEqual(snapshot.reviews, [{ round: 1, verdict: 'fail', findings: 2 }]);
    resumed.advancePhase({ ...config, branch: 'phase-two', milestone: 'Two', phaseIndex: 1 });
    assert.equal(phaseProcessSnapshot(resumed.state).reviewRound, null);
    assert.deepEqual(phaseProcessSnapshot(resumed.state).reviews, []);
    assert.equal(phaseProcessSnapshot(resumed.state).partial, false);
    assert.equal(phaseProcessSnapshot({}).partial, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('worker process persists review result before IPC makes it visible to the terminal snapshot', async () => {
  const { terminalSnapshot } = await import('./ralph-terminal.mjs');
  const { publishLiveStatus, readLiveStatus, resetLiveStatus } = await import('./ralph-live-status.mjs');
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-process-ipc-'));
  const statePath = path.join(directory, 'state.json');
  const childPath = path.join(directory, 'writer.mjs');
  const storeModule = pathToFileURL(path.resolve('scripts/ralph/ralph-state-store.mjs')).href;
  const liveModule = pathToFileURL(path.resolve('scripts/ralph/ralph-live-status.mjs')).href;
  const config = { branch: 'phase', baseBranch: 'main', milestone: 'One', reviewEnabled: true };
  const parentStore = createStateStore(config, '--run', statePath);
  writeFileSync(childPath, `
    import { createStateStore } from ${JSON.stringify(storeModule)};
    import { subscribeLiveStatus } from ${JSON.stringify(liveModule)};
    subscribeLiveStatus(snapshot => process.send({ type: 'live', snapshot }));
    const store = createStateStore(${JSON.stringify(config)}, '--run', ${JSON.stringify(statePath)});
    store.beginIssue({ number: 42, title: 'Child issue' }, 'base');
    store.recordIssueProcess({ type: 'review-start' });
    store.recordIssueProcess({ type: 'review-result', verdict: 'fail', findings: 3 });
    process.disconnect();
  `);
  let child;
  try {
    resetLiveStatus();
    child = fork(childPath, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    let messages = 0;
    child.on('message', message => {
      if (message.type === 'live') {
        messages += 1;
        publishLiveStatus({ type: 'worker-snapshot', snapshot: message.snapshot });
      }
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, stderr);
    assert.equal(messages, 2);
    assert.equal(parentStore.issue, null, 'the parent store intentionally remains stale');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const snapshot = terminalSnapshot({ state, issue: state.issue, phaseIndex: 0, phaseCount: 1 },
      null, Date.now(), Date.now(), { ...readLiveStatus(), phaseConfig: config });
    assert.equal(snapshot.process.current, 'fixing');
    assert.deepEqual(snapshot.process.reviews, [{ round: 1, verdict: 'fail', findings: 3 }]);
  } finally {
    child?.kill();
    resetLiveStatus();
    rmSync(directory, { recursive: true, force: true });
  }
});


test('a new implementation invalidates previous code checks while retaining accepted review history', () => {
  let process = createIssueProcess();
  for (const stage of ['implementation', 'validation', 'review', 'publishing', 'done']) {
    process = updateIssueProcess(process, { type: 'stage-complete', stage });
  }
  process = updateIssueProcess(process, { type: 'stage-start', stage: 'implementation' });
  assert.deepEqual(project(process).completed, []);
  process = updateIssueProcess(process, { type: 'stage-complete', stage: 'implementation' });
  process = updateIssueProcess(process, { type: 'stage-complete', stage: 'validation' });
  process = updateIssueProcess(process, { type: 'stage-complete', stage: 'review' });
  process = updateIssueProcess(process, { type: 'stage-start', stage: 'validation' });
  assert.deepEqual(project(process).completed, ['implementation']);
});

test('disabled and cached milestone reviews do not invent a new review circle', async () => {
  const observations = [];
  const config = { baseBranch: 'main', milestoneReview: { enabled: true, model: 'test', effort: 'high' } };
  const milestone = { number: 1, title: 'One', description: '' };
  const pr = { number: 10, headRefOid: 'a'.repeat(40) };
  setActiveStateStore({ recordPhaseProcess: event => observations.push(event) });
  try {
    await runMilestoneReview({ ...config, milestoneReview: { ...config.milestoneReview, enabled: false } },
      'owner/repo', milestone, pr);
    const body = milestoneReviewMarker(config, milestone, pr) +
      '\n**Verdict:** **PASS**\n### Findings\nNo actionable findings.\n' +
      'The pull request remains draft so a human can make the final merge decision.';
    await withFakeGh(`process.stdout.write(${JSON.stringify(JSON.stringify([{ body }]))});`, async () => {
      const review = await runMilestoneReview(config, 'owner/repo', milestone, pr);
      assert.equal(review.verdict, 'pass');
    });
    assert.deepEqual(observations, []);
  } finally { setActiveStateStore(null); }
});


for (const source of ['review', 'validation']) {
  test(`a development retry retains the ${source} correction after a technical failure`, () => {
    let process = createIssueProcess();
    if (source === 'review') {
      process = updateIssueProcess(process, { type: 'review-start' });
      process = updateIssueProcess(process, { type: 'review-result', verdict: 'fail', findings: 2 });
    } else process = updateIssueProcess(process, { type: 'stage-fail', stage: 'validation' });
    process = updateIssueProcess(process, { type: 'stage-start', stage: 'implementation' });
    process = updateIssueProcess(process, { type: 'stage-error', stage: 'implementation' });
    process = updateIssueProcess(JSON.parse(JSON.stringify(process)), { type: 'stage-start', stage: 'implementation' });
    assert.equal(project(process).current, 'fixing');
    assert.equal(project(process).correctionSource, source);
    assert.equal(project(process).failed, null);
  });
}

test('successful checks resolve validation corrections but preserve outstanding review corrections', () => {
  let validation = updateIssueProcess(createIssueProcess(), { type: 'stage-fail', stage: 'validation' });
  validation = updateIssueProcess(validation, { type: 'stage-complete', stage: 'validation' });
  assert.equal(project(validation).correctionSource, null);
  let review = updateIssueProcess(createIssueProcess(), { type: 'review-start' });
  review = updateIssueProcess(review, { type: 'review-result', verdict: 'fail', findings: 2 });
  review = updateIssueProcess(review, { type: 'stage-fail', stage: 'validation' });
  review = updateIssueProcess(review, { type: 'stage-complete', stage: 'validation' });
  assert.equal(project(review).correctionSource, 'review');
  review = updateIssueProcess(review, { type: 'review-start' });
  review = updateIssueProcess(review, { type: 'review-result', verdict: 'pass', findings: 0 });
  assert.equal(project(review).correctionSource, null);
  const done = updateIssueProcess(updateIssueProcess(createIssueProcess(),
    { type: 'stage-fail', stage: 'validation' }), { type: 'stage-complete', stage: 'done' });
  assert.equal(project(done).correctionSource, null);
  assert.equal(project(done).failed, null);
});


for (const stage of ['implementation', 'validation', 'publishing']) {
  test(`a technical ${stage} error clears on retry or successful completion of that stage`, () => {
    let process = updateIssueProcess(createIssueProcess(), { type: 'stage-error', stage });
    assert.equal(project(process).errorStage, stage);
    const resumed = updateIssueProcess(process, { type: 'stage-start', stage });
    assert.equal(project(resumed).errorStage, null);
    process = updateIssueProcess(process, { type: 'stage-complete', stage });
    assert.equal(project(process).errorStage, null);
  });
}

test('technical review error is distinct from an accepted FAIL verdict and retains correction context', () => {
  let process = updateIssueProcess(createIssueProcess(), { type: 'review-start' });
  process = updateIssueProcess(process, { type: 'review-error' });
  assert.equal(project(process).errorStage, 'review');
  process = updateIssueProcess(process, { type: 'review-start' });
  assert.equal(project(process).errorStage, null);
  process = updateIssueProcess(process, { type: 'review-error' });
  process = updateIssueProcess(process, { type: 'review-result', verdict: 'fail', findings: 2 });
  assert.equal(project(process).errorStage, null);
  assert.equal(project(process).failed, 'review');
  assert.equal(project(process).correctionSource, 'review');
  process = updateIssueProcess(process, { type: 'stage-error', stage: 'implementation' });
  assert.equal(project(process).errorStage, 'implementation');
  assert.equal(project(process).correctionSource, 'review');
});

test('projection exposes raw operation while legacy FAIL never invents a technical error', () => {
  const legacy = { version: 1, current: 'fixing', completed: [], failed: 'review', reviews: [], partial: true };
  const snapshot = issueProcessSnapshot({ phase: 'pushed', process: legacy });
  assert.equal(snapshot.operation, 'pushed');
  assert.equal(snapshot.errorStage, null);
  assert.equal(phaseProcessSnapshot({ phaseProcess: legacy }, { operation: 'milestone-review' }).operation,
    'milestone-review');
  assert.equal(phaseProcessSnapshot({ phaseProcess: legacy }).operation, null);
});


test('validation retains the completed correction session as confirmed upstream work', () => {
  let process = updateIssueProcess(createIssueProcess(), { type: 'review-start' });
  process = updateIssueProcess(process, { type: 'review-result', verdict: 'fail', findings: 2 });
  process = updateIssueProcess(process, { type: 'stage-start', stage: 'implementation' });
  process = updateIssueProcess(process, { type: 'stage-complete', stage: 'implementation' });
  assert.ok(project(process).completed.includes('fixing'));
  process = updateIssueProcess(process, { type: 'stage-start', stage: 'validation' });
  assert.ok(project(process).completed.includes('implementation'));
  assert.ok(project(process).completed.includes('fixing'));
  assert.equal(project(process).completed.includes('review'), false);
});


test('a new review FAIL clears completion of fixes from the previous review circle', () => {
  let process = updateIssueProcess(createIssueProcess(), { type: 'review-start' });
  process = updateIssueProcess(process, { type: 'review-result', verdict: 'fail', findings: 2 });
  process = updateIssueProcess(process, { type: 'stage-start', stage: 'implementation' });
  process = updateIssueProcess(process, { type: 'stage-complete', stage: 'implementation' });
  process = updateIssueProcess(process, { type: 'stage-start', stage: 'validation' });
  process = updateIssueProcess(process, { type: 'stage-complete', stage: 'validation' });
  assert.ok(project(process).completed.includes('fixing'));
  process = updateIssueProcess(process, { type: 'review-start' });
  process = updateIssueProcess(process, { type: 'review-result', verdict: 'fail', findings: 1 });
  assert.equal(project(process).reviewRound, 2);
  assert.equal(project(process).completed.includes('fixing'), false);
});

test('a new validation FAIL clears completion of fixes that need another correction session', () => {
  let process = updateIssueProcess(createIssueProcess(), { type: 'stage-fail', stage: 'validation' });
  process = updateIssueProcess(process, { type: 'stage-start', stage: 'implementation' });
  process = updateIssueProcess(process, { type: 'stage-complete', stage: 'implementation' });
  process = updateIssueProcess(process, { type: 'stage-start', stage: 'validation' });
  assert.ok(project(process).completed.includes('fixing'));
  process = updateIssueProcess(process, { type: 'stage-fail', stage: 'validation' });
  assert.equal(project(process).completed.includes('fixing'), false);
});
