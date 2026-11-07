import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stateResponse } from './ralph-gui-data.mjs';
import { readLatestRunStopReportPath, writeRunStopReport } from './ralph-run-stop-report.mjs';
import { executableTempDirectory, withFakeCodex, withFakeGh } from './ralph-test-support.mjs';
import { KIT_VERSION } from './ralph-version.mjs';

const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
const branch = 'phase-PRIVATE_BRANCH';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const fakeGithub = `
  const fs = require('node:fs');
  const path = require('node:path');
  const db = path.join(__dirname, 'issue.json');
  const issue = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')) : {
    number: 12, title: 'PRIVATE_TITLE', body: 'PRIVATE_PROMPT ghp_TEST_SECRET', state: 'open',
    user: { login: 'owner' }, author_association: 'OWNER', milestone: { number: 1 },
    html_url: 'https://private.example.test/issues/12', updated_at: '2000-01-01T00:00:00Z', labels: [],
  };
  const api = 'repos/owner/repo';
  const joined = ghArguments.join(' ');
  const [command, option, method, resource] = ghArguments;
  let response;
  if (joined === '--version' || joined === 'auth status') response = 'fixture gh';
  else if (joined === 'repo view --json nameWithOwner') response = { nameWithOwner: 'owner/repo' };
  else if (joined === 'api ' + api + ' --jq .permissions') response = { push: true };
  else if (command === 'pr' && option === 'list') response = [];
  else if (joined === 'api ' + api + '/issues/12') response = issue;
  else if (resource === api + '/milestones' && method === 'GET') response = [{ number: 1, title: 'Fixture', state: 'open' }];
  else if (resource === api + '/issues' && method === 'GET') response = [issue];
  else if (resource === api + '/issues/12/comments' && method === 'GET') response = [];
  else if (resource === api + '/issues/12/comments' && method === 'POST') response = { id: 1 };
  else if (resource === api + '/issues/12' && method === 'PATCH') {
    Object.assign(issue, JSON.parse(fs.readFileSync(0, 'utf8')));
    fs.writeFileSync(db, JSON.stringify(issue));
    response = issue;
  } else throw new Error(joined);
  console.log(typeof response === 'string' ? response : JSON.stringify(response));
`;

