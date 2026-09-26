import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeRecovery, applyRecoveryPlan, committedValidationFailurePatch, prepareRecovery } from './ralph-recovery.mjs';
import { createStateStore } from './ralph-state-store.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (_command, args, options = {}) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0 && !options.allowFailure) throw new Error(result.stderr);
    return { ...result, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
  const git = (...args) => run('git', args).stdout;
  git('init', '-q', '-b', 'feature');
  git('config', 'user.name', 'Recovery Test');
  git('config', 'user.email', 'recovery@example.test');
  const commit = (file, body, message) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
    git('add', file);
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const base = commit('app.txt', 'base', 'base');
  const config = { branch: 'feature', baseBranch: 'main', milestone: 'Recovery' };
  const statePath = path.join(root, '.git', 'recovery-state.json');
  const store = createStateStore(config, '--run', statePath);
  store.beginIssue({ number: 325, title: 'Repair', body: 'Frozen contract' }, base);
  store.updateIssue({ phase: 'working-tree', validationFixAttempts: 2, reviewFindings: 'Previous finding' });
  const manual = commit('app.txt', 'fixed', 'fix: repair\n\nRalph-Issue: #325');
  const analyze = (options = {}) => analyzeRecovery(config, store.issue, { run, ...options });
  return { root, run, git, commit, base, manual, config, store, statePath, analyze };
}

test('failed committed validation accepts a fix at the same HEAD without reusing old review', (t) => {
  const f = fixture(t);
  f.store.updateIssue({ phase: 'committed', commit: f.manual, recoveryHead: f.manual,
    pushedHead: f.manual, reviewedCommit: f.manual, reviewFixAttempts: 2 });
  f.store.updateIssue(committedValidationFailurePatch(f.store.issue, { code: 'RALPH_VALIDATION_FAILED' }));
  writeFileSync(path.join(f.root, 'app.txt'), 'Lisa fix awaiting validation');
  assert.equal(f.analyze().kind, 'ready');
  assert.equal(f.store.issue.startingCommit, f.manual);
  assert.equal(f.store.issue.phase, 'working-tree');
  assert.equal(f.store.issue.validationFixAttempts, 3);
  assert.equal(f.store.issue.reviewFixAttempts, 2);
  for (const field of ['commit', 'recoveryHead', 'pushedHead', 'reviewedCommit']) {
    assert.equal(f.store.issue[field], null);
  }
  assert.equal(f.git('rev-parse', 'HEAD'), f.manual);
});

test('auth, trust and validation mutation failures retain strict committed recovery', () => {
  for (const code of ['RALPH_AGENT_AUTH', 'RALPH_CONTROL_PLANE_CHANGED', 'RALPH_VALIDATION_MUTATED',
    'RALPH_PREFLIGHT_FAILED', 'RALPH_RECOVERY_BLOCKED']) {
    assert.deepEqual(committedValidationFailurePatch({ phase: 'committed', commit: 'saved' }, { code }), {});
  }
});

