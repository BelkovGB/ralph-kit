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

// Each subprocess exercises a role and scope on a disposable repository.
// Running this suite inside a consumer's validation must not supply either.
const fixtureEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.toUpperCase().startsWith('RALPH_')));

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
        env: { ...fixtureEnvironment, RALPH_VALIDATION_SCOPE: scope, RALPH_VALIDATION_BASE_COMMIT: sha },
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

test('keeps a local change on the short path rejects unknown paths and scopes deletions', (t) => {
  const f = fixture(t);
  f.write('src/api/route.js', 'changed\n');
  assert.deepEqual(commandsRun(f.run()), ['ran-api', 'ran-shared']);
  f.write('web/config.js', 'unknown\n');
  assert.deepEqual(commandsRun(f.run(), 79), []);
  rmSync(join(f.cwd, 'web/config.js'));
  f.write('.gitignore', '*.tmp\n');
  f.git('add', '.gitignore');
  f.write('.gitignore', '*.log\n');
  assert.deepEqual(commandsRun(f.run(), 79), []);
  f.git('restore', '--staged', '.gitignore');
  renameSync(join(f.cwd, 'web/page.js'), join(f.cwd, 'src/api/page.js'));
  assert.deepEqual(commandsRun(f.run()), ['ran-api', 'ran-shared', 'ran-browser']);
});

test('rejects empty issue diffs and scopes phase and baseSync', (t) => {
  const f = fixture(t);
  assert.deepEqual(commandsRun(f.run(), 79), []);
  f.write('src/api/route.js', 'changed\n');
  assert.deepEqual(commandsRun(f.run('phase')), ['ran-api', 'ran-shared']);
  assert.deepEqual(commandsRun(f.run('baseSync')), ['ran-api', 'ran-shared']);
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

test('preview, emergency permission and once-per-commit acceptance', t => {
  const f = fixture(t);
  const run = (entry, args, env = {}) => spawnSync(process.execPath, [entry, ...args], {
    cwd: f.cwd, encoding: 'utf8', env: { ...fixtureEnvironment, ...env },
  });
  const accept = fileURLToPath(new URL('./ralph-final-acceptance.mjs', import.meta.url));
  f.write('prd.md', '# Example\n');
  f.git('add', 'prd.md');
  f.git('commit', '-qm', 'add example PRD');
  const sha = f.git('rev-parse', 'HEAD');
  f.write('src/api/route.js', 'changed');
  const plan = run(cli, ['--plan', configFile, sha, 'issue']);
  assert.deepEqual(commandsRun(plan), []);
  assert.match(plan.stdout, /echo ran-api/u);
  const emergency = ['--full', 'LisaEmergency', configFile, 'targeted checks passed, failure still unexplained'];
  for (const role of ['development', 'review', '']) {
    assert.deepEqual(commandsRun(run(cli, emergency, {RALPH_AGENT_ROLE:role}), 79), []);
  }
  assert.deepEqual(commandsRun(run(cli, emergency, {RALPH_AGENT_ROLE:'supervisor'})), ['ran-full']);
  assert.deepEqual(commandsRun(run(cli, emergency.slice(0,3), {RALPH_AGENT_ROLE:'supervisor'}),79), []);
  assert.deepEqual(commandsRun(run(cli, emergency, {RALPH_AGENT_ROLE:'supervisor', RALPH_VALIDATION_SCOPE:'phase'}),79), []);
  f.write('src/api/route.js', 'before\n');
  assert.deepEqual(commandsRun(run(accept, ['prd.md', configFile], {RALPH_AGENT_ROLE:'development'}),79), []);
  assert.deepEqual(commandsRun(run(accept, ['prd.md', configFile])), ['ran-full']);
  assert.deepEqual(commandsRun(run(accept, ['prd.md', configFile])), []);
  f.write(configFile, JSON.stringify({full:['echo ran-failing', '"'+process.execPath+'" -e "process.exit(7)"'], rules:config.rules}));
  f.git('commit','-qam','change acceptance fixture');
  assert.deepEqual(commandsRun(run(accept, ['prd.md', configFile]),7), ['ran-failing']);
  assert.deepEqual(commandsRun(run(accept, ['prd.md', configFile]),7), []);
});