test('real --run reports both review parks and Lisa restart in one safe file', async () => {
  const workspace = mkdtempSync(path.join(executableTempDirectory, 'ralph-stop-'));
  const root = path.join(workspace, 'project');
  const remote = path.join(workspace, 'origin.git');
  const runtime = path.join(root, '.git/ralph-loop');
  const statePath = path.join(runtime, 'state.json');
  const configPath = path.join(root, '.agents/ralph.config.json');
  const entry = path.join(root, 'scripts/ralph/ralph-loop.mjs');
  const reports = path.join(runtime, 'run-stop-reports');
  const launch = () => spawnSync(process.execPath, [entry, '--run', '--ui=plain'], {
    cwd: root, encoding: 'utf8', timeout: 90_000, windowsHide: true,
  });

  try {
    cpSync(path.join(sourceRoot, 'scripts'), path.join(root, 'scripts'), { recursive: true });
    cpSync(path.join(sourceRoot, '.agents'), path.join(root, '.agents'), { recursive: true });
    cpSync(path.join(sourceRoot, '.gitignore'), path.join(root, '.gitignore'));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    Object.assign(config, { active: true, agentCli: 'codex', githubAccount: null, baseBranch: 'main',
      syncBaseBranch: false, phases: [{ milestone: 'Fixture', branch }], stopAfterFirstIssue: false,
      maxIterations: 8, maxReviewFixAttempts: 2, autoApproveConfiguredIssues: true,
      trustedIssueAuthors: ['owner'], reviewSeverityFloor: 'P1', validationScripts: ['node validate.mjs'],
      review: { ...config.review, enabled: true }, supervisor: { ...config.supervisor, enabled: true,
        agentCli: 'codex', maxInterventions: 1, maxAdditionalIterations: 2 } });
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(path.join(root, 'product.mjs'), 'export const PRIVATE_PRODUCT = 0;\n');
    writeFileSync(path.join(root, 'validate.mjs'), "import { PRIVATE_PRODUCT } from './product.mjs';\nif (PRIVATE_PRODUCT === 1) process.exitCode = 1;\n");
    git(root, 'init', '--quiet', '--template=', '-b', 'main');
    git(root, 'config', 'user.name', 'Ralph fixture');
    git(root, 'config', 'user.email', 'ralph@example.test');
    git(root, 'config', 'commit.gpgsign', 'false');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'fixture');
    const base = git(root, 'rev-parse', 'HEAD');
    git(workspace, 'init', '--quiet', '--template=', '--bare', remote);
    git(root, 'switch', '--quiet', '-c', branch);
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '--quiet', '-u', 'origin', 'main', branch);
    mkdirSync(runtime);

    await withFakeCodex(`
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      const args = process.argv.slice(2);
      if (args.includes('login') || args.includes('--version')) { console.log('fixture codex'); process.exit(0); }
      const prompt = readFileSync(0, 'utf8');
      const output = args[args.indexOf('--output-last-message') + 1];
      const message = (text) => console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
      if (prompt.startsWith('Проверь ремонт Lisa независимо.')) {
        writeFileSync(output, JSON.stringify({ verdict: 'pass', reason: 'PRIVATE_LISA_REVIEW' }));
      } else if (args.includes('--output-last-message')) {
        const countPath = path.join(${JSON.stringify(runtime)}, 'fixture-review-count');
        const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1;
        writeFileSync(countPath, String(count));
        const findings = Array.from({ length: count === 1 ? 3 : 1 }, (_, index) => ({
          severity: 'P1', title: 'PRIVATE_FINDING ' + index, body: 'PRIVATE_REVIEW_BODY', file: 'product.mjs', line: 1,
        }));
        writeFileSync(output, JSON.stringify({ verdict: 'fail', summary: 'PRIVATE_REVIEW', findings }));
      } else {
        const source = readFileSync('product.mjs', 'utf8');
        writeFileSync('product.mjs', source.replace(/\\d+/u, (n) => String(Number(n) + 1)));
        message(prompt.startsWith('Ты Lisa')
          ? JSON.stringify({ verdict: 'resume', reason: 'PRIVATE_LISA' })
          : 'fix: update PRIVATE_PRODUCT');
      }
    `, () => withFakeGh(fakeGithub, async () => {
      const result = launch();
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /лимит вмешательств|бюджет вызовов/iu);
      assert.equal(readFileSync(path.join(runtime, 'fixture-review-count'), 'utf8'), '3');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(state.status, 'active');
      assert.equal(state.lisaRepair.status, 'needs-human');
      const localHead = git(root, 'rev-parse', 'HEAD');
      assert.notEqual(localHead, base);
      assert.equal(git(remote, 'rev-parse', 'refs/heads/' + branch), base);
      assert.equal(state.issue.reviewedCommit, localHead);
      assert.equal(state.issue.reviewReceipt.head, localHead);
      assert.equal(state.issue.reviewReceipt.result.verdict, 'fail');
      assert.equal(state.issue.pendingPublishHead, localHead);

      const names = readdirSync(reports);
      assert.equal(names.length, 1);
      const reportPath = path.join(reports, names[0]);
      assert.ok(result.stdout.includes(reportPath), result.stdout);
      const report = readFileSync(reportPath, 'utf8');
      for (const fact of [state.runId, KIT_VERSION, state.issue.reviewedCommit, 'needs-human', 'active', 'review-failed', '3 → 1']) {
        assert.ok(report.includes(fact), fact);
      }
      assert.match(report, /\| 1 \| 1 \| #12 \| 3 → 1 \| да \|/u);
      assert.match(report, /\| 2 \| 1 \| #12 \| 1 \| да \|/u);
      assert.ok(report.includes('Исчерпан сохранённый бюджет вызовов Lisa.'));
      assert.ok(report.includes('`needs-human`, код выхода `1`'));
      assert.ok(report.includes('`state.status` — `active`'));
      assert.ok(report.includes('Ремонт Lisa принят — да. Worker после ремонта запущен — да'));
      assert.ok(report.includes('Шаг отказа — `review-failed`. Восстановление шага подтверждено — нет'));
      assert.ok(report.includes('Вызовы Lisa за этот запуск — 1. Из бюджета фазы — 1 из 1'));
      assert.ok(report.includes('Отказы тестов по отложенным задачам за запуск — 1.'));
      assert.ok(report.includes('Подтверждённый HEAD ветки при отправке коммита — нет данных'));
      assert.ok(report.includes(`Локальный HEAD, ожидающий публикации — \`${localHead}\``));
      assert.match(report, /Длительность — \d+ мс/u);
      assert.doesNotMatch(report, /PRIVATE_|ghp_TEST_SECRET|private\.example\.test|product\.mjs|owner\/repo/u);
      assert.ok(!report.includes(workspace));
      const guiState = () => stateResponse({ runtimeDir: runtime, configPath });
      const gui = guiState();
      assert.equal(gui.running, false);
      assert.equal(gui.run, null);
      assert.equal(gui.stopReportPath, reportPath);

      // Simulate the operator clearing the repair hold. The state and runId remain.
      writeFileSync(statePath, JSON.stringify({ ...state, lisaRepair: null }));
      const retry = launch();
      assert.equal(retry.status, 1, retry.stdout + retry.stderr);
      const resumedState = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(resumedState.runId, state.runId);
      assert.equal(git(remote, 'rev-parse', 'refs/heads/' + branch), base);
      assert.equal(readdirSync(reports).length, 2);
      assert.equal(readFileSync(reportPath, 'utf8'), report);
      const resumedReportPath = guiState().stopReportPath;
      assert.ok(resumedReportPath && resumedReportPath !== reportPath);
      const resumedReport = readFileSync(resumedReportPath, 'utf8');
      assert.ok(resumedReport.includes('Вызовы Lisa за этот запуск — 0. Из бюджета фазы — 1 из 1'));
      assert.ok(resumedReport.includes(`Итерации фазы за этот запуск — ${resumedState.iterationsUsed - state.iterationsUsed}.`));

      // A file at the report directory path obstructs the write without touching state or logs.
      renameSync(reports, path.join(runtime, 'archived-test-reports'));
      writeFileSync(reports, 'fixture obstruction');
      const blocked = launch();
      assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
      assert.match(blocked.stderr, /Не удалось сохранить отчёт Ralph об остановке/u);
      assert.match(blocked.stderr, /Нужен человек: Лимит вмешательств Lisa исчерпан \(1\/1\)/u);
      assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).issue.phase, 'review-failed');
      assert.match(readFileSync(path.join(runtime, 'run.log'), 'utf8'), /RALPH|Issue #12/u);
      assert.equal(guiState().stopReportPath, undefined);
    }));
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('reports stay inside the runtime and a failed GUI pointer preserves the Markdown', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-report-io-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  const elsewhere = path.join(root, 'elsewhere');
  mkdirSync(runtime);
  mkdirSync(elsewhere);
  const directory = path.join(runtime, 'run-stop-reports');
  const pointer = path.join(runtime, 'run-stop-report.json');
  const details = { runId: '4c98d918-5c62-4b0f-8b42-48a070b1a92b',
    startedAt: new Date(0), stoppedAt: new Date(1000), durationMs: 1000,
    phase: { phaseIndex: 0, parkedIssues: [12] }, limits: {}, workers: [], state: null };

  symlinkSync(elsewhere, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeRunStopReport(runtime, details));
  const name = '4c98d918-5c62-4b0f-8b42-48a070b1a92b.md';
  writeFileSync(path.join(elsewhere, name), 'outside the report folder');
  writeFileSync(pointer, JSON.stringify({ name }));
  assert.equal(readLatestRunStopReportPath(runtime), null);
  rmSync(directory);
  rmSync(pointer);

  mkdirSync(pointer);
  const report = writeRunStopReport(runtime, details);
  assert.equal(report.shownInGui, false);
  assert.equal(readLatestRunStopReportPath(runtime), null);
  assert.match(readFileSync(report.filePath, 'utf8'), /Итерации фазы за этот запуск — нет данных/u);
});
