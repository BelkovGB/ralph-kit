import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fork, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTerminalHost } from './ralph-terminal-host.mjs';

function fixture() {
  const child = new EventEmitter();
  child.connected = true;
  child.messages = [];
  child.send = (message, callback) => {
    child.messages.push(message);
    queueMicrotask(() => {
      callback?.(null);
      if (message.type === 'init') child.emit('message', { type: 'ready' });
      if (message.type === 'close') { child.connected = false; child.emit('exit', 0); }
    });
    return true;
  };
  child.kill = () => child.emit('exit', 0);
  const output = { isTTY: true, text: '', write(text) { this.text += text; } };
  const input = { isTTY: true, setRawMode() {} };
  const lifecycle = new EventEmitter();
  lifecycle.pid = 123;
  lifecycle.kill = (pid, signal) => { lifecycle.stopped = [pid, signal]; };
  return { child, output, input, lifecycle };
}

test('host sends snapshots before commands and awaits renderer exit on close', async () => {
  const f = fixture();
  let now = 1;
  const host = await createTerminalHost({ ...f, errorOutput: f.output, term: 'xterm', fork: () => f.child,
    snapshot: () => ({ startedMs: now }) });
  now = 2;
  host.refresh();
  host.log('INFO', 'Checking queue');
  host.detail('INFO', 'git output');
  const snapshotPath = f.child.messages.find(message => message.type === 'init').snapshotPath;
  assert.equal(JSON.parse(readFileSync(snapshotPath, 'utf8')).startedMs, 2);
  assert.equal(f.child.messages.find(message => message.type === 'log').text, 'Checking queue');
  await host.close();
  await host.close();
  assert.equal(f.child.connected, false);
  assert.equal(existsSync(snapshotPath), false);
  assert.equal(f.lifecycle.listenerCount('SIGINT'), 0);
});

test('renderer interrupt closes renderer before forwarding parent signal', async () => {
  const f = fixture();
  await createTerminalHost({ ...f, errorOutput: f.output, term: 'xterm', fork: () => f.child,
    snapshot: () => ({}) });
  f.child.emit('message', { type: 'interrupt' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.lifecycle.stopped, [123, 'SIGINT']);
  assert.equal(f.child.connected, false);
});

test('non-TTY does not launch a renderer', async () => {
  assert.equal(await createTerminalHost({ output: { isTTY: false }, fork() { throw new Error('unexpected fork'); } }), null);
});

test('unexpected renderer exit restores output and leaves the run in plain mode', async () => {
  const f = fixture();
  const host = await createTerminalHost({ ...f, errorOutput: f.output, term: 'xterm', fork: () => f.child,
    snapshot: () => ({}) });
  f.child.connected = false;
  f.child.emit('exit', 1);
  host.log('INFO', 'Run continues');
  assert.ok(f.output.text.includes('Экран завершился'));
  assert.ok(f.output.text.includes('Run continues'));
  await host.close();
  assert.equal(f.lifecycle.listenerCount('SIGINT'), 0);
});

test('startup failure closes child and removes parent signal handlers', async () => {
  const f = fixture();
  const send = f.child.send;
  f.child.send = (message, callback) => {
    if (message.type === 'init') {
      queueMicrotask(() => { callback?.(); f.child.emit('message', { type: 'error', message: 'worker failed' }); });
      return true;
    }
    return send(message, callback);
  };
  await assert.rejects(createTerminalHost({ ...f, errorOutput: f.output, term: 'xterm', fork: () => f.child,
    snapshot: () => ({}) }), /worker failed/);
  assert.equal(f.child.connected, false);
  assert.equal(f.lifecycle.listenerCount('SIGINT'), 0);
});

test('real renderer clock keeps running while host is blocked in spawnSync', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-renderer-test-'));
  const preload = path.join(directory, 'tty.mjs');
  writeFileSync(preload, `process.stdout.isTTY = true; process.stderr.isTTY = true;
    process.stdout.columns = 80; process.stdout.rows = 24; process.env.TERM = 'xterm';`);
  const framesPath = path.join(directory, 'frames.log');
  const framesFd = openSync(framesPath, 'w');
  let child;
  let host;
  try {
    let startedMs = Date.now();
    let label = 'Начальный этап';
    const output = { isTTY: true, write() {} };
    host = await createTerminalHost({ output, errorOutput: output, term: 'xterm',
      snapshot: () => ({ startedMs, store: null, metrics: null, live: {
        activity: { kind: 'queue', label, startedMs },
      } }),
      fork: (module, args, options) => {
        // Родитель намеренно заблокирован: вывод читаем независимо от его
        // event loop, как это делает настоящий терминал.
        child = fork(module, args, { ...options, stdio: ['ignore', framesFd, framesFd, 'ipc'],
          execArgv: ['--import', pathToFileURL(preload).href] });
        return child;
      },
    });
    startedMs = Date.now();
    for (let index = 0; index < 35; index += 1) host.detail('INFO', 'x'.repeat(100000));
    label = 'Обновлённый этап';
    host.refresh();
    const result = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 3200)']);
    assert.equal(result.status, 0);
    // Проверяем кадры до возврата управления event loop родителя: иначе
    // отложенная отправка могла бы выдать обновление после блокировки за живое.
    const frames = readFileSync(framesPath, 'utf8');
    assert.match(frames, /Прогон: 0:00:0[1-3]/);
    assert.match(frames, /Обновлённый этап[\s\S]*?Прогон: 0:00:0[1-3]/);
    await host.close();
    assert.equal(child.exitCode, 0);
  } finally {
    await host?.close();
    closeSync(framesFd);
    rmSync(directory, { recursive: true, force: true });
  }
});
