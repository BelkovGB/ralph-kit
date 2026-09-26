import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

function inheritedCommand(source, options = {}) {
  const runnerUrl = new URL('./ralph-process-runner.mjs', import.meta.url).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { run } from ${JSON.stringify(runnerUrl)};
    try {
      run('node', ['-e', ${JSON.stringify(source)}], ${JSON.stringify({ inherit: true, timeoutMs: 10000, ...options })});
      process.stderr.write('RESULT:ok');
    } catch (error) {
      process.stderr.write('RESULT:' + JSON.stringify({ code: error.code, stdout: error.stdout?.slice(-200), stderr: error.stderr?.slice(-200) }));
      process.exitCode = 1;
    }
  `], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 });
}

test('inherited output streams past the capture buffer limit', () => {
  const result = inheritedCommand("const fs=require('node:fs'); const block=Buffer.alloc(1024*1024,120); for(let n=0;n<51;n++) fs.writeSync(1,block)");
  assert.equal(result.status, 0, result.stderr?.slice(-500));
  assert.match(result.stderr, /RESULT:ok/);
});

test('inherited timeout retains diagnostics and its distinct code', () => {
  const result = inheritedCommand("console.log('checkpoint'); setInterval(()=>{},1000)", { idleTimeoutMs: 500 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"code":"RALPH_COMMAND_IDLE_TIMEOUT"/);
  assert.match(result.stderr, /"stdout":"checkpoint"/);
});

test('inherited progress still reaches the total timeout', () => {
  const result = inheritedCommand("setInterval(()=>console.log('busy'),100)", { timeoutMs: 1300, idleTimeoutMs: 500 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"code":"RALPH_COMMAND_TIMEOUT"/);
  assert.match(result.stderr, /busy/);
});

test('status channel drains escaped bounded diagnostics when synchronous writes are short', async () => {
  // A successful write may consume fewer bytes than requested. Reproduce that
  // OS contract deterministically instead of depending on pipe capacity.
  const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const write = fs.writeSync; fs.writeSync = function(fd, value, ...args) {
      return write.call(fs, fd, fd === 3 && typeof value === 'string' ? value.slice(0, 4096) : value, ...args);
    }; syncBuiltinESMExports();`;
  const runner = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('./ralph-command-runner.mjs', import.meta.url))], { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
  let report = '';
  runner.stderr.resume();
  runner.stdio[3].setEncoding('utf8');
  runner.stdio[3].on('data', chunk => { report += chunk; });
  runner.stdin.end(JSON.stringify({ command: process.execPath,
    args: ['-e', "process.stdout.write('\\x01'.repeat(120000)); process.exitCode=7"],
    cwd: process.cwd(), timeoutMs: 10000, reportStatus: true }));
  const code = await new Promise((resolve, reject) => {
    runner.once('error', reject);
    runner.once('close', resolve);
  });
  assert.equal(code, 7);
  const status = JSON.parse(report);
  assert.equal(status.stdout, '\x01'.repeat(100000));
  assert.equal(status.stderr, '');
});

test('invalid status cannot mask a spawn error or supply non-string diagnostics', () => {
  const runnerUrl = new URL('./ralph-process-runner.mjs', import.meta.url).href;
  for (const [report, spawnError, expected] of [
    ['{', true, 'ENOBUFS'],
    ['{', false, 'RALPH_COMMAND_RUNNER_PROTOCOL'],
    [JSON.stringify({ stdout: [], stderr: '' }), false, 'RALPH_COMMAND_RUNNER_PROTOCOL'],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      childProcess.spawnSync = () => ({ status: 1, stdout: 'retained stdout', stderr: 'retained stderr',
        output: [null, null, null, ${JSON.stringify(report)}],
        error: ${spawnError} ? Object.assign(new Error('buffer limit'), { code: 'ENOBUFS' }) : undefined });
      syncBuiltinESMExports();
      const { run } = await import(${JSON.stringify(runnerUrl)});
      try { run('node', ['-e', ''], { inherit: true }); process.exitCode = 1; }
      catch (error) { process.stdout.write(JSON.stringify({ code: error.code, stdout: error.stdout, stderr: error.stderr })); }
    `], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`"code":"${expected}"`));
    assert.match(result.stdout, /retained stdout/);
    assert.match(result.stdout, /retained stderr/);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} stops the detached command group`, { skip: process.platform === 'win32' }, async (t) => {
    const runner = spawn(process.execPath, [fileURLToPath(new URL('./ralph-command-runner.mjs', import.meta.url))], { stdio: 'pipe' });
    let commandPid;
    t.after(() => {
      runner.kill('SIGKILL');
      if (commandPid) { try { process.kill(-commandPid, 'SIGKILL'); } catch {} }
    });
    runner.stdin.end(JSON.stringify({ command: process.execPath,
      args: ['-e', 'console.log(process.pid); setInterval(()=>{},1000)'], cwd: process.cwd(), timeoutMs: 10000 }));
    commandPid = await new Promise((resolve, reject) => {
      runner.once('error', reject);
      runner.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
    });
    assert.ok(commandPid > 0);
    const exited = new Promise(resolve => runner.once('exit', resolve));
    runner.kill(signal);
    await exited;
    assert.throws(() => process.kill(commandPid, 0), error => error.code === 'ESRCH');
  });
}
