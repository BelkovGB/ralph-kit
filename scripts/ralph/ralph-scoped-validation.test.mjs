import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./ralph-scoped-validation.mjs', import.meta.url));
const configFile = 'checks.json';
const config = {
  full: ['echo ran-full'],
  rules: [
    { paths: ['src/api/'], commands: ['echo ran-api', 'echo ran-shared'] },
    { paths: ['web/page.js'], commands: ['echo ran-browser', 'echo ran-shared'] },
  ],
};

function fixture(t, validation = config) {
  const cwd = mkdtempSync(join(tmpdir(), 'ralph-scoped-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const write = (file, value) => writeFileSync(join(cwd, file), value);
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Ralph Test');
  git('config', 'user.email', 'ralph@example.test');
  mkdirSync(join(cwd, 'src/api'), { recursive: true });
  mkdirSync(join(cwd, 'web'));
  write('src/api/route.js', 'before\n');
  write('web/page.js', 'before\n');
  write('.gitignore', '*.log\n');
  write(configFile, JSON.stringify(validation));
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const base = git('rev-parse', 'HEAD');
  return {
    cwd, git, write, base,
    run(scope = 'issue', sha = base) {
      return spawnSync(process.execPath, [cli, configFile], {
        cwd, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, RALPH_VALIDATION_SCOPE: scope, RALPH_VALIDATION_BASE_COMMIT: sha },
      });
    },
  };
}

function commandsRun(result, status = 0) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, result.stdout + result.stderr);
  return result.stdout.split(/\r?\n/u).filter((line) => line.startsWith('ran-'));
}

test('combines checks for committed, staged, unstaged and untracked changes', (t) => {
  const f = fixture(t);
  f.write('src/api/route.js', 'committed\n');
  f.git('commit', '-qam', 'change an API route');
  f.write('src/api/staged.js', 'staged\n');
  f.git('add', 'src/api/staged.js');
  f.write('web/page.js', 'unstaged\n');
  f.write('src/api/test with spaces.js', 'untracked\n');
  f.write('ignored.log', 'generated\n');
  const result = f.run();
  assert.deepEqual(commandsRun(result), ['ran-api', 'ran-shared', 'ran-browser']);
  assert.match(result.stdout, /src\/api\/test with spaces\.js/u);
  assert.doesNotMatch(result.stdout, /ignored\.log/u);
});

test('keeps a local change on the short path but runs full checks for an unknown or removed path', (t) => {
  const f = fixture(t);
  f.write('src/api/route.js', 'changed\n');
  assert.deepEqual(commandsRun(f.run()), ['ran-api', 'ran-shared']);
  f.write('web/config.js', 'unknown\n');
  assert.deepEqual(commandsRun(f.run()), ['ran-full']);
  rmSync(join(f.cwd, 'web/config.js'));
  f.write('.gitignore', '*.tmp\n');
  f.git('add', '.gitignore');
  f.write('.gitignore', '*.log\n');
  assert.deepEqual(commandsRun(f.run()), ['ran-full']);
  f.git('restore', '--staged', '.gitignore');
  renameSync(join(f.cwd, 'web/page.js'), join(f.cwd, 'src/api/page.js'));
  assert.deepEqual(commandsRun(f.run()), ['ran-full']);
});

test('runs full checks for an empty issue diff and rejects other scopes', (t) => {
  const f = fixture(t);
  assert.deepEqual(commandsRun(f.run()), ['ran-full']);
  f.write('src/api/route.js', 'changed\n');
  assert.deepEqual(commandsRun(f.run('phase'), 79), []);
  assert.deepEqual(commandsRun(f.run('baseSync'), 79), []);
});

test('validates inputs and never runs commands from an uncommitted rules file', (t) => {
  const f = fixture(t);
  f.write(configFile, JSON.stringify({ full: ['echo ran-untrusted'], rules: [] }));
  assert.deepEqual(commandsRun(f.run(), 79), []);
  assert.deepEqual(commandsRun(f.run('issue', 'bad-sha'), 79), []);
  assert.deepEqual(commandsRun(f.run('unknown'), 79), []);
  const invalid = fixture(t, { full: [], rules: [] });
  assert.deepEqual(commandsRun(invalid.run(), 79), []);
});

test('rejects a replacement rules file committed after the validation base', (t) => {
  const f = fixture(t);
  f.write(configFile, JSON.stringify({ full: ['echo ran-untrusted'], rules: [] }));
  f.git('commit', '-qam', 'replace validation rules');
  assert.deepEqual(commandsRun(f.run(), 79), []);
});

test('stops on a failed check and preserves a diagnostic exit code', (t) => {
  const f = fixture(t, {
    full: config.full,
    rules: [{ paths: ['web/'], commands: [`"${process.execPath}" -e "process.exit(76)"`, 'echo ran-after'] }],
  });
  f.write('web/page.js', 'changed\n');
  assert.deepEqual(commandsRun(f.run(), 76), []);
});

test('rejects shell chains that could hide a failed command', (t) => {
  const f = fixture(t, {
    full: ['node -e "process.exit(1)" & echo ran-after'],
    rules: config.rules,
  });
  assert.deepEqual(commandsRun(f.run(), 79), []);
});
