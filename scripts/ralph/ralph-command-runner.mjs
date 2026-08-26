#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

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
});
let settled = false;
let timedOut = false;
let forceExitTimer;

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on('error', (error) => {
  if (error.code !== 'EPIPE') {
    process.stderr.write(`RALPH_COMMAND_STDIN_ERROR: ${error.message}\n`);
  }
});
child.stdin.end(request.input);

// Похоже на terminateProcessTreeByPid из ralph-runtime.mjs, но объединять их
// нельзя по двум причинам. Здесь дочерний процесс запускается без detached, то
// есть своей группы у него нет и kill(-pid) на POSIX промахнётся. И этот shim
// стартует на каждую внешнюю команду, поэтому лишний импорт — время запуска на
// каждый git, gh и npm.
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
    process.kill(child.pid, 'SIGKILL');
  } catch {
    // Дочерний процесс уже завершён.
  }
}

const timeout = setTimeout(() => {
  timedOut = true;
  killTree();
  forceExitTimer = setTimeout(() => process.exit(124), 10_000);
}, request.timeoutMs);

child.once('error', (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  clearTimeout(forceExitTimer);
  process.stderr.write(
    `RALPH_COMMAND_RUNNER_LAUNCH_ERROR:${error.code ?? 'UNKNOWN'}: ${error.message}\n`,
  );
  process.exitCode = 125;
});

child.once('close', (code, signal) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  clearTimeout(forceExitTimer);
  if (timedOut) {
    process.stderr.write(`RALPH_COMMAND_TIMEOUT:${request.timeoutMs}\n`);
    process.exitCode = 124;
    return;
  }
  if (signal) {
    process.stderr.write(`RALPH_COMMAND_SIGNAL:${signal}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
