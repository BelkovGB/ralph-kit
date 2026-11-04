import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { executableTempDirectory } from './ralph-test-support.mjs';
import { captureLisaRepairContext, assessLisaRepair } from './ralph-lisa-repair.mjs';

for (const target of ['user.txt', 'scripts/ralph/fix.mjs']) {
  test(`Lisa cannot replace the index blob of ${target} behind an unchanged working tree`, async () => {
    const root = mkdtempSync(path.join(executableTempDirectory, 'repair-index-'));
    const run = (command, args) => {
      const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return { ...result, stdout: result.stdout.trim() };
    };
    try {
      mkdirSync(path.join(root, 'scripts/ralph'), { recursive: true });
      writeFileSync(path.join(root, 'scripts/ralph/fix.mjs'), 'original');
      writeFileSync(path.join(root, 'user.txt'), 'original');
      run('git', ['init', '--quiet', '-b', 'main']);
      run('git', ['config', 'user.name', 'Test']);
      run('git', ['config', 'user.email', 'test@example.test']);
      run('git', ['add', '.']);
      run('git', ['commit', '--quiet', '-m', 'base']);
      const state = { runId: 'run', phaseIndex: 0, issue: { number: 1, phase: 'working-tree', foreignPaths: ['user.txt'] } };
      const options = { projectRoot: root, run };
      const context = captureLisaRepairContext({ agentInstructionFiles: [], trustedControlFileHashes: new Map() }, { state }, new Error('failure'), options);
      writeFileSync(path.join(root, target), 'unreviewed index payload');
      run('git', ['add', '--', target]);
      writeFileSync(path.join(root, target), 'original');
      await assert.rejects(assessLisaRepair(context, { ...options,
        review: async () => ({ verdict: 'pass' }), validate: async () => {},
      }), /индекс/);
      assert.equal(run('git', ['show', ':' + target]).stdout, 'unreviewed index payload');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
