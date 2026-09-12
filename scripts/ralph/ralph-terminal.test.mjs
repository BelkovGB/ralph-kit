import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createTerminal, renderTerminal, parseUiOption, terminalSnapshot } from './ralph-terminal.mjs';

test('summary uses persisted state and does not invent missing counters or durations', () => {
  const store = { phaseIndex: 1, phaseCount: 3, state: { milestone: 'M2', iterationsUsed: 4 },
    issue: { number: 42, title: 'Экран', phase: 'reviewing', validationFixAttempts: 0 } };
  const snapshot = terminalSnapshot(store, { issue: 42, startedMs: 1000 }, 0, 61000);
  assert.equal(snapshot.phase, '2/3');
  assert.equal(snapshot.stage, 'Ревью');
  assert.equal(snapshot.issueTime, '0:01:00');
  assert.equal(snapshot.iteration, 4);
  assert.equal(snapshot.fixes, 0);
  assert.equal(terminalSnapshot(store, null, 0, 61000).issueTime, undefined);
  assert.equal(terminalSnapshot(null, null, 0, 61000).iteration, undefined);
  assert.equal(terminalSnapshot({ ...store, state: null, issue: null }, null, 0).phase, '—');
  assert.equal(terminalSnapshot({ ...store, state: null, issue: null }, null, 0).status, 'Завершён');
  const preparing = terminalSnapshot({ ...store, issue: null }, { issue: 42, issueTitle: 'Экран', startedMs: 1000 }, 0);
  assert.equal(preparing.issue, '#42 Экран');
});

test('UI option is explicit and restricted to run', () => {
  assert.equal(parseUiOption('--run', []), 'plain');
  assert.equal(parseUiOption('--run', ['--ui=split']), 'split');
  assert.throws(() => parseUiOption('--check', ['--ui=split']));
  assert.throws(() => parseUiOption('--run', ['--ui=splt']));
});

test('live counters show actual session limits, phase limits and distinct attempt budgets', () => {
  const store = { phaseIndex: 0, phaseCount: 2, state: { iterationsUsed: 3 },
    issue: { number: 42, title: 'Тест', phase: 'agent-running', validationFixAttempts: 1, reviewFixAttempts: 2 } };
  const live = {
    phaseConfig: { maxIterations: 9, maxTestFixAttempts: 4, maxReviewFixAttempts: 5 },
    queueProgress: { completedInRun: 2, remaining: 7, parked: 1 },
    session: { startedMs: 1000, lastEventMs: 51000, active: true, turns: 8, maxTurns: 17,
      toolResults: 6, timeoutMs: 90000, firstEventTimeoutMs: 40000, idleTimeoutMs: 20000 },
    network: { attempt: 2, attempts: 4, active: true }, review: { attempt: 1, attempts: 3, startedMs: 1000, active: true },
  };
  const text = terminalSnapshot(store, { issue: 42, startedMs: 1000 }, 0, 61000, live).counters.join('\n');
  for (const expected of ['Итерации: 3/9', 'Исправления тестов: 1/4', 'Отказы ревью: 2/5',
    'Шаги агента: 8/17', 'Ответы инструментов: 6', '0:01:00 / 0:01:30',
    'Без событий: 0:00:10 / 0:00:20', 'Сеть: 2/4', 'Запуск ревью: 1/3', 'В очереди: 7']) assert.ok(text.includes(expected), expected);
  live.session.active = false;
  live.session.endedMs = 61000;
  const ended = terminalSnapshot(store, { issue: 42, startedMs: 1000 }, 0, 999000, live).counters.join('\n');
  assert.equal(ended.includes('Без событий'), false);
  assert.ok(ended.includes('0:01:00 / 0:01:30'));
  const nextTask = terminalSnapshot(store, { issue: 42, startedMs: 999000 }, 0, 999000, live).counters.join('\n');
  assert.equal(nextTask.includes('Шаги агента'), false);
  assert.equal(nextTask.includes('Запуск ревью'), false);
  assert.equal(terminalSnapshot(store, null, 0, 999000, live).counters.join('\n').includes('Шаги агента'), false);
});

test('frame fits terminal and sanitizes untrusted text, including wide Unicode', () => {
  for (const columns of [40, 79, 100, 160]) {
    const frame = renderTerminal({ phase: '2/3', issue: '#12 界👩‍💻\x1b[2J\rBAD', stage: 'Ревью' },
      ['event\x1b]0;evil\x07\x1b[2J', 'x'.repeat(500)], columns, 24);
    assert.ok(frame.split('\n').length <= 23);
    assert.ok(frame.split('\n').every(line => [...line].length <= columns - 1));
    for (const control of ['\x1b', '\r', '\x07']) assert.equal(frame.includes(control), false);
    assert.match(frame, /2\/3/);
    assert.doesNotMatch(frame, /evil/);
  }
});