test('check detects the real manual-commit stop without changing git or state', (t) => {
  const f = fixture(t);
  const state = readFileSync(f.statePath, 'utf8');
  assert.throws(() => f.analyze(), /accept-manual-commit/);
  assert.equal(readFileSync(f.statePath, 'utf8'), state);
  assert.equal(f.git('rev-parse', 'HEAD'), f.manual);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('explicit manual acceptance queues full validation and review, retaining history', (t) => {
  const f = fixture(t);
  f.store.updateIssue({ reviewedCommit: f.manual, pushedHead: f.manual, lastFailure: 'old', validationFailureFingerprint: 'old' });
  const plan = f.analyze({ manualCommit: f.manual });
  assert.equal(f.store.issue.phase, 'working-tree');
  applyRecoveryPlan(plan, f.store);
  assert.equal(f.store.issue.phase, 'committed');
  assert.equal(f.store.issue.commit, f.manual);
  assert.equal(f.store.issue.recoveryHead, f.manual);
  assert.equal(f.store.issue.reviewedCommit, null);
  assert.equal(f.store.issue.pushedHead, null);
  assert.equal(f.store.issue.lastFailure, null);
  assert.equal(f.store.issue.validationFailureFingerprint, null);
  assert.equal(f.store.issue.validationFixAttempts, 2);
  assert.equal(f.store.issue.reviewFindings, 'Previous finding');
  assert.equal(f.analyze().kind, 'ready');
});

test('manual mode persists acceptance and the next run resumes validation', (t) => {
  const f = fixture(t);
  const verifyRepository = () => ({ currentBranch: f.git('branch', '--show-current'), clean: true });
  const result = prepareRecovery(f.config, f.store, '--accept-manual-commit', {
    run: f.run, verifyRepository, manualCommit: f.manual,
  });
  assert.equal(result.accepted, f.manual);
  assert.equal(createStateStore(f.config, '--run', f.statePath).issue.phase, 'committed');
  const resumed = prepareRecovery(f.config, f.store, '--run', { run: f.run, verifyRepository });
  assert.equal(resumed.recovery.kind, 'ready');
  assert.equal(f.store.issue.reviewedCommit, null);
});

test('run switches to the saved issue branch before recovery, while check and manual acceptance stay strict', (t) => {
  const f = fixture(t);
  f.store.updateIssue({ phase: 'committed', commit: f.manual, recoveryHead: f.manual });
  f.git('switch', '-qc', 'main', f.base);
  const before = readFileSync(f.statePath, 'utf8');
  const verifyRepository = (_config, requireClean) => {
    if (f.git('branch', '--show-current') !== 'feature') {
      if (!requireClean || f.git('status', '--porcelain')) throw new Error('wrong branch or dirty tree');
      f.git('switch', 'feature');
    }
    return { currentBranch: f.git('branch', '--show-current'), clean: true };
  };
  assert.throws(() => prepareRecovery(f.config, f.store, '--check', { run: f.run, verifyRepository }), /ожидается feature/);
  assert.throws(() => prepareRecovery(f.config, f.store, '--accept-manual-commit', {
    run: f.run, verifyRepository, manualCommit: f.manual,
  }), /ожидается feature/);
  assert.equal(f.git('branch', '--show-current'), 'main');
  assert.equal(readFileSync(f.statePath, 'utf8'), before);
  const result = prepareRecovery(f.config, f.store, '--run', { run: f.run, verifyRepository });
  assert.equal(result.recovery.kind, 'ready');
  assert.equal(result.repositoryState.currentBranch, 'feature');
});

test('rejected review cannot accept the same commit as a manual fix', (t) => {
  const f = fixture(t);
  f.store.updateIssue({ phase: 'review-failed', startingCommit: f.manual, commit: f.manual, reviewedCommit: f.manual });
  assert.throws(() => f.analyze({ manualCommit: f.manual }), /не содержит продолжения/);
  f.git('commit', '--allow-empty', '-qm', 'fix: empty review retry\n\nRalph-Issue: #325');
  const empty = f.git('rev-parse', 'HEAD');
  assert.equal(f.git('rev-parse', `${f.manual}^{tree}`), f.git('rev-parse', `${empty}^{tree}`));
  assert.throws(() => f.analyze({ manualCommit: empty }), /не содержит исправления/);
  const fix = f.commit('app.txt', 'fixed after review', 'fix: review finding\n\nRalph-Issue: #325');
  assert.equal(f.analyze({ manualCommit: fix }).patch.commit, fix);
});

test('Ralph update after manual fix is accepted, later product edits are rejected', (t) => {
  const f = fixture(t);
  const head = f.commit('scripts/ralph/fix.mjs', 'export {};', 'fix: recovery');
  assert.equal(f.analyze({ manualCommit: f.manual }).patch.recoveryHead, head);
  f.commit('other.txt', 'unrelated', 'feat: unrelated');
  assert.throws(() => f.analyze({ manualCommit: f.manual }), /посторонн/);
});

for (const scenario of ['dirty', 'branch', 'trailer', 'sha', 'history', 'staging', 'validation-mutated']) {
  test(`manual acceptance rejects ${scenario} and preserves state`, (t) => {
    const f = fixture(t);
    let requested = f.manual;
    if (scenario === 'dirty') writeFileSync(path.join(f.root, 'app.txt'), 'dirty');
    if (scenario === 'branch') f.git('switch', '-qc', 'foreign');
    if (scenario === 'trailer') requested = f.commit('app.txt', 'other', 'fix: other\n\nRalph-Issue: #999');
    if (scenario === 'sha') requested = f.manual.slice(0, 8);
    if (scenario === 'history') f.store.updateIssue({ startingCommit: 'a'.repeat(40) });
    if (scenario === 'staging') f.store.updateIssue({ phase: 'staging', expectedTree: 'a'.repeat(40) });
    if (scenario === 'validation-mutated') f.store.updateIssue({ phase: scenario, validationExpectedTreeHash: 'expected' });
    const state = readFileSync(f.statePath, 'utf8');
    assert.throws(() => f.analyze({ manualCommit: requested, hostWorkingTreeHash: () => 'changed' }));
    assert.equal(readFileSync(f.statePath, 'utf8'), state);
  });
}

test('unchanged HEAD permits dirty recovery; check can inspect an uncommitted installation', (t) => {
  const f = fixture(t);
  f.store.updateIssue({ startingCommit: f.manual });
  writeFileSync(path.join(f.root, 'app.txt'), 'work in progress');
  assert.equal(f.analyze().kind, 'ready');
  assert.equal(analyzeRecovery(f.config, null, { run: f.run }).kind, 'ready');
});

test('check predicts disjoint branch advance without persisting it', (t) => {
  const f = fixture(t);
  f.store.updateIssue({ startingCommit: f.manual });
  const head = f.commit('other.txt', 'unrelated', 'chore: unrelated');
  writeFileSync(path.join(f.root, 'app.txt'), 'work in progress');
  assert.equal(f.analyze().patch.startingCommit, head);
  assert.equal(f.store.issue.startingCommit, f.manual);
});

test('check refuses overlapping advance and stale successful review', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'app.txt'), 'work in progress');
  assert.throws(() => f.analyze(), /HEAD/);
  f.git('restore', 'app.txt');
  f.store.updateIssue({ phase: 'closing', commit: f.manual, reviewedCommit: f.manual, pushedHead: f.manual });
  f.commit('other.txt', 'later', 'feat: later');
  assert.throws(() => f.analyze(), /HEAD/);
});

test('check validates staging parent/tree/trailer but does not mutate state', (t) => {
  const f = fixture(t);
  f.store.updateIssue({ phase: 'staging', expectedTree: f.git('rev-parse', 'HEAD^{tree}') });
  assert.equal(f.analyze().kind, 'staging');
  assert.equal(f.store.issue.phase, 'staging');
  f.store.updateIssue({ expectedTree: 'a'.repeat(40) });
  assert.throws(() => f.analyze(), /parent\/tree\/trailer/);
});

test('read-only state load does not delete an idle mismatched state', (t) => {
  const f = fixture(t);
  f.store.clearIssue();
  const previous = readFileSync(f.statePath, 'utf8');
  createStateStore({ ...f.config, branch: 'other' }, '--check', f.statePath);
  assert.equal(readFileSync(f.statePath, 'utf8'), previous);
});
