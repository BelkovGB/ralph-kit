import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { createTerminal, renderTerminal } from './ralph-terminal.mjs';
import * as processView from './ralph-terminal-process.mjs';

const snapshot = {
  headline: 'Задача #42 · Исправления', issue: '#42 Экран CLI', phase: '2/3',
  milestone: 'Пульт Ralph', runTime: '0:42:18', issueTime: '0:12:10',
  process: {
    current: 'fixing', completed: ['implementation', 'validation'], failed: 'review',
    correctionSource: 'review', reviewEnabled: true, partial: false, reviewRound: 2,
    reviews: [{ round: 1, verdict: 'fail', findings: 4 }, { round: 2, verdict: 'fail', findings: 1 }],
    stageMs: { implementation: 12000, validation: 2000, review: 6000, fixing: 4000, publishing: null },
  },
  counterGroups: {
    run: ['Сделано в прогоне фазы: 2', 'В очереди: 4 · отложено: 0', 'Итерации: 7/60', 'Вызовы Lisa в фазе: 1/3'],
    checks: ['Исправления тестов: 0/5', 'Отказы ревью: 2/3'],
    session: ['Шаги агента: 8/50', 'Ответы инструментов: 6', 'До остановки: 0:09:59'],
  },
};

test('wide process screen puts a boxed flow above three aligned panels', () => {
  const frame = renderTerminal(snapshot, ['12:42:18 Исправляем замечание'], 160, 40);
  const lines = frame.split('\n');
  const map = lines.findIndex(line => line.includes('[+] Реализация'));
  const panels = lines.findIndex(line => line.includes('ПРОГРЕСС И КАЧЕСТВО'));
  assert.ok(map > 0 && map < panels);
  assert.match(lines[map - 1], /┌─+┐/);
  assert.match(lines[map + 1], /└─+┘/);
  assert.match(lines[panels], /ПРОГРЕСС И КАЧЕСТВО.*СОБЫТИЯ.*МЕТРИКИ ЗАДАЧИ/);
  assert.match(frame, /Круг ревью: 2/);
  assert.match(frame, /Ревью 1: FAIL · к исправлению 4/);
  assert.match(frame, /Ревью 2: FAIL · к исправлению 1/);
  assert.match(frame, /Возврат: ревью -> исправления -> проверки/);
  assert.match(frame, /└[─┄]+[┘┐]|<[─┄]+┘/);
  assert.match(frame, /12:42:18 Исправляем замечание/);
  assert.match(frame, /Реализация\s+0:00:12/);
  assert.match(frame, /Исправления\s+0:00:04/);
  assert.doesNotMatch(frame, /ПЛАН 2\/6|ДОЛГ РЕВЬЮ 1/);
});

test('dashboard stays inside every supported terminal size without losing the current review', () => {
  for (const [columns, rows] of [[160, 40], [140, 24], [120, 24], [80, 24], [60, 16]]) {
    const frame = renderTerminal(snapshot, ['Последнее событие'], columns, rows);
    assert.ok(frame.split('\n').length <= rows - 1, `${columns}x${rows}: height`);
    assert.ok(frame.split('\n').every(line => [...line].length < columns), `${columns}x${rows}: width`);
    assert.match(frame, /Круг ревью: 2/);
    assert.match(frame, /Сейчас: Исправления/);
    assert.match(frame, /0:42:18/);
    assert.match(frame, /PgUp\/PgDn/);
  }
});

test('missing stage timing stays unknown while a measured zero is visible', () => {
  const unknown = renderTerminal({ ...snapshot, process: { ...snapshot.process, stageMs: undefined } }, [], 160, 40);
  assert.match(unknown, /Время стадий ещё не записано/);
  assert.doesNotMatch(unknown, /Реализация\s+0:00:00/);
  const zero = renderTerminal({ ...snapshot, process: { ...snapshot.process, stageMs: { validation: 0 } } }, [], 160, 40);
  assert.match(zero, /Проверки\s+0:00:00/);
});

test('review pages identify their range and keep the quality chart on the same rounds', () => {
  const reviews = Array.from({ length: 8 }, (_, index) => ({ round: index + 1, verdict: 'fail', findings: 8 - index }));
  const frame = renderTerminal({ ...snapshot, process: { ...snapshot.process, reviews, reviewRound: 8 } }, [], 160, 40,
    { reviewOffset: 3 });
  assert.match(frame, /Круг ревью: 8.*История: 3-5\/8/);
  assert.match(frame, /Круг 3: 6/);
  assert.match(frame, /Круг 5: 4/);
  assert.doesNotMatch(frame, /Круг 8: 1/);
});

test('terminal palette highlights states and preserves a complete text-only equivalent', () => {
  assert.equal(typeof processView.colorTerminalFrame, 'function');
  const plain = renderTerminal(snapshot, [], 160, 40);
  const colored = processView.colorTerminalFrame(plain);
  for (const color of [31, 32, 33]) assert.ok(colored.includes(`\x1b[${color}m`));
  assert.equal(stripVTControlCharacters(colored), plain);
  const malicious = renderTerminal({ ...snapshot, issue: '#42\x1b[2J\x1b]0;evil\x07' }, ['\x1b[31mRAW\x1b[0m'], 160, 40);
  assert.equal(malicious.includes('\x1b'), false);
  const markers = renderTerminal(snapshot, ['[+] read [+] done', '[>] [!] repeated markers'], 160, 40);
  assert.equal(stripVTControlCharacters(processView.colorTerminalFrame(markers)), markers);
});

test('live terminal colors respect NO_COLOR and never color the detailed log', () => {
  const original = process.env.NO_COLOR;
  const surface = () => Object.assign(new EventEmitter(), {
    isTTY: true, columns: 160, rows: 40, text: '', hasColors: () => true,
    write(text) { this.text += text; },
  });
  const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false,
    setRawMode(value) { this.isRaw = value; }, resume() {}, pause() {} });
  try {
    delete process.env.NO_COLOR;
    const output = surface();
    const terminal = createTerminal({ output, errorOutput: output, input, lifecycle: new EventEmitter(),
      term: 'xterm', snapshot: () => snapshot });
    try {
      assert.ok(output.text.includes('\x1b[33m'));
      terminal.detail('INFO', '[+] Raw detail');
      output.text = '';
      input.emit('data', Buffer.from('\t'));
      assert.match(output.text, /\[\+\] Raw detail/);
      assert.equal([31, 32, 33].some(color => output.text.includes(`\x1b[${color}m`)), false);
    } finally { terminal.close(); }
    process.env.NO_COLOR = '1';
    const monochrome = surface();
    const plain = createTerminal({ output: monochrome, errorOutput: monochrome, lifecycle: new EventEmitter(),
      input, term: 'xterm', snapshot: () => snapshot });
    try {
      assert.equal([31, 32, 33].some(color => monochrome.text.includes(`\x1b[${color}m`)), false);
    } finally { plain.close(); }
  } finally {
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  }
});
