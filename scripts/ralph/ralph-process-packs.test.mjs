import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { approveConfiguredIssue } from './ralph-issue-contract.mjs';
import { assertProcessReport } from './ralph-process-packs.mjs';
import { executableTempDirectory, withFakeCodex, withFakeGh } from './ralph-test-support.mjs';

const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
const reportPath = 'docs/ralph-reports/issue-13.md';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

function init(root) {
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'config', 'user.name', 'Ralph process pack test');
  git(root, 'config', 'user.email', 'ralph@example.test');
  git(root, 'config', 'core.autocrlf', 'false');
}

test('invalid process metadata does not freeze an auto-approved snapshot', () => {
  const config = { autoApproveConfiguredIssues: true, approvedIssueSnapshots: {}, review: { enabled: true } };
  const store = { approveIssueSnapshot: (_number, snapshot) => snapshot };
  const issue = { number: 13, authorLogin: 'owner', title: 'Compare options', body: '<!-- ralph-process: reseach -->' };
  assert.throws(() => approveConfiguredIssue(config, issue, 'owner/repo', store), { code: 'RALPH_PROCESS_CONFIG' });
  assert.deepEqual(config.approvedIssueSnapshots, {});
  issue.body = '<!-- ralph-process: research -->';
  approveConfiguredIssue(config, issue, 'owner/repo', store);
  assert.equal(config.approvedIssueSnapshots[13].body, issue.body);
});

