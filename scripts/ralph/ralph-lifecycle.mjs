import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { initializeLogForwarding, logDetail, logDetailError, terminateProcessTreeByPid } from './ralph-runtime.mjs';

/** The worker must close before start resolves; only this owner may restart it. */
export const humanOnlyFailureCodes = new Set([
  'RALPH_AGENT_AUTH', 'RALPH_AGENT_WRITE_ACCESS', 'RALPH_UNTRUSTED_ISSUE',
  'RALPH_CONTROL_PLANE_CHANGED', 'RALPH_RECOVERY_BLOCKED', 'RALPH_NEEDS_HUMAN',
]);

export function ralphRunOutcome(result, error = null) {
  if (error) return {
    kind: humanOnlyFailureCodes.has(error.code) ? 'needs-human' : 'repair-needed',
    failure: { message: error.message, code: error.code ?? null,
      step: error.ralphFailureStep ?? (error.code === 'RALPH_ITERATION_LIMIT' ? 'development' : null) },
  };
  if (result?.verdict === 'needs-human') return { kind: 'needs-human', reason: result.reason };
  if (result?.verdict === 'parked') return {
    kind: 'repair-needed', result,
    failure: { message: 'Задачи отложены после проверки.', code: 'RALPH_PARKED' },
  };
  return { kind: result?.verdict === 'pass' ? 'completed' : 'paused', result };
}

export async function runRalphLifecycle({ start, repair, signal }) {
  while (!signal?.aborted) {
    const outcome = await start();
    if (!['completed', 'paused', 'repair-needed', 'needs-human'].includes(outcome?.kind)) {
      throw new Error('Ralph worker returned an invalid outcome.');
    }
    if (signal?.aborted) break;
    if (outcome.kind !== 'repair-needed') return outcome;
    const answer = await repair(outcome);
    if (signal?.aborted) break;
    if (answer?.verdict !== 'resume') {
      return { kind: 'needs-human', reason: answer?.reason ?? 'Lisa не разрешила продолжение.' };
    }
  }
  return { kind: 'paused', reason: 'Прогон остановлен пользователем.' };
}

export function repairStepPassed(pending, event) {
  return Boolean(pending && event && pending.runId === event.runId &&
    pending.phaseIndex === event.phaseIndex && pending.issueNumber === event.issueNumber &&
    pending.failureStep === event.step);
}

export function startRalphWorker(options) {
  const { entry, root, token, runId, signal, onLive, onPrepared } = options;
  if (signal?.aborted) return Promise.resolve({ kind: 'paused' });
  return new Promise((resolve, reject) => {
    const child = (options.fork ?? fork)(entry, options.args ?? ['--run', '--ui=plain'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
      detached: process.platform !== 'win32', windowsHide: true,
    });
    let outcome;
    let protocolError;
    let killTimer;
    let drainTimer;
    let exited = false;
    let disconnected = false;
    let closedStreams = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return resolve({ kind: 'paused' });
      if (protocolError) return reject(protocolError);
      resolve(outcome ?? { kind: 'needs-human', reason: 'Ralph завершился без проверяемого результата; работа сохранена.' });
    };
    const finishWhenDrained = () => {
      if (exited && disconnected && closedStreams === 2) finish();
    };
    const stop = () => {
      terminateProcessTreeByPid(child.pid);
      killTimer = setTimeout(() => terminateProcessTreeByPid(child.pid, true), 1_000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', stop, { once: true });
    for (const [stream, output] of [[child.stdout, console.log], [child.stderr, console.error]]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => (options.onOutput ?? output)(chunk.replace(/\r?\n$/u, '')));
      stream.once('close', () => { closedStreams += 1; finishWhenDrained(); });
    }
    child.on('message', (message) => {
      if (!message || message.token !== token || message.runId !== runId || message.pid !== child.pid) {
        protocolError = new Error('Ralph: сообщение не соответствует владельцу прогона.');
        stop();
        return;
      }
      try {
        if (message.type === 'outcome') outcome = message.outcome;
        else if (message.type === 'live') onLive?.(message.snapshot);
        else if (message.type === 'prepared') onPrepared?.(message);
        else if (message.type === 'log') {
          if (typeof message.detail !== 'boolean' || typeof message.text !== 'string' ||
              !['INFO', 'ERROR'].includes(message.level)) throw new Error('Ralph: неверная запись журнала worker.');
          const output = message.detail
            ? message.level === 'ERROR' ? logDetailError : logDetail
            : options.onOutput ?? (message.level === 'ERROR' ? console.error : console.log);
          output(message.text);
        }
      } catch (error) { protocolError = error; stop(); }
    });
    child.once('error', (error) => { protocolError = error; });
    child.once('disconnect', () => { disconnected = true; finishWhenDrained(); });
    child.once('exit', () => {
      exited = true;
      // Do not depend only on ChildProcess's aggregate close notification:
      // IPC and pipe closure may race it. Keep a bounded, referenced drain
      // deadline so a missing notification cannot leave top-level await idle.
      drainTimer = setTimeout(() => {
        protocolError ??= new Error('Ralph: процесс завершился, но каналы вывода не закрылись; нужен оператор.');
        finish();
      }, options.drainTimeoutMs ?? 10_000);
      finishWhenDrained();
    });
    child.once('close', () => {
      // A failed spawn has no process and therefore no exit event.
      if (!child.pid && protocolError) finish();
      else finishWhenDrained();
    });
    try { options.onStarted?.(child.pid); } catch (error) { protocolError = error; stop(); return; }
    child.send({ type: 'start', token, runId, parentPid: process.pid,
      lockPath: options.lockPath, accepted: options.accepted ?? null }, (error) => {
      if (error && child.exitCode === null) { protocolError = error; stop(); }
    });
  });
}

export function receiveRalphWorkerStart({ timeoutMs = 10_000, lockPath } = {}) {
  if (!process.send) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Ralph: нет передачи владения прогоном.')), timeoutMs);
    process.once('message', (message) => {
      clearTimeout(timer);
      try {
        if (!lockPath || path.resolve(message.lockPath) !== path.resolve(lockPath)) throw new Error('Ralph: чужой путь блокировки.');
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (message.type !== 'start' || message.parentPid !== process.ppid ||
            lock.pid !== process.ppid || lock.workerPid !== process.pid ||
            lock.token !== message.token || lock.runId !== message.runId) {
          throw new Error('Ralph: неверная передача владения блокировкой.');
        }
        process.once('disconnect', () => {
          if (!message.finished) terminateProcessTreeByPid(process.pid, true);
        });
        message.restoreLog = initializeLogForwarding({
          log: (level, text) => sendRalphWorkerMessage(message, 'log', { level, text, detail: false }),
          detail: (level, text) => sendRalphWorkerMessage(message, 'log', { level, text, detail: true }),
        });
        resolve(message);
      } catch (error) { reject(error); }
    });
  });
}

export function sendRalphWorkerMessage(context, type, values = {}, callback) {
  if (process.connected) process.send({ ...values, type, token: context.token,
    runId: context.runId, pid: process.pid }, callback);
  else callback?.(new Error('Ralph: канал worker уже закрыт.'));
}
