import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commitStartingChanges } from './ralph-git.mjs';
import { prepareRecovery } from './ralph-recovery.mjs';

test('run saves tracked, staged and untracked changes in one startup commit', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const execute = (_command, args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return { stdout: result.stdout.trim(), status: result.status };
  };
  const git = (...args) => execute('git', args).stdout;
  git('init', '-q', '-b', 'feature');
  git('config', 'user.name', 'Ralph Test');
  git('config', 'user.email', 'ralph@example.test');
  writeFileSync(path.join(root, 'tracked.txt'), 'before');
  writeFileSync(path.join(root, 'staged.txt'), 'before');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(path.join(root, 'tracked.txt'), 'after');
  writeFileSync(path.join(root, 'staged.txt'), 'after');
  git('add', 'staged.txt');
  writeFileSync(path.join(root, 'untracked.txt'), 'new');

  const checked = prepareRecovery({ branch: 'feature' }, { issue: null }, '--check', {
    run: execute,
    verifyRepository: (_config, requireClean) => {
      assert.equal(requireClean, false);
      return { currentBranch: 'feature', clean: false };
    },
  });
  assert.equal(checked.recovery.head, before);
  assert.notEqual(git('status', '--porcelain'), '');
  const result = prepareRecovery({ branch: 'feature' }, { issue: null }, '--run', {
    run: execute,
    verifyRepository: () => {
      assert.equal(commitStartingChanges(execute), true);
      return { currentBranch: 'feature', clean: true };
    },
  });
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(result.recovery.head, git('rev-parse', 'HEAD'));
  assert.equal(git('rev-list', '--count', `${before}..HEAD`), '1');
  assert.equal(git('show', '--format=', '--name-only', 'HEAD'), 'staged.txt\ntracked.txt\nuntracked.txt');
  assert.equal(git('log', '-1', '--format=%s'), 'chore: save changes before Ralph run');
  assert.equal(commitStartingChanges(execute), false);
  assert.equal(git('rev-list', '--count', `${before}..HEAD`), '1');
});

test('startup commit stops before staging unresolved conflicts', () => {
  const commands = [];
  const execute = (_command, args) => {
    commands.push(args);
    return { stdout: args[0] === 'status' ? 'UU conflict.txt' : 'conflict.txt' };
  };
  assert.throws(() => commitStartingChanges(execute), /неразрешённые конфликты/);
  assert.deepEqual(commands.map((args) => args[0]), ['status', 'diff']);
});
