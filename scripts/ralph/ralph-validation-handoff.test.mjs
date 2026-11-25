import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ralphConfigPath } from './ralph-test-support.mjs';
import { prepareConfig } from './ralph-config.mjs';
import { canUseValidationHandoff, validateForHandoff, validationHandoffKey } from './ralph-validation-handoff.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'isolated-runtime.json');
  writeFileSync(manifest, '{"runtime":"one"}');
  const state = { runId: 'run', phaseIndex: 0, phasePlanId: 'plan', lisaRepair: { repairId: 'repair' },
    issue: { number: 17, startingCommit: 'a'.repeat(40), body: 'expected behaviour' } };
  const config = { branch: 'test/phase', validationHandoffInputs: ['isolated-runtime.json'],
    validationProfiles: { issue: ['test module'] }, preflightScripts: ['prepare runtime'],
    trustedControlFileHashes: new Map([['validator', 'abcdef']]) };
  const options = { root, environment: { PATH: 'bin' }, run: () => ({ stdout: '' }) };
  const workspace = { tree: 'tree', index: 'index', head: 'a'.repeat(40) };
  const target = { scope: 'issue', issueNumber: 17, baseCommit: state.issue.startingCommit };
  const key = () => validationHandoffKey(config, state, [], options);
  function validate(action = () => {}, timings = [{ stage: 'check', passed: true }], selection = target) {
    return validateForHandoff(config, state, selection, [], { ...options, validate: (_cfg, runOptions) => {
      assert.equal(runOptions.baseCommit, state.issue.startingCommit);
      runOptions.onPrepared();
      action();
      return { ran: true, timings };
    } });
  }
  return { manifest, config, state, options, workspace, key, validate };
}

test('a checked issue can hand off exclusively to its accepted workspace and policy', t => {
  const f = fixture(t);
  const receipt = { validationKey: f.validate(), issueHead: f.workspace.head,
    acceptedTreeHash: f.workspace.tree, acceptedIndexHash: f.workspace.index };
  assert.match(receipt.validationKey, /^[a-f0-9]{64}$/u);
  assert.ok(canUseValidationHandoff(receipt, f.key(), f.workspace));
  assert.equal(canUseValidationHandoff(null, f.key(), f.workspace), false);
  assert.equal(canUseValidationHandoff({ ...receipt, ralphChanged: true }, f.key(), f.workspace), false);
  for (const key of Object.keys(f.workspace)) {
    assert.equal(canUseValidationHandoff(receipt, f.key(), { ...f.workspace, [key]: 'another' }), false);
  }
  for (const [object, name, replacement] of [
    [f.state, 'runId', 'other'], [f.state.lisaRepair, 'repairId', 'other'],
    [f.state, 'phaseIndex', 1], [f.state.issue, 'number', 18],
    [f.state.issue, 'body', 'changed scope'], [f.state.issue, 'startingCommit', 'b'.repeat(40)],
    [f.config, 'branch', 'another/branch'], [f.config.validationProfiles, 'issue', ['another command']],
    [f.config, 'preflightScripts', ['different setup']], [f.config, 'trustedControlFileHashes', new Map([['validator','v2']])],
    [f.options.environment, 'PATH', 'different/bin'], [f.options, 'run', () => ({ stdout: 'different mode' })],
  ]) {
    const original = object[name];
    object[name] = replacement;
    assert.equal(canUseValidationHandoff(receipt, f.key(), f.workspace), false, name);
    object[name] = original;
  }
  writeFileSync(f.manifest, '{"runtime":"two"}');
  assert.equal(canUseValidationHandoff(receipt, f.key(), f.workspace), false);
});

test('failed, unprofiled, unbound or changing validation cannot issue a handoff', t => {
  const f = fixture(t);
  assert.throws(() => f.validate(() => { throw new Error('test failed'); }), /test failed/u);
  assert.equal(f.validate(() => {}, [{ stage: 'preflight', passed: true }]), null);
  assert.equal(f.validate(() => {}, [], { scope: 'phase', baseCommit: f.state.issue.startingCommit }), null);
  assert.equal(f.validate(() => writeFileSync(f.manifest, 'changed during validation')), null);
  delete f.config.validationHandoffInputs;
  assert.equal(f.validate(), null);
  f.config.validationHandoffInputs = ['isolated-runtime.json'];
  rmSync(f.manifest);
  assert.equal(f.validate(), null);
});

test('the configuration only permits project-relative handoff inputs', () => {
  const base = JSON.parse(readFileSync(ralphConfigPath, 'utf8'));
  for (const value of ['manifest', ['../input'], ['/outside'], ['.git/config'], ['X:/outside'], ['folder\\input']]) {
    assert.throws(() => prepareConfig({ ...structuredClone(base), validationHandoffInputs: value }, { captureControlPlane: false }), /validationHandoffInputs/u);
  }
});
