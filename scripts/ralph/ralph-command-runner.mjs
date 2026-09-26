#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { createWriteStream } from 'node:fs';

let requestText = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  requestText += chunk;
}

let request;
try {
  request = JSON.parse(requestText);
} catch (error) {
  process.stderr.write(`RALPH_COMMAND_RUNNER_INVALID_REQUEST: ${error.message}\n`);
  process.exit(125);
}

const child = spawn(request.command, request.args, {
  cwd: request.cwd,
  ...(request.env === undefined ? {} : { env: request.env }),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  detached: process.platform !== 'win32',
});
let settled = false;
let timedOut = false;
let forceExitTimer;
let idleTimer;
let interruptedSignal;
let timeoutMarker;
const outputTails = { stdout: '', stderr: '' };
let finishing = false;

function finish(code, force = false) {
  if (finishing) return;
  finishing = true;
  process.exitCode = code;
  if (!request.reportStatus) {
    if (force) process.exit(code);
    return;
  }
  const status = createWriteStream(null, { fd: 3, autoClose: true });
  const completed = () => { if (force) process.exit(code); };
  status.once('error', completed);
  status.once('finish', completed);
  status.end(JSON.stringify({ ...outputTails, timeoutMarker, interruptedSignal }));
}

// In inherited mode stdout/stderr stream directly to the terminal. A separate
// bounded status pipe preserves timeout identity and diagnostics for the parent.
if (request.reportStatus) {
  for (const name of ['stdout', 'stderr']) {
    child[name].setEncoding('utf8');
    child[name].on('data', chunk => {
      outputTails[name] = (outputTails[name] + chunk).slice(-100_000);
    });
  }
}

function expire(marker) {
  if (settled || timedOut) return;
  timedOut = true;
  timeoutMarker = marker;
  clearTimeout(idleTimer);
  process.stderr.write(`${marker}\n`);
  killTree();
  forceExitTimer = setTimeout(() => finish(124, true), 10_000);
}

function noteProgress() {
  clearTimeout(idleTimer);
  if (!timedOut && Number.isInteger(request.idleTimeoutMs) && request.idleTimeoutMs > 0) {
    idleTimer = setTimeout(() => expire(`RALPH_COMMAND_IDLE_TIMEOUT:${request.idleTimeoutMs}`), request.idleTimeoutMs);
  }
}
child.stdout.on('data', noteProgress);
child.stderr.on('data', noteProgress);
noteProgress();

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on('error', (error) => {
  if (error.code !== 'EPIPE') {
    process.stderr.write(`RALPH_COMMAND_STDIN_ERROR: ${error.message}\n`);
  }
});
child.stdin.end(request.input);

// Похоже на terminateProcessTreeByPid из ralph-runtime.mjs, но объединять их
// нельзя: этот shim
// стартует на каждую внешнюю команду, поэтому лишний импорт — время запуска на
// каждый git, gh и вызов CLI агента.
function killTree() {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Дочерний процесс уже завершён.
  }
}

const timeout = setTimeout(() => {
  expire(`RALPH_COMMAND_TIMEOUT:${request.timeoutMs}`);
}, request.timeoutMs);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (settled || interruptedSignal) return;
    interruptedSignal = signal;
    clearTimeout(timeout);
    clearTimeout(idleTimer);
    killTree();
    forceExitTimer = setTimeout(() => finish(signal === 'SIGINT' ? 130 : 143, true), 10_000);
  });
}

child.once('error', (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  clearTimeout(idleTimer);
  clearTimeout(forceExitTimer);
  process.stderr.write(
    `RALPH_COMMAND_RUNNER_LAUNCH_ERROR:${error.code ?? 'UNKNOWN'}: ${error.message}\n`,
  );
  finish(125);
});

child.once('close', (code, signal) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  clearTimeout(idleTimer);
  clearTimeout(forceExitTimer);
  if (interruptedSignal) {
    finish(interruptedSignal === 'SIGINT' ? 130 : 143);
    return;
  }
  if (timedOut) {
    finish(124);
    return;
  }
  if (signal) {
    process.stderr.write(`RALPH_COMMAND_SIGNAL:${signal}\n`);
    finish(1);
    return;
  }
  finish(code ?? 1);
});
