import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ralphRunOutcome, runRalphLifecycle, startRalphWorker, repairStepPassed } from './ralph-lifecycle.mjs';
import { acquireRunLock, initializePersistentLog } from './ralph-runtime.mjs';

for (const mode of ['split', 'plain']) {
  test(`worker logging preserves short events, details and severity in ${mode} mode`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ralph-worker-logging-'));
    const entry = path.join(root, 'worker.mjs');
    const lockPath = path.join(root, 'run.lock');
    const logPath = path.join(root, 'run.log');
    const lifecycleUrl = new URL('./ralph-lifecycle.mjs', import.meta.url).href;
    const runtimeUrl = new URL('./ralph-runtime.mjs', import.meta.url).href;
    const runnerUrl = new URL('./ralph-process-runner.mjs', import.meta.url).href;
    const events = [];
    const original = { log: console.log, error: console.error };
    let restore;
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'logging', runId: 'run' }));
      writeFileSync(entry, `
        import { receiveRalphWorkerStart, sendRalphWorkerMessage } from ${JSON.stringify(lifecycleUrl)};
        import { logDetail, logDetailError } from ${JSON.stringify(runtimeUrl)};
        import { run } from ${JSON.stringify(runnerUrl)};
        const context = await receiveRalphWorkerStart({ lockPath: process.argv[2] });
        console.log('SHORT_PROGRESS');
        console.error('SHORT_ERROR');
        logDetail('DETAIL_AGENT_TEXT\\nSECOND_DETAIL_LINE');
        logDetailError('DETAIL_ERROR');
        run('node', ['-e', "process.stdout.write('COMMAND_OUTPUT'); process.stderr.write('COMMAND_ERROR');"], { inherit: true });
        try { run('node', ['-e', "process.stdout.write('FAILED_COMMAND_OUTPUT'); process.stderr.write('FAILED_COMMAND_ERROR'); process.exit(1);"], { inherit: true }); } catch {}
        process.stdout.write('RAW_STDOUT\\n');
        process.stderr.write('RAW_STDERR\\n');
        logDetail('LAST_DETAIL' + 'x'.repeat(70000));
        await new Promise((resolve, reject) => sendRalphWorkerMessage(context, 'outcome',
          { outcome: { kind: 'completed' } }, error => error ? reject(error) : resolve()));
        context.finished = true;
        process.disconnect();
      `);
      console.log = (...args) => events.push({ channel: 'short', level: 'INFO', text: args.join(' ') });
      console.error = (...args) => events.push({ channel: 'short', level: 'ERROR', text: args.join(' ') });
      const sink = mode === 'split' ? {
        log: (level, text) => events.push({ channel: 'short', level, text }),
        detail: (level, text) => events.push({ channel: 'detail', level, text }),
      } : null;
      restore = initializePersistentLog(logPath, { mode: '--run' }, sink);
      const result = await startRalphWorker({ entry, args: [lockPath], root, token: 'logging', runId: 'run', lockPath,
        onStarted: workerPid => writeFileSync(lockPath, JSON.stringify({ pid: process.pid, workerPid, token: 'logging', runId: 'run' })) });
      assert.equal(result.kind, 'completed');
      const short = events.filter(event => event.channel === 'short');
      assert.ok(short.some(event => event.text === 'SHORT_PROGRESS' && event.level === 'INFO'));
      assert.ok(short.some(event => event.text === 'SHORT_ERROR' && event.level === 'ERROR'));
      assert.ok(short.some(event => event.text.includes('RAW_STDOUT') && event.level === 'INFO'));
      assert.ok(short.some(event => event.text.includes('RAW_STDERR') && event.level === 'ERROR'));
      assert.equal(short.some(event => /DETAIL_|COMMAND_OUTPUT|COMMAND_ERROR|Команда:/.test(event.text)), false);
      if (mode === 'split') {
        for (const [text, level] of [['DETAIL_AGENT_TEXT\nSECOND_DETAIL_LINE', 'INFO'], ['DETAIL_ERROR', 'ERROR'],
          ['COMMAND_OUTPUT', 'INFO'], ['COMMAND_ERROR', 'ERROR'],
          ['FAILED_COMMAND_OUTPUT', 'INFO'], ['FAILED_COMMAND_ERROR', 'ERROR']]) {
          assert.ok(events.some(event => event.channel === 'detail' && event.level === level && event.text === text), text);
        }
      }
      assert.equal(events.filter(event => event.channel === 'detail' && event.text === 'LAST_DETAIL' + 'x'.repeat(70000)).length, mode === 'split' ? 1 : 0);
      const log = readFileSync(logPath, 'utf8');
      for (const text of ['SHORT_PROGRESS', 'SHORT_ERROR', 'DETAIL_AGENT_TEXT', 'SECOND_DETAIL_LINE',
        'DETAIL_ERROR', 'COMMAND_OUTPUT', 'COMMAND_ERROR', 'FAILED_COMMAND_OUTPUT', 'FAILED_COMMAND_ERROR', 'RAW_STDOUT', 'RAW_STDERR', 'LAST_DETAIL']) assert.ok(log.includes(text), text);
      assert.match(log, /ERROR SHORT_ERROR/);
      assert.match(log, /ERROR DETAIL_ERROR/);
      assert.match(log, /ERROR COMMAND_ERROR/);
      assert.equal(log.match(/Ralph process started/g)?.length, 1);
    } finally {
      restore?.();
      console.log = original.log;
      console.error = original.error;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('worker exit and drained IPC settle even when aggregate close notification is lost', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-worker-close-race-'));
  const entry = path.join(root, 'worker.mjs');
  let timeout;
  try {
    writeFileSync(entry, `process.once('message', message => {
      process.send({ type: 'outcome', token: message.token, runId: message.runId, pid: process.pid,
        outcome: { kind: 'paused' } }, () => process.disconnect());
    });`);
    const result = await Promise.race([
      startRalphWorker({ entry, args: [], root, token: 'race', runId: 'run', onOutput() {},
        fork: (...args) => {
          const child = fork(...args);
          const emit = child.emit;
          child.emit = function(type, ...values) {
            // Reproduce the missing aggregate close notification independently
            // of OS scheduling. Real exit, pipes, IPC and outcome remain intact.
            return type === 'close' ? false : emit.call(this, type, ...values);
          };
          return child;
        } }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('worker wait did not settle')), 2000); }),
    ]);
    assert.equal(result.kind, 'paused');
  } finally { clearTimeout(timeout); rmSync(root, { recursive: true, force: true }); }
});

