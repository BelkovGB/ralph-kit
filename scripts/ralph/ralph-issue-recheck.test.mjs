import assert from 'node:assert/strict';
import test from 'node:test';
import { validateIssueAttempt } from './ralph-issue-recheck.mjs';

const selector = 'workflow.spec.ts:26:5 › submit';
const issue = { validationFailureFingerprint: 'same',
  lastFailureSummary: { code: 'RALPH_VALIDATION_FAILED', failedTests: [selector] } };
const options = { scope: 'issue', issueNumber: 8, baseCommit: 'a'.repeat(40) };
const config = { validationProfiles: { issueRecheck: ['node scripts/recheck.mjs'] } };

function validationError(testName = selector, code = 'RALPH_VALIDATION_FAILED') {
  return Object.assign(new Error('An assertion failed.'), { code, status: 1, stdout: '1) ' + testName });
}

test('a repeated failing selector on the same inputs stops before broad validation', () => {
  let calls = 0;
  assert.throws(() => validateIssueAttempt(config, options, issue, () => 'same', () => assert.fail('broad'), (_config, scripts, _label, opts) => {
    calls++;
    assert.deepEqual(scripts, config.validationProfiles.issueRecheck);
    assert.deepEqual(opts.failedTests, [selector]);
    assert.equal(opts.baseCommit, options.baseCommit);
    throw validationError();
  }), err => err.code === 'RALPH_NEEDS_HUMAN' && err.cause.validationFailureFingerprint === 'same');
  assert.equal(calls, 1);
});

test('the regular issue profile remains mandatory after the focused check passes', () => {
  const calls = [];
  const result = validateIssueAttempt(config, options, issue, () => 'same',
    () => { calls.push('issue'); return 'validated entries'; }, () => calls.push('recheck'));
  assert.equal(result, 'validated entries');
  assert.deepEqual(calls, ['recheck', 'issue']);
});

test('without a focused command a matching second full failure confirms the blocker', () => {
  let calls = 0;
  assert.throws(() => validateIssueAttempt({}, options, issue, () => 'same', () => {
    calls++; throw validationError();
  }, () => assert.fail('recheck')), err => err.code === 'RALPH_NEEDS_HUMAN');
  assert.equal(calls, 1);
});

test('changed inputs, a different test, and classified environment failures keep their own outcomes', () => {
  for (const [key, error] of [['changed', validationError()], ['same', validationError('different test')],
    ['same', validationError(selector, 'RALPH_VALIDATION_ENVIRONMENT')]]) {
    assert.throws(() => validateIssueAttempt(config, options, issue, () => key, () => assert.fail('broad'),
      () => { throw error; }), actual => actual === error);
  }
});

test('a missing or legacy record runs the whole issue and records fresh evidence on failure', () => {
  for (const prior of [null, {}, { lastFailureSummary: issue.lastFailureSummary }]) {
    assert.throws(() => validateIssueAttempt(config, options, prior, () => 'current',
      () => { throw validationError(); }, () => assert.fail('recheck')),
    error => error.code === 'RALPH_VALIDATION_FAILED' && error.validationFailureFingerprint === 'current');
  }
});
