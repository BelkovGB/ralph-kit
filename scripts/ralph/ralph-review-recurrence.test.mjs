import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewFindingKeys } from './ralph-review-recurrence.mjs';

const finding = { file: 'api/parse.js', line: 12, severity: 'P1',
  title: 'Проверить café', body: 'Reject a value when count < 0.' };
const fail = (...findings) => ({ verdict: 'fail', findings });

test('the same review defect survives a line move and formatting changes', () => {
  const [key] = reviewFindingKeys(fail(finding));
  assert.match(key, /^[a-f0-9]{64}$/u);
  const changed = { ...finding, file: './api\\parse.js', line: 86,
    title: '  Проверить  cafe\u0301 ', body: 'Reject a value\nwhen count < 0. ' };
  assert.deepEqual(reviewFindingKeys(fail(changed)), [key]);
  assert.deepEqual(reviewFindingKeys(fail(finding, { ...finding })), [key]);
});

test('different causes, severity and paths do not identify the same defect', () => {
  const [key] = reviewFindingKeys(fail(finding));
  for (const change of [{ file: 'api/Parse.js' }, { severity: 'P0' }, { title: 'Another condition' },
    { body: 'Reject a value when count > 0.' }]) {
    const [different] = reviewFindingKeys(fail({ ...finding, ...change }));
    assert.ok(different && different !== key);
  }
  const other = { ...finding, title: 'Other guard' };
  assert.deepEqual(reviewFindingKeys(fail(other, finding)), reviewFindingKeys(fail(finding, other)));
  assert.deepEqual(reviewFindingKeys(fail(finding, { ...finding, line: 48 }, other)), reviewFindingKeys(fail(other)));
});

test('only actionable blocking findings produce recurrence keys', () => {
  for (const review of [null, {}, { verdict: 'pass', findings: [finding] },
    { verdict: 'fail', findings: [], belowFloorFindings: [finding] }, fail(null, {}, { ...finding, body: '' }),
    fail({ ...finding, severity: 'unknown' }, { ...finding, line: -1 }, { ...finding, file: '../elsewhere' })]) {
    assert.deepEqual(reviewFindingKeys(review), []);
  }
});
