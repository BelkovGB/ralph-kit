import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { run } from './ralph-process-runner.mjs';

function command(source, overrides = {}) {
  return new Promise((resolve, reject) => {
    const runner = spawn(process.execPath, [fileURLToPath(new URL('./ralph-command-runner.mjs', import.meta.url))], { stdio: 'pipe' });
    let stdout = '', stderr = '';
    runner.stdout.on('data', chunk => { stdout += chunk; });
    runner.stderr.on('data', chunk => { stderr += chunk; });
    runner.on('error', reject);
    runner.on('close', code => resolve({ code, stdout, stderr }));
    runner.stdin.end(JSON.stringify({ command: process.execPath, args: ['-e', source],
      cwd: process.cwd(), timeoutMs: 4000, idleTimeoutMs: 500, ...overrides }));
  });
}

test('silent command is stopped before its total deadline and retains output', async () => {
  const result = await command("console.log('started'); setInterval(() => {}, 1000)");
  assert.equal(result.code, 124);
  assert.match(result.stderr, /RALPH_COMMAND_IDLE_TIMEOUT:500/);
  assert.match(result.stdout, /started/);
});

test('stdout and stderr progress reset the idle deadline', async () => {
  const result = await command("let n=0; const t=setInterval(()=>{ (n%2?process.stdout:process.stderr).write('progress'); if(++n===12) clearInterval(t); },100)");
  assert.equal(result.code, 0);
  assert.match(result.stdout, /progress/);
  assert.match(result.stderr, /progress/);
});

test('progress cannot evade the total deadline', async () => {
  const result = await command("setInterval(()=>console.log('busy'),100)", { timeoutMs: 1300 });
  assert.equal(result.code, 124);
  assert.match(result.stderr, /RALPH_COMMAND_TIMEOUT:1300/);
});

test('orchestrator receives a distinct idle failure with retained command output', () => {
  assert.throws(() => run('node', ['-e', "console.log('checkpoint'); setInterval(()=>{},1000)"],
    { timeoutMs: 4000, idleTimeoutMs: 500 }), error => {
    assert.equal(error.code, 'RALPH_COMMAND_IDLE_TIMEOUT');
    assert.match(error.stdout, /checkpoint/);
    return true;
  });
});

test('idle timeout terminates descendants too', async () => {
  const result = await command("const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000)");
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(result.code, 124);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});
