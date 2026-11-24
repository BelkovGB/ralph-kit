import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStateStore } from './ralph-state-store.mjs';
import { prepareRecovery } from './ralph-recovery.mjs';
import { runContinuousLoop } from './ralph-loop.mjs';
import { runRalphLifecycle, ralphRunOutcome } from './ralph-lifecycle.mjs';
import { captureLisaRepairContext, assessLisaRepair, acceptLisaRepair } from './ralph-lisa-repair.mjs';
import { removeTemporaryDirectory } from './ralph-process-runner.mjs';
import { actions, context } from './ralph-test-support.mjs';

function phaseRepository(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-phase-repair-'));
  t.after(() => removeTemporaryDirectory(root));
  const run = (name, args, opts = {}) => {
    const result = execFileSync(name, args, { cwd: root, env: opts.env, encoding: 'utf8' });
    return { status: 0, stdout: opts.rawStdout ? result : result.trim() };
  };
  const git = (...args) => run('git', args).stdout;
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@localhost');
  mkdirSync(path.join(root, 'scripts/ralph'), { recursive: true });
  const file = path.join(root, 'scripts/ralph/check.mjs');
  writeFileSync(file, "process.exit(79);\n");
  git('add', '.');
  git('commit', '-qm', 'test baseline');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('switch', '-qc', 'phase');
  const cfg = { branch: 'phase', baseBranch: 'main', trustedControlFileHashes: new Map() };
  const state = { runId: 'test-run', branch: 'phase', phaseIndex: 0, issue: null };
  const opts = { projectRoot: root, run, failureStep: 'pull-request' };
  const failure = Object.assign(new Error('missing check'), { code: 'RALPH_VALIDATION_SCOPE_UNKNOWN' });
  const capture = () => captureLisaRepairContext(cfg, { state }, failure, opts);
  return { root, run, git, file, cfg, state, opts, failure, capture };
}

test('phase validation repair is reviewed, committed and resumes the failed PR step without an issue', async (t) => {
  const f = phaseRepository(t);
  const initialHead = f.git('rev-parse', 'HEAD');
  let calls = 0;
  let repairs = 0;
  const result = await runRalphLifecycle({
    async start() {
      try {
        await runContinuousLoop(context({ config: f.cfg }), actions({
          createPullRequest: () => {
            calls++;
            assert.equal(f.git('status', '--porcelain'), '');
            if (readFileSync(f.file, 'utf8').includes('79')) throw f.failure;
            f.run(process.execPath, [f.file]);
            return { number: 1, headRefOid: f.git('rev-parse', 'HEAD') };
          },
        }));
        return { kind: 'completed' };
      } catch (err) { return ralphRunOutcome(null, err); }
    },
    async repair(result) {
      assert.equal(++repairs, 1);
      assert.equal(result.failure.step, 'pull-request');
      const ctx = f.capture();
      writeFileSync(f.file, 'process.exit(0);\n');
      const assessed = await assessLisaRepair(ctx, { ...f.opts,
        review: async ({ changes }) => {
          assert.deepEqual(changes.map(c => c.path), ['scripts/ralph/check.mjs']);
          return { verdict: 'pass', reason: 'Checked the phase repair' };
        },
        validate: async () => { f.run(process.execPath, [f.file]); },
      });
      const receipt = acceptLisaRepair(ctx, assessed, f.opts);
      assert.equal(receipt.phaseCommit, f.git('rev-parse', 'HEAD'));
      assert.equal(initialHead, f.git('rev-parse', 'HEAD^'));
      assert.equal(f.git('diff', '--name-only', initialHead, 'HEAD'), 'scripts/ralph/check.mjs');
      return { verdict: 'resume' };
    },
  });
  assert.equal(result.kind, 'completed');
  assert.equal(calls, 2);
});

