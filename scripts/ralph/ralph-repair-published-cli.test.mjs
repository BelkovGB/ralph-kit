import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

for (const scenario of ['pushed', 'closing', 'closing-foreign', 'closing-staged']) {
  test(`published repair completes through real CLI: ${scenario}`, async () => {
    const root = mkdtempSync(path.join(executableTempDirectory, 'repair-published-'));
    const remote = mkdtempSync(path.join(executableTempDirectory, 'repair-remote-'));
    try {
      cpSync(path.join(sourceRoot, 'scripts'), path.join(root, 'scripts'), { recursive: true });
      cpSync(path.join(sourceRoot, '.agents'), path.join(root, '.agents'), { recursive: true });
      cpSync(path.join(sourceRoot, '.gitignore'), path.join(root, '.gitignore'));
      const configPath = path.join(root, '.agents/ralph.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      Object.assign(config, { active: true, agentCli: 'codex', githubAccount: null, syncBaseBranch: false,
        phases: [{ milestone: 'Repair', branch: 'phase' }], validationScripts: [], preflightScripts: [],
        validationArtifactPaths: [], stopAfterFirstIssue: true, autoApproveConfiguredIssues: true,
        review: { ...config.review, enabled: scenario === 'closing' },
        supervisor: { ...config.supervisor, enabled: true, agentCli: 'codex' } });
      writeFileSync(configPath, JSON.stringify(config));
      const target = path.join(root, 'scripts/ralph/ralph-acceptance.mjs');
      writeFileSync(target, readFileSync(target, 'utf8') + "\nexport const repairFixtureValue = 'broken';\n");
      const entry = path.join(root, 'scripts/ralph/ralph-loop.mjs');
      const workersPath = path.join(root, '.git/ralph-loop/fixture-workers.jsonl');
      let source = readFileSync(entry, 'utf8').replace("import path from 'node:path';",
        `import path from 'node:path';
import { randomUUID as createFixtureWorkerId } from 'node:crypto';
import { appendFileSync as recordFixtureWorker } from 'node:fs';
import { repairFixtureValue } from './ralph-acceptance.mjs';`);
      // Inject the initial failure, retaining real recovery, queue, validation,
      // staging, commit, push, close, lifecycle, state, and agent transport.
      source = source.replace('    verifyTools(config);', `
        if (lifecycle) {
          const store = activeStateStore();
          const phaseConfig = configForPhase(config, 0);
          const issue = { number: 12, title: 'Preserved product task', body: 'Preserve requirement', authorLogin: 'owner' };
          if (!store.issue) {
            const head = run('git', ['rev-parse', 'HEAD']).stdout;
            store.beginIssue(issue, head, ${['closing-foreign', 'closing-staged'].includes(scenario) ? "['user.txt']" : '[]'});
            store.updateIssue({ phase: '${scenario === 'pushed' ? 'pushed' : 'closing'}', commit: head, recoveryHead: head, pushedHead: head, reviewedCommit: head });
          }
          sendRalphWorkerMessage(lifecycle, 'prepared', { config: phaseConfig, stateRunId: store.state.runId });
          const fixtureKey = Symbol.for('ralph.publishedFixture.worker');
          const workerId = process[fixtureKey] ??= createFixtureWorkerId();
          recordFixtureWorker(${JSON.stringify(workersPath)}, JSON.stringify({ workerId, code: repairFixtureValue }) + '\\n', 'utf8');
          if (repairFixtureValue === 'broken') await observedRepairStep('${scenario === 'pushed' ? 'push' : 'close'}', () => { throw new Error('fixture external step failed'); });
          console.log('PUBLISHED_BUDGET=' + store.supervisorCalls + ' ITERATIONS=' + store.iterationsUsed);
          return await runContinuousLoop({ mode: '--run', config: phaseConfig, repository: 'owner/repo', milestone: { number: 1 },
            rules: 'Preserve requirement', stateStore: store, repositoryState: { clean: false } },
            { ...defaultActions(), openIssues: () => [] });
        }
        verifyTools(config);`);
      writeFileSync(entry, source);
      git(root, 'init', '--quiet', '-b', 'phase');
      git(root, 'config', 'user.name', 'Repair Test');
      git(root, 'config', 'user.email', 'repair@example.test');
      git(root, 'add', '.');
      git(root, 'commit', '--quiet', '-m', 'product completed\n\nRalph-Issue: #12');
      const before = git(root, 'rev-parse', 'HEAD');
      git(remote, 'init', '--quiet', '--bare');
      git(root, 'remote', 'add', 'origin', remote);
      git(root, 'push', '--quiet', '-u', 'origin', 'phase');
      if (['closing-foreign', 'closing-staged'].includes(scenario)) writeFileSync(path.join(root, 'user.txt'), 'preserve foreign work');
      if (scenario === 'closing-staged') git(root, 'add', 'user.txt');
      mkdirSync(path.join(root, '.git/ralph-loop'), { recursive: true });
      await withFakeCodex(`
        const fs = await import('node:fs');
        const args = process.argv.slice(2);
        if (args.includes('login') || args.includes('--version')) { console.log('authenticated'); process.exit(0); }
        const prompt = fs.readFileSync(0, 'utf8');
        if (args.includes('--output-last-message')) {
          const review = process.cwd().includes('ralph-repair-runtime-')
            ? { verdict: 'pass', reason: 'preserved requirements' }
            : { verdict: 'pass', summary: 'repair independently reviewed', findings: [] };
          fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(review));
        }
        else {
          if (!prompt.includes('Ты Lisa')) throw new Error('accepted repair unexpectedly started development');
          const target = 'scripts/ralph/ralph-acceptance.mjs';
          fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace("repairFixtureValue = 'broken'", "repairFixtureValue = 'fixed'"));
          console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict: 'resume', reason: 'fixed module' }) } }));
        }
      `, () => withFakeGh(`
        const fs = require('node:fs');
        const p = require('node:path');
        const joined = ghArguments.join(' ');
        const patchCount = p.join(__dirname, 'patch-count');
        if (joined.includes('/comments')) console.log(joined.includes('POST') ? '{}' : '[]');
        else if (joined.includes('PATCH')) { fs.appendFileSync(patchCount, 'x'); console.log(JSON.stringify({ state: 'closed' })); }
        else if (joined.includes('repos/owner/repo/issues/12')) console.log(JSON.stringify({ number: 12, title: 'Preserved product task', body: 'Preserve requirement',
          state: ${JSON.stringify(scenario === 'pushed' ? 'open' : 'closed')}, user: { login: 'owner' }, milestone: { number: 1 } }));
        else throw new Error(joined);
      `, async ({ directory }) => {
        const result = spawnSync(process.execPath, [entry, '--run', '--ui=plain'], {
          cwd: root, encoding: 'utf8', env: process.env, timeout: 60000, windowsHide: true,
        });
        const failed = ['closing-foreign', 'closing-staged'].includes(scenario);
        assert.equal(result.status, failed ? 1 : 0, result.stdout + result.stderr);
        // Windows can reuse a PID once the previous worker has exited.
        // Verify both worker starts and the module version each process loaded.
        const workers = readFileSync(workersPath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(workers.map(({ code }) => code), ['broken', 'fixed']);
        assert.equal(new Set(workers.map(({ workerId }) => workerId)).size, 2);
        if (scenario === 'closing-staged') {
          assert.equal(git(root, 'rev-parse', 'HEAD'), before);
          assert.equal(git(root, 'show', ':user.txt'), 'preserve foreign work');
        } else {
          assert.notEqual(git(root, 'rev-parse', 'HEAD'), before);
          assert.equal(git(root, 'rev-list', '--count', before + '..HEAD'), '1');
          assert.equal(git(root, 'show', '--format=', '--name-only', 'HEAD'), 'scripts/ralph/ralph-acceptance.mjs');
        }
        assert.match(result.stdout, /PUBLISHED_BUDGET=1 ITERATIONS=0/);
        const statePath = path.join(root, '.git/ralph-loop/state.json');
        if (failed) {
          const state = JSON.parse(readFileSync(statePath, 'utf8'));
          assert.equal(state.supervisorCalls, 1);
          assert.equal(state.iterationsUsed, 0);
          assert.equal(readFileSync(path.join(root, 'user.txt'), 'utf8'), 'preserve foreign work');
          assert.match(git(root, 'status', '--porcelain'), /user.txt/);
          assert.equal(state.lisaRepair.status, 'needs-human');
        } else {
          assert.equal(existsSync(statePath), false);
          assert.match(result.stdout, /ремонт завершён/);
          if (scenario === 'closing') assert.match(result.stdout, /Independent review for issue #12/);
          assert.equal(git(remote, 'rev-parse', 'refs/heads/phase'), git(root, 'rev-parse', 'HEAD'));
        }
        let patches = '';
        try { patches = readFileSync(path.join(directory, 'patch-count'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        assert.equal(patches.length, scenario === 'pushed' ? 1 : 0);
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });
}
