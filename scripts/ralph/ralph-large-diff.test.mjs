import test from 'node:test';
import assert from 'node:assert/strict';
import { openSync, writeSync, closeSync, existsSync } from 'node:fs';
import { branchChangeInventory } from './ralph-git.mjs';

test('branch review bounds a patch larger than the command buffer and retains excluded file inventory', () => {
  let output;
  const run = (_cmd, args) => {
    if (args[0] === 'log') return {status: 0, stdout: 'abc change'};
    if (args.includes('--name-status')) return {status: 0, stdout: 'D\tarchive/data.json\nM\tproduct/code.ts'};
    if (args.includes('--stat')) return {status: 0, stdout: '2 files changed'};
    assert.ok(args.includes(':(exclude)archive/**'));
    output = args.find(arg => arg.startsWith('--output='))?.slice(9);
    assert.ok(output, 'patch must go to a file, never to the bounded process stdout');
    const fd = openSync(output, 'w');
    try {
      const chunk = Buffer.from('изменение\n'.repeat(6000));
      for (let i = 0; i < 600; i++) writeSync(fd, chunk);
    } finally { closeSync(fd); }
    return {status: 0, stdout: ''};
  };
  const result = branchChangeInventory('base', 'head', {run, excludedPaths: ['archive/**']});
  assert.equal(result.diff.length, 60000);
  assert.equal(result.truncated, true);
  assert.ok(!result.diff.includes('\uFFFD'));
  assert.match(result.nameStatus, /archive\/data.json/);
  assert.equal(existsSync(output), false);
});

test('failed git patch does not become an empty successful review and removes its temporary file', () => {
  let output;
  const result = branchChangeInventory('missing', 'head', {run: (_cmd, args) => {
    output = args.find(arg => arg.startsWith('--output='))?.slice(9) ?? output;
    return {status: 128, stdout: ''};
  }});
  assert.equal(result, null);
  assert.ok(output);
  assert.equal(existsSync(output), false);
});