test('phase validation repair cannot publish product changes without an issue review', async (t) => {
  const f = phaseRepository(t);
  const ctx = f.capture();
  writeFileSync(path.join(f.root, 'product.js'), 'export const value = 7;');
  await assert.rejects(assessLisaRepair(ctx, f.opts), /ревью задачи/u);
  assert.equal(f.git('rev-parse', 'HEAD'), ctx.head);
});

test('phase repair leaves operator changes and changed phase bases untouched', async (t) => {
  const f = phaseRepository(t);
  const operator = path.join(f.root, 'operator.txt');
  writeFileSync(operator, 'operator\n');
  assert.throws(f.capture, /чистая рабочая ветка/);
  f.git('add', 'operator.txt');
  assert.throws(f.capture, /чистая рабочая ветка/);
  assert.equal(f.git('diff', '--cached', '--name-only'), 'operator.txt');
  f.git('commit', '-qm', 'operator work');
  const ctx = f.capture();
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await assert.rejects(assessLisaRepair(ctx, f.opts), /база фазы изменилась/);
});

test('an unrelated phase failure cannot approve a control plane repair', async (t) => {
  const f = phaseRepository(t);
  const ctx = captureLisaRepairContext(f.cfg, { state: f.state }, new Error('publication failed'), f.opts);
  writeFileSync(f.file, 'other();\n');
  await assert.rejects(assessLisaRepair(ctx, f.opts), /требует сохранённой issue/);
});


test('manual phase recovery clears only the matching stopped repair and rechecks phase validation on the next run', async (t) => {
  const f = phaseRepository(t);
  const store = createStateStore(f.cfg, '--run', path.join(f.root, '.git', 'state.json'));
  const repairId = 'operator-phase-test';
  store.beginLisaRepair({ repairId, runId: store.state.runId, phaseIndex: 0, failureStep: 'pull-request' });
  store.updateLisaRepair(repairId, { status: 'needs-human' });
  const manual = sha => prepareRecovery(f.cfg, store, '--accept-manual-commit', {
    run: f.run, manualCommit: sha, verifyRepository: (_cfg, switchAllowed) => {
      assert.equal(switchAllowed, false);
      return { currentBranch: f.git('branch', '--show-current') };
    },
  });
  const assertBlocked = sha => {
    assert.throws(() => manual(sha), { code: 'RALPH_RECOVERY_BLOCKED' });
    assert.equal(store.state.lisaRepair.repairId, repairId);
  };
  assertBlocked(f.git('rev-parse', 'HEAD'));
  f.git('commit', '--allow-empty', '-qm', 'Manual repair', '-m', 'Ralph-Phase-Repair: other');
  assertBlocked(f.git('rev-parse', 'HEAD'));
  writeFileSync(f.file, 'process.exit(0);\n');
  f.git('add', 'scripts/ralph/check.mjs');
  f.git('commit', '-qm', 'Manual repair', '-m', `Ralph-Phase-Repair: ${repairId}`);
  const sha = f.git('rev-parse', 'HEAD');
  assertBlocked(f.git('rev-parse', 'HEAD^'));
  f.git('switch', '-q', '-c', 'other-branch');
  assertBlocked(sha);
  f.git('switch', '-q', 'phase');
  const other = path.join(f.root, 'operator.txt');
  writeFileSync(other, 'operator change\n');
  assertBlocked(sha);
  unlinkSync(other);
  const before = structuredClone(store.state);
  assert.equal(manual(sha).accepted, sha);
  assert.equal(store.state.lisaRepair, null);
  for (const field of ['runId', 'phaseIndex', 'supervisorCalls', 'iterationsUsed', 'approvedIssueSnapshots']) {
    assert.deepEqual(store.state[field], before[field]);
  }
  let validated = 0;
  await runContinuousLoop(context({ config: f.cfg }), actions({
    createPullRequest: () => {
      assert.equal(f.git('rev-parse', 'HEAD'), sha);
      f.run(process.execPath, [f.file]);
      validated++;
      return { number: 1, headRefOid: sha };
    },
  }));
  assert.equal(validated, 1);
});