test('report evidence rejects both a directory replacement and a reverted product change', () => {
  const root = mkdtempSync(path.join(executableTempDirectory, 'packs-scope-'));
  const savedEnv = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    init(root);
    mkdirSync(path.join(root, reportPath), { recursive: true });
    writeFileSync(path.join(root, reportPath, 'product.txt'), 'Preserve this file.');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    const pack = { kind: 'research', reportPath };
    const otherReport = 'docs/ralph-reports/issue-14.md';

    git(root, 'rm', '-r', '--quiet', reportPath);
    mkdirSync(path.dirname(path.join(root, reportPath)), { recursive: true });
    writeFileSync(path.join(root, reportPath), '# Report\n');
    git(root, 'add', '--', reportPath);
    const replacement = git(root, 'write-tree');
    git(root, 'reset', '--hard', '--quiet', base);
    writeFileSync(path.join(root, 'private.txt'), 'Outside the report scope.');
    git(root, 'add', 'private.txt');
    git(root, 'commit', '--quiet', '-m', 'out-of-scope commit');
    git(root, 'rm', '--quiet', 'private.txt');
    writeFileSync(path.join(root, otherReport), '# Report\n');
    git(root, 'add', '--', otherReport);
    git(root, 'commit', '--quiet', '-m', 'revert and report');
    const commit = git(root, 'rev-parse', 'HEAD');

    process.env.GIT_DIR = path.join(root, '.git');
    process.env.GIT_WORK_TREE = root;
    assert.throws(() => assertProcessReport(pack, base, replacement), { code: 'RALPH_PROCESS_EVIDENCE' });
    assert.throws(() => assertProcessReport({ ...pack, reportPath: otherReport }, base, commit, {
      committed: true,
    }), { code: 'RALPH_PROCESS_EVIDENCE' });
  } finally {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const codex = String.raw`
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('login')) {
  console.log('fixture authenticated');
  process.exit(0);
}
const prompt = readFileSync(0, 'utf8');
const output = args.indexOf('--output-last-message');
let message = 'feat: finish the requested task';
if (output !== -1) {
  const file = args[output + 1];
  const review = file.includes('lisa-review-')
    ? { verdict: 'pass', reason: 'preserved scope' }
    : { verdict: 'pass', summary: 'fixture pass', findings: [] };
  writeFileSync(file, JSON.stringify(review));
} else if (prompt.includes('Ты Lisa')) {
  const file = '.agents/ralph.config.json';
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const recovery = config.validationScripts[0].includes('--recovered') ? ' --close-recovered' : '';
  config.validationScripts = ['node check.cjs --recovered' + recovery];
  writeFileSync(file, JSON.stringify(config));
  message = JSON.stringify({ verdict: 'resume', reason: 'repaired the fixture command' });
} else if (prompt.includes('### Режим ui-change')) {
  const current = readFileSync('button.txt', 'utf8');
  writeFileSync('button.txt', current === 'before' ? 'incomplete' : 'ready');
} else if (prompt.includes('### Режим research')) {
  if (readFileSync('button.txt', 'utf8') !== 'ready') throw new Error('dependency incomplete');
  const report = 'docs/ralph-reports/issue-13.md';
  if (existsSync(report)) unlinkSync('out-of-scope.txt');
  else writeFileSync('out-of-scope.txt', 'Should never be committed.');
  mkdirSync('docs/ralph-reports', { recursive: true });
  writeFileSync(report, '# Report\n\nThe updated button is ready.\n');
} else throw new Error('Unexpected role or process.');
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }));
`;

function fakeGithub(statePath) {
  return String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const file = ${JSON.stringify(statePath)};
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = ghArguments;
const [command, action, method, resource] = args;
const issueNumber = /\/issues\/(\d+)/.exec(resource ?? action)?.[1];
const issue = state.issues.find((candidate) => candidate.number === Number(issueNumber));
const readBody = () => readFileSync(0, 'utf8');
const save = (result) => { writeFileSync(file, JSON.stringify(state)); return result; };
const head = () => execFileSync('git', ['rev-parse', 'refs/remotes/origin/phase'], { encoding: 'utf8' }).trim();
let result;
if (command === '--version' || command === 'auth') result = 'authenticated';
else if (command === 'repo') result = { nameWithOwner: 'owner/repo' };
else if (command === 'api' && args.includes('.permissions')) result = { push: true };
else if (command === 'api' && issue && (resource ?? '').endsWith('/comments')) {
  const comment = method === 'POST' ? JSON.parse(readBody()) : null;
  if (comment) issue.comments.push(comment);
  result = comment ? save(comment) : issue.comments;
} else if (command === 'api' && issue && method === 'PATCH') {
  const patch = JSON.parse(readBody());
  if (issue.number === 13 && patch.state === 'closed' &&
      !readFileSync('.agents/ralph.config.json', 'utf8').includes('--close-recovered')) {
    console.error('fixture close failure');
    process.exit(1);
  }
  result = save(Object.assign(issue, patch));
} else if (command === 'api' && issue) result = issue;
else if (command === 'api' && resource === 'repos/owner/repo/issues') {
  result = args.includes('state=open') ? state.issues.filter((item) => item.state === 'open') : state.issues;
} else if (command === 'api' && resource === 'repos/owner/repo/milestones') result = [state.milestone];
else if (command === 'api' && resource === 'repos/owner/repo/milestones/1') {
  result = save(Object.assign(state.milestone, { state: 'closed' }));
} else if (command === 'api' && action === 'repos/owner/repo/milestones/1') result = state.milestone;
else if (command === 'api' && resource === 'repos/owner/repo/pulls/30/reviews') result = state.reviews;
else if (command === 'pr' && action === 'list') result = state.pr ? [state.pr] : [];
else if (command === 'pr' && action === 'create') {
  if (state.pr || !args.includes('--draft')) throw new Error('Expected one draft PR.');
  state.pr = { number: 30, url: 'https://example.test/pull/30', title: 'Packs',
    headRefName: 'phase', baseRefName: 'main', headRefOid: head() };
  result = save(state.pr.url);
} else if (command === 'pr' && action === 'view') result = state.pr;
else if (command === 'pr' && action === 'review') {
  state.reviews.push({ body: readBody(), head: head() });
  result = save('');
} else throw new Error('Unexpected gh call: ' + args.join(' '));
console.log(typeof result === 'string' ? result : JSON.stringify(result));
`;
}

test('--run verifies UI, retries report scope, and closes after a Lisa repair', async () => {
  const sandbox = mkdtempSync(path.join(executableTempDirectory, 'packs-cli-'));
  const root = path.join(sandbox, 'repo');
  const remote = path.join(sandbox, 'origin.git');
  const statePath = path.join(sandbox, 'github.json');
  try {
    mkdirSync(root);
    cpSync(path.join(sourceRoot, 'scripts'), path.join(root, 'scripts'), { recursive: true });
    cpSync(path.join(sourceRoot, '.agents'), path.join(root, '.agents'), { recursive: true });
    cpSync(path.join(sourceRoot, '.gitignore'), path.join(root, '.gitignore'));
    const configPath = path.join(root, '.agents/ralph.config.json');
    const ledger = '{}\n';
    const approvedIssueSnapshotsFile = 'scripts/ralph/approved-issues.json';
    writeFileSync(path.join(root, approvedIssueSnapshotsFile), ledger);
    const config = {
      active: true, syncBaseBranch: false, autoApproveConfiguredIssues: true,
      prompt: 'Implement issue #{issue_number}.',
      approvedIssueSnapshotsFile,
      approvedIssueSnapshotsHash: createHash('sha256').update(ledger).digest('hex'),
      phases: [{ milestone: 'Packs', branch: 'phase' }], maxIterations: 6, maxTestFixAttempts: 2,
      supervisor: { enabled: true, maxInterventions: 2 },
      validationScripts: ['node check.cjs'], browserValidationScripts: ['node browser.cjs'],
      runtime: { networkRetryAttempts: 1 },
    };
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(path.join(root, 'check.cjs'), String.raw`
const { existsSync } = require('node:fs');
if (existsSync('out-of-scope.txt') && !process.argv.includes('--recovered')) process.exit(75);
`);
    writeFileSync(path.join(root, 'browser.cjs'), String.raw`
const fs = require('node:fs');
const scope = process.env.RALPH_VALIDATION_SCOPE;
console.log('fixture browser scope=' + scope);
if (fs.readFileSync('button.txt', 'utf8') !== 'ready') process.exit(1);
if (scope === 'phase' && !fs.existsSync('docs/ralph-reports/issue-13.md')) process.exit(2);
`);
    writeFileSync(path.join(root, 'button.txt'), 'before');
    const issues = [[12, 'ui-change', 'Update the button'], [13, 'research', 'Report on the button']].map(
      ([number, kind, title]) => ({
        number, title, body: `<!-- ralph-process: ${kind} -->\n${title}.`, state: 'open', comments: [],
        user: { login: 'owner' }, milestone: { number: 1 }, html_url: 'https://example.test/issues/' + number,
      }),
    );
    writeFileSync(statePath, JSON.stringify({ issues, milestone: { title: 'Packs', number: 1, state: 'open' }, reviews: [] }));
    init(root);
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'base');
    git(root, 'init', '--bare', '--quiet', remote);
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '--quiet', '-u', 'origin', 'main');

    await withFakeCodex(codex, () => withFakeGh(fakeGithub(statePath), () => {
      const result = spawnSync(process.execPath, ['scripts/ralph/ralph-loop.mjs', '--run', '--ui=plain'], {
        cwd: root, env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' }, encoding: 'utf8',
        timeout: 180_000, windowsHide: true,
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 0, output.slice(-12_000));
      const browserResults = [...output.matchAll(/Validation: check node browser\.cjs — \d+ ms, (pass|fail)/gu)];
      assert.deepEqual(browserResults.map((match) => match[1]), ['fail', 'pass', 'pass']);
      const browserScopes = [...output.matchAll(/fixture browser scope=(\w+)/gu)];
      assert.deepEqual(browserScopes.slice(-2).map((match) => match[1]), ['issue', 'phase']);
      assert.match(output, /research: измените только docs\/ralph-reports\/issue-13\.md/u);
      assert.match(output, /Lisa: восстановлен шаг validation/u);
      assert.match(output, /Lisa: восстановлен шаг close/u);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.deepEqual(state.issues.map(({ state }) => state), ['closed', 'closed']);
      assert.equal(state.milestone.state, 'closed');
      const head = git(remote, 'rev-parse', 'refs/heads/phase');
      assert.equal(state.pr.headRefOid, head);
      assert.equal(state.reviews.length, 1);
      assert.equal(state.reviews[0].head, head);
      assert.match(state.reviews[0].body, /\bPASS\b/u);
      const commits = git(root, 'rev-list', '--reverse', 'main..phase').split(/\r?\n/u);
      assert.deepEqual(commits.map((sha) => git(root, 'show', '--format=', '--name-only', sha)), [
        'button.txt', `.agents/ralph.config.json\n${reportPath}`, '.agents/ralph.config.json',
      ]);
    }));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
