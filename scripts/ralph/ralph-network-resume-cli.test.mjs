import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { executableTempDirectory, withFakeCodex, withFakeGh } from './ralph-test-support.mjs';

const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function node(root, ...args) {
  return spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' },
    timeout: 60_000, windowsHide: true,
  });
}

function prepareFixture(root, { trackValidation = false, transport } = {}) {
  for (const name of ['scripts', '.agents', '.gitignore']) {
    cpSync(path.join(sourceRoot, name), path.join(root, name), { recursive: true });
  }
  const configPath = path.join(root, '.agents', 'ralph.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  Object.assign(config, { active: true, agentCli: 'codex', githubAccount: null, stopAfterFirstIssue: true,
    phases: [{ branch: 'phase', milestone: 'Recovery' }, { branch: 'follow-up', milestone: 'Follow-up' }],
    runtime: { ...config.runtime, networkRetryAttempts: 1 },
  });
  if (trackValidation) {
    config.preflightScripts = ['node fixture-validation.mjs preflight'];
    config.validationScripts = ['node fixture-validation.mjs validation'];
    writeFileSync(path.join(root, 'fixture-validation.mjs'), `
      import { appendFileSync } from 'node:fs';
      appendFileSync('.git/ralph-loop/fixture-validation', process.argv[2] + '\\n');
    `);
  }
  if (transport) {
    const transportPath = path.join(root, 'scripts', 'ralph', 'ralph-git.mjs');
    const source = readFileSync(transportPath, 'utf8');
    // Use a real bare Git repository for writes while keeping the fixture's
    // canonical GitHub origin visible to local recovery and scope checks.
    const fixture = source.replace('function networkRemote(config) {',
      `function networkRemote(config) { return ${JSON.stringify(transport)}; /* fixture */`)
      .replace("['push', '--set-upstream', 'origin', expectedHead", `['push', '--set-upstream', ${JSON.stringify(transport)}, expectedHead`);
    assert.notEqual(fixture, source);
    writeFileSync(transportPath, fixture);
  }
  writeFileSync(configPath, JSON.stringify(config));
  git(root, 'init', '--quiet', '-b', 'phase');
  git(root, 'config', 'user.name', 'Ralph fixture');
  git(root, 'config', 'user.email', 'fixture@example.test');
  git(root, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Fixture base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', base);
  return base;
}

function prepareSavedIssue(root, base, committed) {
  writeFileSync(path.join(root, 'product.txt'), 'The local implementation.\n');
  git(root, 'add', 'product.txt');
  git(root, 'commit', '--quiet', '-m', 'Product change\n\nRalph-Issue: #12');
  const head = git(root, 'rev-parse', 'HEAD');
  const seed = node(root, '--input-type=module', '-e', `
    import { configForPhase, loadConfig } from './scripts/ralph/ralph-config.mjs';
    import { createStateStore } from './scripts/ralph/ralph-state-store.mjs';
    const store = createStateStore(configForPhase(loadConfig(), 0), '--run');
    const issue = { number: 12, title: 'Saved task', body: 'Keep the local result.', authorLogin: 'owner',
      url: 'https://github.com/owner/repo/issues/12' };
    store.approveIssueSnapshot(12, { title: issue.title, body: issue.body });
    store.beginIssue(issue, ${JSON.stringify(base)});
    store.updateIssue(${JSON.stringify(committed
      ? { phase: 'committed', commit: head, recoveryHead: head }
      : { phase: 'working-tree' })});
  `);
  assert.equal(seed.status, 0, seed.stdout + seed.stderr);
  return head;
}

const codex = `
  const args = process.argv.slice(2);
  if (args.includes('login') || args.includes('--version')) { console.log('authenticated'); process.exit(0); }
  const index = args.indexOf('--output-last-message');
  if (index < 0) throw new Error('Recovery unexpectedly started development.');
  const fs = await import('node:fs');
  fs.appendFileSync('.git/ralph-loop/fixture-review', 'review\\n');
  fs.writeFileSync(args[index + 1], JSON.stringify({ verdict: 'pass', summary: 'Local review passed', findings: [] }));
`;

function github(scenario) {
  return `
    const fs = require('node:fs');
    const p = require('node:path');
    const command = ghArguments.join(' ');
    fs.appendFileSync(p.join(__dirname, 'requests'), command + String.fromCharCode(10));
    if (command === '--version') console.log('gh fixture');
    else if (${['moved issue', 'foreign issue'].includes(scenario)} && command === 'api repos/owner/repo/issues/12') {
      console.log(JSON.stringify({ number: 12, title: 'Saved task', body: 'Keep the local result.',
        state: 'open', user: { login: 'owner' },
        html_url: ${JSON.stringify(scenario === 'foreign issue' ? 'https://enterprise.example/owner/repo/issues/12' : 'https://github.com/owner/repo/issues/12')},
        milestone: ${JSON.stringify(scenario === 'moved issue' ? { number: 2, title: 'Follow-up' } : { number: 1, title: 'Recovery' })} }));
    }
    else if (!${scenario === 'read-only check'}) {
      process.stderr.write('error connecting to api.github.com: dial tcp: lookup api.github.com: no such host'); process.exit(1);
    }
    else if (command.startsWith('auth status')) console.log('authenticated');
    else if (command.startsWith('repo view')) console.log(JSON.stringify({ nameWithOwner: 'owner/repo' }));
    else if (command === 'api repos/owner/repo --jq .permissions') console.log(JSON.stringify({ pull: true, push: false }));
    else if (command.includes('repos/owner/repo/milestones')) console.log(JSON.stringify([
      { title: 'Recovery', number: 1 }, { title: 'Follow-up', number: 2 },
    ]));
    else if (command.includes('repos/owner/repo/issues')) console.log(JSON.stringify([
      { number: 12, title: 'A readable issue', body: '', user: { login: 'owner' } },
    ]));
    else throw new Error(command);
  `;
}

