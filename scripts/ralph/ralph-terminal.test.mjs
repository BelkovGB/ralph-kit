import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createTerminal, renderTerminal, parseUiOption, terminalSnapshot, renderRunSummary } from './ralph-terminal.mjs';

test('run summary distinguishes completed, stopped and failed runs without inventing totals', () => {
  const base = { startedMs: 1000, endedMs: 62000, phaseCount: 4, logPath: 'run.log' };
  assert.match(renderRunSummary({ ...base, result: { verdict: 'pass' } }), /ЗАВЕРШЁН[\s\S]*Завершены все фазы: 4[\s\S]*0:01:01[\s\S]*run.log/);
  const stopped = renderRunSummary({ ...base, result: { verdict: 'parked' } });
  assert.match(stopped, /ОСТАНОВЛЕН/);
  assert.doesNotMatch(stopped, /Завершены все фазы/);
  assert.match(renderRunSummary({ ...base, error: new Error('Проверка изменила файлы') }), /ОШИБКА[\s\S]*Проверка изменила файлы/);
});

test('closing fresh stdin pauses the reader started by the terminal', () => {
  const input = keyboard();
  input.paused = false;
  input.readableFlowing = null;
  const output = surface();
  const terminal = createTerminal({ output, errorOutput: output, input, lifecycle: new EventEmitter(), term: 'xterm' });
  terminal.close();
  assert.equal(input.paused, true);
  assert.equal(input.listenerCount('data'), 0);
});

test('process exits naturally after closing terminal with an open stdin pipe', async () => {
  const script = `import { createTerminal } from ${JSON.stringify(new URL('./ralph-terminal.mjs', import.meta.url).href)};
    process.stdin.isTTY = true;
    process.stdin.setRawMode = () => {};
    process.stdout.isTTY = true;
    process.stdout.columns = 80; process.stdout.rows = 24;
    const terminal = createTerminal({ errorOutput: process.stdout, term: 'xterm' });
    terminal.close(); console.log('CLOSED');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  let timer;
  try {
    const code = await Promise.race([
      new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Terminal kept process alive')), 5000); }),
    ]);
    assert.equal(code, 0);
    assert.match(output, /CLOSED/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    child.stdin.destroy();
  }
});

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

test('milestone review is named while waiting for an agent with only service events', () => {
  const store = { phaseIndex: 0, phaseCount: 4, state: { iterationsUsed: 20 }, issue: null };
  const live = { activity: { kind: 'milestone-review', label: 'Ревью фазы: PR #227', startedMs: 0 },
    session: { startedMs: 1000, lastEventMs: 18000, active: true, turns: 0, toolResults: 0,
      maxTurns: 100, timeoutMs: 5400000, firstEventTimeoutMs: 300000, idleTimeoutMs: 600000 } };
  const snapshot = terminalSnapshot(store, { issue: null, startedMs: 0 }, 0, 223000, live);
  assert.equal(snapshot.issue, 'Ревью фазы: PR #227');
  assert.equal(snapshot.status, 'Ожидание агента');
  assert.match(snapshot.stage, /первый рабочий шаг/);
  assert.ok(snapshot.counters.some(line => line.includes('До остановки: 0:06:35')));
  assert.equal(snapshot.issueTime, '0:03:43');
  live.session.lastEventMs = null;
  assert.match(terminalSnapshot(store, { issue: null, startedMs: 0 }, 0, 2000, live).stage, /первое событие/);
});

test('between tasks shows live command purpose and elapsed time instead of missing issue', () => {
  const live = { activity: { kind: 'queue', label: 'Обновление очереди задач в GitHub', startedMs: 1000 },
    operation: { label: 'gh api', active: true, startedMs: 2000, timeoutMs: 300000 } };
  const snapshot = terminalSnapshot(null, null, 0, 12000, live);
  assert.equal(snapshot.issue, live.activity.label);
  assert.match(snapshot.stage, /Запрос GitHub/);
  assert.ok(snapshot.counters.some(line => line.includes('gh api')));
  assert.equal(snapshot.issueTime, '0:00:11');
});

test('preparing the next issue hides the previous issue and agent session', () => {
  const live = { activity: { kind: 'issue-preparation', label: 'Подготовка задачи #43', startedMs: 10000 },
    session: { startedMs: 1000, active: false, endedMs: 2000 } };
  const snapshot = terminalSnapshot({ state: {}, issue: { number: 42, title: 'Старая задача' } },
    { issue: 42, startedMs: 500 }, 0, 12000, live);
  assert.equal(snapshot.issue, 'Подготовка задачи #43');
  assert.equal(snapshot.counters.some(line => line.startsWith('Агент:')), false);
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