test('an outcome without confirmed IPC drain fails closed after the exit deadline', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-worker-drain-timeout-'));
  const entry = path.join(root, 'worker.mjs');
  try {
    writeFileSync(entry, `process.once('message', message => {
      process.send({ type: 'outcome', token: message.token, runId: message.runId, pid: process.pid,
        outcome: { kind: 'completed' } }, () => process.disconnect());
    });`);
    await assert.rejects(startRalphWorker({ entry, args: [], root, token: 'race', runId: 'run',
      drainTimeoutMs: 50, onOutput() {}, fork: (...args) => {
        const child = fork(...args);
        const emit = child.emit;
        child.emit = function(type, ...values) {
          return type === 'disconnect' ? false : emit.call(this, type, ...values);
        };
        return child;
      } }), /каналы вывода не закрылись/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lifecycle only repairs explicit repair-needed outcomes', async () => {
  for (const kind of ['completed', 'paused', 'needs-human']) {
    let repairs = 0;
    const result = await runRalphLifecycle({
      start: async () => ({ kind }), repair: async () => { repairs += 1; },
    });
    assert.equal(result.kind, kind);
    assert.equal(repairs, 0);
  }
  await assert.rejects(runRalphLifecycle({ start: async () => ({ kind: 'unknown' }) }), /outcome/);
});

test('a repaired worker is loaded in a fresh process through authenticated IPC', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-worker-'));
  const entry = path.join(root, 'worker.mjs');
  const pids = [];
  const source = (kind) => `process.on('message', message => {
    process.send({ type: 'outcome', token: message.token, runId: message.runId, pid: process.pid,
      outcome: { kind: '${kind}' } }, () => process.disconnect());
  });`;
  try {
    writeFileSync(entry, source('repair-needed'));
    const result = await runRalphLifecycle({
      start: () => startRalphWorker({ entry, args: [], root, token: 'token', runId: 'run',
        onStarted: (pid) => pids.push(pid), onOutput() {} }),
      repair: async () => { writeFileSync(entry, source('completed')); return { verdict: 'resume' }; },
    });
    assert.equal(result.kind, 'completed');
    assert.equal(pids.length, 2);
    assert.notEqual(pids[0], pids[1]);
    assert.match(readFileSync(entry, 'utf8'), /completed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lifecycle awaits closed worker before repair and starts fresh worker after acceptance', async () => {
  const events = [];
  let attempts = 0;
  const result = await runRalphLifecycle({
    start: async () => {
      events.push(`start:${++attempts}`);
      events.push(`close:${attempts}`);
      return attempts === 1 ? { kind: 'repair-needed', failure: { message: 'broken' } } : { kind: 'completed' };
    },
    repair: async () => { events.push('repair'); return { verdict: 'resume' }; },
  });
  assert.equal(result.kind, 'completed');
  assert.deepEqual(events, ['start:1', 'close:1', 'repair', 'start:2', 'close:2']);
});

test('stop during repair prevents restarting a worker', async () => {
  const controller = new AbortController();
  let starts = 0;
  const result = await runRalphLifecycle({
    signal: controller.signal,
    start: async () => { starts += 1; return { kind: 'repair-needed' }; },
    repair: async () => { controller.abort(); return { verdict: 'resume' }; },
  });
  assert.equal(result.kind, 'paused');
  assert.equal(starts, 1);
});

test('outcome preserves planned pauses and excludes human-only failures', () => {
  assert.equal(ralphRunOutcome({ verdict: 'pass' }).kind, 'completed');
  assert.equal(ralphRunOutcome({ verdict: 'stopped' }).kind, 'paused');
  assert.equal(ralphRunOutcome({ verdict: 'parked' }).kind, 'repair-needed');
  assert.equal(ralphRunOutcome(null, Object.assign(new Error('auth'), { code: 'RALPH_AGENT_AUTH' })).kind, 'needs-human');
  assert.equal(ralphRunOutcome(null, new Error('validation')).kind, 'repair-needed');
});

test('new error wording does not prove repair progress; only the matching completed step does', () => {
  const pending = { runId: 'run', phaseIndex: 0, issueNumber: 12, failureStep: 'validating' };
  assert.equal(repairStepPassed(pending, { failure: { message: 'different failure' } }), false);
  assert.equal(repairStepPassed(pending, { runId: 'run', phaseIndex: 0, issueNumber: 13, step: 'validating' }), false);
  assert.equal(repairStepPassed(pending, { runId: 'run', phaseIndex: 0, issueNumber: 12, step: 'working-tree' }), false);
  assert.equal(repairStepPassed(pending, { runId: 'run', phaseIndex: 0, issueNumber: 12, step: 'validating' }), true);
});

test('a living orphan worker keeps the run lock after its lifecycle owner exits', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-orphan-lock-'));
  try {
    const lock = path.join(root, 'run.lock');
    writeFileSync(lock, JSON.stringify({ pid: 100, workerPid: 101, token: 'old' }));
    assert.throws(() => acquireRunLock(lock, {}, { isProcessAlive: (pid) => pid === 101 }), /уже запущен/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stopping a live worker awaits process termination before returning', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-stop-worker-'));
  const entry = path.join(root, 'worker.mjs');
  const controller = new AbortController();
  let pid;
  try {
    writeFileSync(entry, "process.on('message', () => { console.log('ready'); setInterval(() => {}, 1000); });");
    const result = await startRalphWorker({ entry, args: [], root, token: 'stop', runId: 'run',
      signal: controller.signal, onStarted: (value) => { pid = value; },
      onOutput: () => controller.abort() });
    assert.equal(result.kind, 'paused');
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