for (const scenario of ['read-only check', 'offline check', 'offline resume', 'moved issue', 'foreign issue', 'manual acceptance']) {
  test(`local preparation works without GitHub write access: ${scenario}`, async () => {
    const root = mkdtempSync(path.join(executableTempDirectory, 'ralph-local-resume-'));
    try {
      const base = prepareFixture(root);
      const head = scenario.endsWith('check') ? base : prepareSavedIssue(root, base, scenario !== 'manual acceptance');
      await withFakeCodex(codex, () => withFakeGh(github(scenario), async ({ directory }) => {
        const entry = 'scripts/ralph/ralph-loop.mjs';
        const args = scenario.endsWith('check') ? ['--check'] : scenario === 'manual acceptance'
          ? ['--accept-manual-commit', head] : ['--run', '--ui=plain'];
        const result = node(root, entry, ...args);
        const output = result.stdout + result.stderr;
        assert.equal(result.status, ['moved issue', 'foreign issue'].includes(scenario) ? 1 : 0, output);
        const log = path.join(directory, 'requests');
        const requests = existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/u).filter(Boolean) : [];
        if (scenario.endsWith('check')) {
          assert.match(result.stdout, /Рабочее дерево: чистое/u);
          if (scenario === 'read-only check') {
            assert.match(result.stdout, /Следующая issue: #12 A readable issue/u);
            assert.match(result.stdout, /Публикация: нет права записи/u);
            assert.equal(requests.filter((command) => command.includes('/milestones')).length, 1);
          } else {
            assert.match(result.stdout, /Очередь GitHub недоступна/u);
            assert.doesNotMatch(result.stdout, /Открытых issues нет/u);
          }
        } else {
          const state = JSON.parse(readFileSync(path.join(root, '.git', 'ralph-loop', 'state.json'), 'utf8'));
          assert.equal(state.issue.commit, head);
          assert.equal(state.issue.pendingPublishHead, head);
          if (scenario === 'offline resume') {
            assert.match(output, new RegExp(`коммит ${head} сохранён локально`, 'u'));
            assert.match(output, /Ожидается push/u);
            assert.equal(state.issue.reviewReceipt.result.verdict, 'pass');
            assert.deepEqual(requests, ['api repos/owner/repo/issues/12']);
          } else if (['moved issue', 'foreign issue'].includes(scenario)) {
            assert.match(output, scenario === 'moved issue' ? /milestone изменились перед публикацией/u
              : /ответ GitHub относится к другой задаче/u);
            assert.equal(state.issue.reviewReceipt.result.verdict, 'pass');
            assert.deepEqual(requests, ['api repos/owner/repo/issues/12']);
          } else {
            assert.match(result.stdout, /Ручной коммит принят/u);
            assert.deepEqual(requests, []);
          }
        }
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('cold publication retry after DNS recovery runs only the external steps', async () => {
  const root = mkdtempSync(path.join(executableTempDirectory, 'ralph-cold-publication-'));
  const remote = mkdtempSync(path.join(executableTempDirectory, 'ralph-publication-remote-'));
  try {
    git(remote, 'init', '--quiet', '--bare');
    const base = prepareFixture(root, { trackValidation: true, transport: remote });
    const head = prepareSavedIssue(root, base, true);
    const runtime = path.join(root, '.git', 'ralph-loop');
    const statePath = path.join(runtime, 'state.json');
    const args = ['scripts/ralph/ralph-loop.mjs', '--run', '--ui=plain'];
    const gh = `
      const fs = require('node:fs');
      const path = require('node:path');
      const command = ghArguments.join(' ');
      const issuePath = path.join(__dirname, 'issue-state');
      if (!fs.existsSync(path.join(__dirname, 'online'))) {
        process.stderr.write('error connecting to api.github.com: dial tcp: lookup api.github.com: no such host');
        process.exit(1);
      }
      if (command === 'api repos/owner/repo/issues/12') console.log(JSON.stringify({
        number: 12, title: 'Saved task', body: 'Keep the local result.', user: { login: 'owner' },
        html_url: 'https://github.com/owner/repo/issues/12', milestone: { number: 1, title: 'Recovery' },
        state: fs.existsSync(issuePath) ? 'closed' : 'open',
      }));
      else if (command.includes('/comments')) console.log(command.includes('POST') ? '{}' : '[]');
      else if (command.includes('PATCH') && command.includes('/issues/12')) {
        fs.writeFileSync(issuePath, 'closed'); console.log(JSON.stringify({ state: 'closed' }));
      } else throw new Error(command);
    `;
    await withFakeCodex(codex, () => withFakeGh(gh, async ({ directory }) => {
      const paused = node(root, ...args);
      assert.equal(paused.status, 0, paused.stdout + paused.stderr);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(state.issue.publicationCheckpoint.step, 'push');
      const log = path.join(runtime, 'fixture-validation');
      const reviewLog = path.join(runtime, 'fixture-review');
      const checks = readFileSync(log, 'utf8');
      assert.match(checks, /preflight/u);
      assert.match(checks, /validation/u);
      assert.equal(readFileSync(reviewLog, 'utf8'), 'review\n');

      writeFileSync(path.join(directory, 'online'), 'yes');
      const resumed = node(root, ...args);
      assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
      assert.equal(readFileSync(log, 'utf8'), checks);
      assert.equal(readFileSync(reviewLog, 'utf8'), 'review\n');
      assert.equal(git(remote, 'rev-parse', 'refs/heads/phase'), head);
      assert.equal(readFileSync(path.join(directory, 'issue-state'), 'utf8'), 'closed');
      assert.equal(existsSync(statePath), false);
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
