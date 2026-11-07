import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createTerminal, renderTerminal, terminalSnapshot } from './ralph-terminal.mjs';

const processState = {
  current: 'fixing', completed: ['implementation', 'validation'], failed: 'review',
  correctionSource: 'review', errorStage: null,
  reviewRound: 2, reviews: [{ round: 1, verdict: 'fail', findings: 4 }, { round: 2, verdict: 'fail', findings: 1 }],
  partial: false, reviewEnabled: true,
};
const snapshot = {
  headline: 'Задача #42 · Исправления', phase: '2/3', milestone: 'Экран управления',
  issue: '#42 Показать этапы', stage: 'Исправления', runTime: '0:42:18', issueTime: '0:12:10',
  process: processState,
  counterGroups: { run: ['Итерации: 7/60'], checks: ['Отказы ревью: 2/3'], session: ['Шаги агента: 8/50'] },
};

test('process map shows review returns and results without treating phase iterations as review rounds', () => {
  const frame = renderTerminal(snapshot, ['Повторная проверка началась'], 160, 32);
  assert.match(frame, /ПРОЦЕСС ЗАДАЧИ/);
  assert.match(frame, /\[\+\] Реализация.*\[\+\] Проверки.*\[~\] Ревью #2.*\[-\] Готово/);
  assert.match(frame, /\[>\] Исправления #2/);
  assert.match(frame, /Круг 1: 4 \[~\]/);
  assert.match(frame, /Круг 2: 1 \[~\]/);
  assert.match(frame, /1 замечание/);
  assert.match(frame, /↑/);
  assert.match(frame, /Повторная проверка началась/);
  assert.doesNotMatch(frame, /Ревью #7/);
});

test('compact process screen keeps stage, review round, result and time at 60 by 16', () => {
  for (const [columns, rows] of [[60, 16], [80, 24], [120, 24], [160, 40]]) {
    const frame = renderTerminal(snapshot, ['Новое событие'], columns, rows);
    assert.match(frame, /\[>\] Исправления #2/);
    assert.match(frame, /1 замеч/);
    assert.match(frame, /0:42:18/);
    assert.ok(frame.split('\n').length <= rows - 1);
    assert.ok(frame.split('\n').every(line => [...line].length < columns));
  }
});

test('disabled review and partial history never appear as a passed review', () => {
  const disabled = renderTerminal({ ...snapshot, process: { ...processState, reviewEnabled: false,
    current: 'publishing', failed: null, reviews: [], reviewRound: null } }, [], 120, 24);
  assert.match(disabled, /\[x\] Ревью/);
  assert.match(disabled, /× выключено/);
  assert.doesNotMatch(disabled, /\[\+\] Ревью|PASS/);
  const legacy = renderTerminal({ ...snapshot, process: { ...processState, current: 'review', failed: null,
    completed: [], reviews: [], reviewRound: null, partial: true } }, [], 120, 24);
  assert.match(legacy, /История неполная/);
  assert.match(legacy, /\[>\] Ревью #\?/);
  assert.doesNotMatch(legacy, /\[\+\] Реализация|к исправлению 0/);
});

test('process history scrolls through all known reviews and resets for the next task', () => {
  const output = new EventEmitter();
  Object.assign(output, { isTTY: true, columns: 160, rows: 32, text: '', write(text) { this.text += text; } });
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(v) { this.isRaw = v; }, resume() {}, pause() {} });
  let issueKey = '42';
  const reviews = Array.from({ length: 8 }, (_, i) => ({ round: i + 1, verdict: 'fail', findings: 8 - i }));
  const terminal = createTerminal({ output, errorOutput: output, input, lifecycle: new EventEmitter(), term: 'xterm',
    snapshot: () => ({ ...snapshot, issueKey, process: { ...processState, reviews, reviewRound: 8 } }) });
  assert.match(output.text, /Круг 8: 1/);
  output.text = '';
  input.emit('data', Buffer.from('\x1b[5~'));
  input.emit('data', Buffer.from('\x1b[5~'));
  assert.match(output.text, /Круг 1: 8/);
  output.text = '';
  terminal.log('INFO', 'Не менять выбор');
  assert.match(output.text, /Круг 1: 8/);
  input.emit('data', Buffer.from('\x1b[F'));
  assert.match(output.text, /Круг 8: 1/);
  output.text = '';
  issueKey = '43';
  terminal.refresh();
  assert.match(output.text, /Круг 8: 1/);
  terminal.close();
});


test('terminal projects persisted process data and keeps old task history out of service activities', () => {
  const persisted = { version: 1, ...processState };
  const store = { state: {}, issue: { number: 42, phase: 'agent-running', process: persisted } };
  const projected = terminalSnapshot(store, null, 0, 1000, { phaseConfig: { reviewEnabled: false } });
  assert.equal(projected.process.reviewRound, 2);
  assert.equal(projected.process.reviewEnabled, false);
  assert.equal(projected.process.reviews[1].findings, 1);
  const service = terminalSnapshot(store, null, 0, 1000, { activity: { kind: 'issue-preparation',
    label: 'Подготовка задачи #43', startedMs: 0 } });
  assert.equal(service.process, null);
});

test('compact review navigation visits adjacent rounds and preserves the viewed result on new reviews', () => {
  const output = new EventEmitter();
  Object.assign(output, { isTTY: true, columns: 60, rows: 16, text: '', write(text) { this.text += text; } });
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(v) { this.isRaw = v; }, resume() {}, pause() {} });
  const reviews = Array.from({ length: 8 }, (_, i) => ({ round: i + 1, verdict: 'fail', findings: 1 }));
  let passed = false;
  const terminal = createTerminal({ output, errorOutput: output, input, lifecycle: new EventEmitter(), term: 'xterm',
    snapshot: () => ({ ...snapshot, issueKey: '42', process: { ...processState, reviews, reviewRound: reviews.length,
      ...(passed ? { current: 'done', failed: null, correctionSource: null, completed: ['implementation', 'validation', 'review', 'done'] } : {}) } }) });
  try {
    output.text = '';
    input.emit('data', Buffer.from('\x1b[5~'));
    assert.match(output.text, /Ревью 7: FAIL/);
    output.text = '';
    reviews.push({ round: 9, verdict: 'pass', findings: 0 });
    passed = true;
    terminal.refresh();
    assert.match(output.text, /Ревью 7: FAIL/);
    assert.doesNotMatch(output.text, /Ревью 8: FAIL/);
    input.emit('data', Buffer.from('\x1b[F'));
    assert.match(output.text, /\[\+\] Ревью #9/);
  } finally { terminal.close(); }
});


test('headline distinguishes corrections from first implementation and phase reviews from issue reviews', () => {
  const issue = { number: 42, phase: 'agent-running', process: { version: 1, ...processState } };
  const store = { phaseIndex: 0, phaseCount: 2, state: { phaseProcess: { version: 1, ...processState, current: 'review' } }, issue };
  assert.equal(terminalSnapshot(store, null, 0, 1000).headline, 'Задача #42 · Исправления');
  const phase = terminalSnapshot(store, null, 0, 1000, { phaseConfig: { milestoneReviewEnabled: false },
    activity: { kind: 'milestone-review', label: 'Ревью фазы: PR #9', startedMs: 0 } });
  assert.equal(phase.process.scope, 'phase');
  assert.equal(phase.process.reviewEnabled, false);
  assert.match(renderTerminal(phase, [], 120, 24), /ПРОЦЕСС ФАЗЫ/);
  assert.match(renderTerminal(phase, [], 120, 24), /МЕТРИКИ ФАЗЫ/);
});


test('Lisa preserves the phase process when there is no current issue', () => {
  const phaseProcess = { version: 1, ...processState, current: 'review' };
  const snapshot = terminalSnapshot({ state: { phaseProcess }, issue: null }, null, 0, 1000,
    { phaseConfig: { milestoneReviewEnabled: true },
      activity: { kind: 'supervisor', label: 'Lisa: ремонт ревью фазы', startedMs: 0 } });
  assert.equal(snapshot.process.scope, 'phase');
  assert.equal(snapshot.process.reviewRound, 2);
  assert.match(renderTerminal(snapshot, [], 160, 32), /ПРОЦЕСС ФАЗЫ[\s\S]*Ревью #2/);
});

test('a technical failure is marked failed and preserves the source of a validation correction', () => {
  const process = { ...processState, current: 'review', failed: 'review', errorStage: 'review' };
  assert.match(renderTerminal({ ...snapshot, process }, [], 160, 32), /\[!\] Ревью/);
  const fixing = { ...processState, failed: 'implementation', correctionSource: 'validation' };
  const frame = renderTerminal({ ...snapshot, process: fixing }, [], 160, 32);
  assert.match(frame, /FAIL/);
  assert.match(frame, /\[>\] Исправления/);
  assert.match(frame, /↑/);
});


test('phase review history has a stable identity separate from the last issue', () => {
  const store = { phaseIndex: 1, state: { phaseIndex: 1, phaseProcess: { version: 1, ...processState } }, issue: null };
  const live = { activity: { kind: 'milestone-review', label: 'Ревью фазы', startedMs: 0 } };
  const first = terminalSnapshot(store, null, 0, 1000, live);
  assert.equal(first.issueKey, 'phase:1');
  live.activity.kind = 'supervisor';
  assert.equal(terminalSnapshot(store, null, 0, 1000, live).issueKey, first.issueKey);
});