function surface(tty = true) {
  const stream = new EventEmitter();
  Object.assign(stream, { isTTY: tty, columns: 100, rows: 24, text: '', write(text) { this.text += text; } });
  return stream;
}

function keyboard() {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, paused: true,
    setRawMode(value) { this.isRaw = value; }, isPaused() { return this.paused; },
    resume() { this.paused = false; }, pause() { this.paused = true; } });
  return input;
}

test('Tab opens buffered details, pages stay still on new output, End follows and cleanup restores input', () => {
  const output = surface();
  const input = keyboard();
  const lifecycle = new EventEmitter();
  const terminal = createTerminal({ output, errorOutput: output, input, lifecycle, term: 'xterm' });
  terminal.detail('INFO', Array.from({ length: 80 }, (_, i) => `RAW-${i}`).join('\n'));
  assert.equal(output.text.includes('RAW-79'), false);
  input.emit('data', Buffer.from('\t'));
  assert.ok(output.text.includes('RAW-79'));
  output.text = '';
  input.emit('data', Buffer.from('\x1b[5~'));
  const old = output.text;
  output.text = '';
  terminal.detail('INFO', 'RAW-NEW');
  assert.equal(output.text.includes('RAW-NEW'), false);
  assert.ok(old.includes('RAW-'));
  input.emit('data', Buffer.from('\x1b[F'));
  assert.ok(output.text.includes('RAW-NEW'));
  output.text = '';
  input.emit('data', Buffer.from('\t'));
  assert.equal(output.text.includes('RAW-NEW'), false);
  terminal.close();
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
  assert.equal(input.listenerCount('data'), 0);
});

test('log resets at next task and Ctrl+C restores raw input before stopping', () => {
  const output = surface();
  const input = keyboard();
  const lifecycle = new EventEmitter();
  lifecycle.pid = 123;
  lifecycle.kill = (pid, signal) => {
    assert.equal(pid, 123);
    assert.equal(signal, 'SIGINT');
    assert.equal(input.isRaw, false);
  };
  let issueKey = '42';
  const terminal = createTerminal({ output, errorOutput: output, input, lifecycle, term: 'xterm', snapshot: () => ({ issueKey }) });
  terminal.detail('INFO', 'OLD-TASK');
  issueKey = '43';
  terminal.detail('INFO', 'NEW-TASK');
  output.text = '';
  input.emit('data', Buffer.from('\t'));
  assert.equal(output.text.includes('OLD-TASK'), false);
  assert.ok(output.text.includes('NEW-TASK'));
  input.emit('data', Buffer.from('\x03'));
});

test('non-TTY and dumb terminals do not take over output', () => {
  for (const [tty, term] of [[false, 'xterm'], [true, 'dumb']]) {
    const output = surface(tty);
    assert.equal(createTerminal({ output, errorOutput: output, term }), null);
    assert.equal(output.text, '');
  }
});

test('terminal resizes, restores screen once and removes listeners', () => {
  const output = surface();
  const lifecycle = new EventEmitter();
  const terminal = createTerminal({ output, errorOutput: output, lifecycle, term: 'xterm', snapshot: () => ({ phase: '1/2' }) });
  terminal.log('INFO', 'Started');
  assert.match(output.text, /Started/);
  output.columns = 50;
  output.emit('resize');
  terminal.close();
  terminal.close();
  assert.equal(output.text.split('\x1b[?1049l').length - 1, 1);
  assert.equal(output.listenerCount('resize'), 0);
  assert.equal(lifecycle.listenerCount('exit'), 0);
});

test('signals restore the terminal before forwarding the original stop signal', () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const output = surface();
    const lifecycle = new EventEmitter();
    lifecycle.pid = 123;
    const forwarded = [];
    lifecycle.kill = (pid, value) => {
      assert.ok(output.text.includes('\x1b[?1049l'));
      assert.equal(lifecycle.listenerCount(value), 0);
      forwarded.push([pid, value]);
    };
    createTerminal({ output, errorOutput: output, lifecycle, term: 'xterm' });
    lifecycle.emit(signal);
    assert.deepEqual(forwarded, [[123, signal]]);
    assert.equal(lifecycle.listenerCount('exit'), 0);
  }
});
