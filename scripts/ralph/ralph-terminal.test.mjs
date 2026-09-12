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
});

test('UI option is explicit and restricted to run', () => {
  assert.equal(parseUiOption('--run', []), 'plain');
  assert.equal(parseUiOption('--run', ['--ui=split']), 'split');
  assert.throws(() => parseUiOption('--check', ['--ui=split']));
  assert.throws(() => parseUiOption('--run', ['--ui=splt']));
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
