import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeRecovery } from './ralph-recovery.mjs';
import * as supervisor from './ralph-supervisor.mjs';

function fixture(t, phase = 'review-failed') {
  const root = mkdtempSync(path.join(tmpdir(), 'lisa-resume-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return { stdout: result.stdout.trim(), stderr: result.stderr, status: 0 };
  };
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.name', 'Synthetic test']);
  run('git', ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(path.join(root, 'code.txt'), 'base');
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'base']);
  const head = run('git', ['rev-parse', 'HEAD']).stdout;
  const issue = { number: 12, phase, startingCommit: head, commit: head,
    recoveryHead: head, reviewedCommit: head, pushedHead: head, expectedTree: 'old',
    reviewFixAttempts: 2, validationFixAttempts: 1, foreignPaths: ['unrelated.txt'],
    reviewFindings: 'A regression scenario is missing' };
  const store = { issue, updateIssue(patch) { Object.assign(issue, patch); } };
  return { root, run, head, issue, store, config: { branch: 'main' },
    before: { branch: 'main', head },
    edit() { writeFileSync(path.join(root, 'regression.txt'), 'synthetic regression'); } };
}

for (const phase of ['review-failed', 'committed', 'pushed', 'reviewing', 'closing', 'working-tree']) {
  test(`Lisa's uncommitted fix from ${phase} passes the next recovery`, (t) => {
    const f = fixture(t, phase);
    f.edit();
    supervisor.prepareLisaResume(f.config, f.store, f.before, { run: f.run });
    assert.equal(f.issue.phase, 'working-tree');
    assert.equal(analyzeRecovery(f.config, f.issue, { run: f.run }).kind, 'ready');
    for (const field of ['commit', 'recoveryHead', 'reviewedCommit', 'pushedHead', 'expectedTree']) {
      assert.equal(f.issue[field], null);
    }
    assert.equal(f.issue.startingCommit, f.head);
    assert.deepEqual(f.issue.foreignPaths, ['unrelated.txt']);
    assert.equal(f.issue.reviewFindings, 'A regression scenario is missing');
    assert.equal(f.issue.validationFixAttempts, 1);
    assert.match(f.run('git', ['status', '--porcelain']).stdout, /regression.txt/);
  });
}

test('clean committed recovery keeps validated commit evidence', (t) => {
  const f = fixture(t, 'committed');
  const before = structuredClone(f.issue);
  supervisor.prepareLisaResume(f.config, f.store, f.before, { run: f.run });
  assert.deepEqual(f.issue, before);
});

test('iteration-limit after review failure resumes through real recovery with Lisa edits', async (t) => {
  const f = fixture(t);
  let calls = 0;
  let reserve = 0;
  Object.defineProperties(f.store, {
    supervisorCalls: { get: () => calls },
    supervisorExtraIterations: { get: () => reserve },
  });
  Object.assign(f.store, {
    reserveSupervisorCall() { return ++calls; },
    finishSupervisorCall() {},
    grantSupervisorIteration() { reserve += 1; },
  });
  const config = { ...f.config, supervisor: { enabled: true, maxInterventions: 3, maxAdditionalIterations: 2 } };
  let attempts = 0;
  const result = await supervisor.runWithSupervisor(config, f.store, async () => {
    if (attempts++ === 0) throw Object.assign(new Error('budget'), { code: 'RALPH_ITERATION_LIMIT' });
    assert.equal(analyzeRecovery(config, f.issue, { run: f.run }).kind, 'ready');
    assert.equal(f.issue.phase, 'working-tree');
    return { verdict: 'pass' };
  }, async () => {
    f.edit();
    supervisor.prepareLisaResume(config, f.store, f.before, { run: f.run });
    return { verdict: 'resume', reason: 'regression added' };
  });
  assert.equal(result.verdict, 'pass');
  assert.equal(attempts, 2);
  assert.equal(calls, 1);
  assert.equal(reserve, 1);
});

test('dirty committed state does not launder a mismatched recorded commit', (t) => {
  const f = fixture(t, 'committed');
  f.issue.recoveryHead = 'invalid-head';
  f.edit();
  const before = structuredClone(f.issue);
  assert.throws(() => supervisor.prepareLisaResume(f.config, f.store, f.before, { run: f.run }), /HEAD/);
  assert.deepEqual(f.issue, before);
});

for (const mutation of ['head', 'branch', 'validation-mutated', 'staging', 'no-issue']) {
  test(`resume refuses ${mutation} without changing saved state`, (t) => {
    const f = fixture(t);
    if (mutation === 'head') f.run('git', ['commit', '--allow-empty', '-m', 'unexpected']);
    if (mutation === 'branch') f.run('git', ['switch', '-c', 'unexpected']);
    if (['validation-mutated', 'staging'].includes(mutation)) f.issue.phase = mutation;
    if (mutation === 'no-issue') f.store.issue = null;
    f.edit();
    const before = structuredClone(f.issue);
    assert.throws(() => supervisor.prepareLisaResume(f.config, f.store, f.before, { run: f.run }));
    assert.deepEqual(f.issue, before);
  });
}
