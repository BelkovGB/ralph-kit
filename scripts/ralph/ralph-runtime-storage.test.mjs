import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ralphRunOutcome, runRalphLifecycle } from './ralph-lifecycle.mjs';
import { readJsonFile, writeTextAtomic } from './ralph-runtime.mjs';
import { createStateStore } from './ralph-state-store.mjs';
import { runWithSupervisor } from './ralph-supervisor.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-runtime-storage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'state.json');
}

const locked = code => Object.assign(new Error(code), { code });

test('a Windows reader can release the same pending atomic replacement', t => {
  const target = fixture(t);
  writeFileSync(target, 'old');
  const sources = new Set();
  const codes = ['EPERM', 'EACCES', 'EBUSY'];
  let waits = 0;
  writeTextAtomic(target, 'new', {
    platform: 'win32',
    rename(source, destination) {
      sources.add(source);
      assert.equal(readFileSync(target, 'utf8'), 'old');
      if (codes.length) throw locked(codes.shift());
      renameSync(source, destination);
    },
    sleep() { waits++; },
  });
  assert.equal(waits, 3);
  assert.equal(sources.size, 1);
  assert.equal(readFileSync(target, 'utf8'), 'new');
  assert.deepEqual(readdirSync(path.dirname(target)), ['state.json']);
});

test('permanent locks, full disks and POSIX permission failures preserve the previous checkpoint', async t => {
  for (const [platform, code, retries] of [['win32', 'EPERM', 5], ['win32', 'ENOSPC', 0], ['linux', 'EACCES', 0]]) {
    const target = fixture(t);
    writeFileSync(target, 'old');
    const cause = locked(code);
    let calls = 0;
    let waits = 0;
    let failure;
    assert.throws(() => writeTextAtomic(target, 'new', {
      platform, rename() { calls++; throw cause; }, sleep() { waits++; },
    }), error => {
      failure = error;
      return error.code === 'RALPH_RUNTIME_STORAGE' && error.cause === cause && error.message.includes(target);
    });
    assert.equal(calls, retries + 1);
    assert.equal(waits, retries);
    assert.equal(readFileSync(target, 'utf8'), 'old');
    assert.deepEqual(readdirSync(path.dirname(target)), ['state.json']);
    const outcome = await runRalphLifecycle({
      start: () => ralphRunOutcome(null, failure), repair: () => assert.fail('Lisa must not be invoked'),
    });
    assert.equal(outcome.kind, 'needs-human');
    assert.equal(outcome.failure.code, 'RALPH_RUNTIME_STORAGE');
    const config = { supervisor: { enabled: true, maxInterventions: 10 } };
    const store = { supervisorCalls: 0, reserveSupervisorCall() { assert.fail('unexpected Lisa budget charge'); } };
    await assert.rejects(runWithSupervisor(config, store, () => { throw failure; }), e => e === failure);
  }
});

test('unreadable checkpoints are distinct from an absent state', t => {
  const target = fixture(t);
  assert.equal(readJsonFile(target), null);
  mkdirSync(target);
  assert.throws(() => readJsonFile(target), { code: 'RALPH_RUNTIME_STORAGE' });
});

test('after a rejected phase checkpoint the same worker cannot publish a later write', t => {
  const target = fixture(t);
  const config = { phaseIndex: 0, phasePlanId: 'plan', phaseCount: 2, branch: 'one', baseBranch: 'main', milestone: 'one' };
  const store = createStateStore(config, '--run', target);
  const preserved = target + '.saved';
  renameSync(target, preserved);
  mkdirSync(target);
  const next = { ...config, phaseIndex: 1, branch: 'two', baseBranch: 'one', milestone: 'two' };
  assert.throws(() => store.advancePhase(next), { code: 'RALPH_RUNTIME_STORAGE' });
  rmdirSync(target);
  renameSync(preserved, target);
  assert.throws(() => store.reserveIteration(), { code: 'RALPH_RUNTIME_STORAGE' });
  assert.equal(readJsonFile(target).phaseIndex, 0);
  assert.equal(readJsonFile(target).iterationsUsed, 0);
  assert.equal(createStateStore(config, '--run', target).advancePhase(next), true);
});
