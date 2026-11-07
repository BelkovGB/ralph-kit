import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runAgentOnIssue } from './ralph-loop.mjs';
import { loadConfig } from './ralph-config.mjs';
import { repairStepPassed } from './ralph-lifecycle.mjs';
import { readLiveStatus, resetLiveStatus, subscribeLiveStatus } from './ralph-live-status.mjs';
import { setActiveStateStore } from './ralph-state-store.mjs';
import { prepareLisaResume } from './ralph-supervisor.mjs';
import { withFakeClaude, withFakeCodex, withFakeGh } from './ralph-test-support.mjs';

/**
 * Жизненный цикл issue целиком, in-process: commit найден → ревью → push →
 * закрытие. До этих тестов путь после валидации не проверялся ничем — по нему
 * можно было пройти только настоящим прогоном с настоящим GitHub.
 *
 * Устройство стенда: git-команды цикла уводятся в одноразовый репозиторий
 * переменными GIT_DIR и GIT_WORK_TREE — cwd команд остаётся прежним, поэтому
 * годится любой путь без относительных pathspec; путь со staging сюда не
 * входит и остаётся за будущим швом. `gh` подменяет withFakeGh из
 * ralph-test-support: логика этого стенда ведёт журнал вызовов и состояние
 * issue в файлах. Ревью-сессию обслуживает
 * поддельный codex: приглашение ревью он узнаёт по пути файла результата в
 * своих аргументах.
 */

const issueNumber = 91;
const issueTitle = 'Закрыть жизненный цикл issue тестом';
const issueBody = 'Approved lifecycle body.';

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} -> ${result.status}`);
  }
  return result.stdout.trim();
}

function remoteHeads(repository) {
  return git(repository.workTree, [`--git-dir=${repository.origin}`, 'for-each-ref', '--format=%(objectname)', 'refs/heads']);
}

/** Одноразовый репозиторий с базовым коммитом, trailer-коммитом и bare origin. */
function createLifecycleRepository(branch, files = { 'work.txt': 'implemented\n' }) {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-lifecycle-'));
  const workTree = path.join(root, 'repo');
  const origin = path.join(root, 'origin.git');
  mkdirSync(workTree);
  git(root, ['init', '--bare', '--quiet', origin]);
  git(workTree, ['init', '--quiet', '-b', branch]);
  git(workTree, ['config', 'user.name', 'Ralph Lifecycle']);
  git(workTree, ['config', 'user.email', 'ralph@example.test']);
  git(workTree, ['remote', 'add', 'origin', origin]);
  writeFileSync(path.join(workTree, 'base.txt'), 'base\n', 'utf8');
  git(workTree, ['add', 'base.txt']);
  git(workTree, ['commit', '--quiet', '-m', 'chore: base commit']);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(workTree, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  git(workTree, ['add', '--', ...Object.keys(files)]);
  git(workTree, [
    'commit',
    '--quiet',
    '-m',
    `feat: implement issue\n\nRalph-Issue: #${issueNumber}`,
  ]);

  return { root, workTree, origin, commit: git(workTree, ['rev-parse', 'HEAD']) };
}

/**
 * Поддельный gh: журнал вызовов в JSONL, состояние issue в JSON-файле.
 * GET issue отдаёт состояние, PATCH сливает тело запроса в него, коллекции
 * отвечают пустым списком, POST — пустым объектом.
 */
function createFakeGh(root, { rejectClose = false, rejectCloseAttempts = 0, rejectReviewUpdate = false,
  githubUnavailable = false } = {}) {
  const directory = path.join(root, 'fake-gh');
  mkdirSync(directory);
  const statePath = path.join(directory, 'issue-state.json');
  const callsPath = path.join(directory, 'calls.jsonl');
  writeFileSync(
    statePath,
    JSON.stringify({ number: issueNumber, title: issueTitle, body: issueBody, state: 'open',
      user: { login: 'trusted-author' }, milestone: { number: 7 } }),
    'utf8',
  );
  writeFileSync(callsPath, '', 'utf8');

  const logicBody = `
  const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
  const statePath = ${JSON.stringify(statePath)};
  const callsPath = ${JSON.stringify(callsPath)};
  let method = 'GET';
  const positional = [];
  for (let i = 0; i < ghArguments.length; i += 1) {
    if (ghArguments[i] === '--method') method = ghArguments[++i];
    else if (ghArguments[i] === '--input') i += 1;
    else if (ghArguments[i] === '-F' || ghArguments[i] === '-f') i += 1;
    else positional.push(ghArguments[i]);
  }
  const resource = positional[1] ?? '';
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {}
  appendFileSync(callsPath, JSON.stringify({ method, resource, input }) + String.fromCharCode(10), 'utf8');
  if (${githubUnavailable}) {
    process.stderr.write('GitHub fixture unavailable (HTTP 503).');
    process.exit(1);
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (method === 'PATCH') {
    const patch = JSON.parse(input || '{}');
    const closeAttempts = readFileSync(callsPath, 'utf8').split(String.fromCharCode(10)).filter(Boolean)
      .map(JSON.parse).filter((call) => call.method === 'PATCH' && JSON.parse(call.input || '{}').state === 'closed').length;
    if (patch.state === 'closed' && (${rejectClose} || closeAttempts <= ${rejectCloseAttempts})) {
      process.stderr.write('Fixture issue cannot be closed.');
      process.exit(1);
    }
    if (${rejectReviewUpdate} && typeof patch.body === 'string') {
      process.stderr.write('Fixture review findings cannot be published.');
      process.exit(1);
    }
    Object.assign(state, patch);
    writeFileSync(statePath, JSON.stringify(state), 'utf8');
    process.stdout.write(JSON.stringify(state));
  } else if (method === 'POST') {
    process.stdout.write('{}');
  } else if (/comments/.test(resource)) {
    process.stdout.write('[]');
  } else {
    process.stdout.write(JSON.stringify(state));
  }
`;

  return {
    logicBody,
    calls: () =>
      readFileSync(callsPath, 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    issueState: () => JSON.parse(readFileSync(statePath, 'utf8')),
    setIssue: (patch) => writeFileSync(statePath,
      JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), ...patch }), 'utf8'),
  };
}

/**
 * Минимальное хранилище состояния: то же поведение, что у настоящего
 * beginIssue/updateIssue/clearIssue, плюс журнал фаз для проверок.
 */
function recordingStateStore(initialIssue = null) {
  const record = { issue: initialIssue, phases: [], runId: 'lifecycle-fixture', phaseIndex: 0 };

  return {
    record,
    state: record,
    get issue() {
      return record.issue;
    },
    beginIssue(issue, startingCommit, foreignPaths = []) {
      record.issue ??= {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        startingCommit,
        foreignPaths,
        phase: 'agent-running',
        validationFixAttempts: 0,
      };
      record.issue.phase = 'agent-running';
      return record.issue;
    },
    updateIssue(values) {
      if (!record.issue) return;
      Object.assign(record.issue, values);
      if (values.phase) record.phases.push(values.phase);
    },
    clearIssue() {
      record.issue = null;
    },
  };
}

/**
 * Поддельный codex обслуживает обе роли. Ревью он узнаёт по пути файла
 * результата в аргументах: пишет туда вердикт и подтверждает сообщением.
 * Сессия разработки печатает ALREADY_FIXED: правка уже в HEAD.
 */
function reviewerSource(reviewOutputPath, verdictJson, repository, agentCli) {
  return `
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const reviewOutputPath = ${JSON.stringify(reviewOutputPath)};
const isClaude = ${agentCli === 'claude'};
const isReview = process.argv.includes(isClaude ? '--json-schema' : reviewOutputPath);
appendFileSync(reviewOutputPath + '.invocations', isReview ? 'review\\n' : 'development\\n', 'utf8');
const message = (text) =>
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text } }) + '\\n');
if (isReview) {
  writeFileSync(reviewOutputPath + '.review-prompt', readFileSync(0, 'utf8'), 'utf8');
  const remote = spawnSync('git', ${JSON.stringify([`--git-dir=${repository.origin}`, 'rev-parse', '--verify', `refs/heads/${repository.branch}`])}, { encoding: 'utf8', windowsHide: true });
  writeFileSync(reviewOutputPath + '.remote-at-review', remote.status === 0 ? remote.stdout.trim() : '', 'utf8');
  if (isClaude) {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      result: 'Review recorded.', structured_output: JSON.parse(${JSON.stringify(verdictJson)}) }) + '\\n');
  } else {
    writeFileSync(reviewOutputPath, ${JSON.stringify(verdictJson)}, 'utf8');
    message('Review recorded.');
  }
} else {
  writeFileSync(reviewOutputPath + '.development-prompt', readFileSync(0, 'utf8'), 'utf8');
  message('ALREADY_FIXED: ${repository.commit}');
}
`;
}

function lifecycleConfig(repository, reviewOutputPath) {
  return {
    ...loadConfig(),
    agentCli: 'codex',
    githubAccount: null,
    branch: repository.branch,
    trustedIssueAuthors: ['trusted-author'],
    approvedIssueSnapshots: { [issueNumber]: { title: issueTitle, body: issueBody } },
    preflightScripts: [],
    validationScripts: [],
    validationArtifactPaths: [],
    maxReviewFixAttempts: 2,
    supervisor: { ...loadConfig().supervisor, enabled: false },
    review: { ...loadConfig().review, enabled: true, outputPath: reviewOutputPath },
  };
}

function lifecycleIssue(url = `https://example.test/issues/${issueNumber}`) {
  return {
    number: issueNumber,
    title: issueTitle,
    body: issueBody,
    url,
    // Свежесть trailer-коммита сравнивается с этой отметкой: она в прошлом,
    // поэтому commit признаётся сделанным после последнего изменения issue.
    updatedAt: '2020-01-01T00:00:00Z',
    authorLogin: 'trusted-author',
    authorAssociation: 'OWNER',
    milestone: 7,
  };
}

async function withLifecycleStand(branch, verdictJson, operation, options = {}) {
  const repository = createLifecycleRepository(branch, options.files);
  repository.branch = branch;
  if (options.moveRemoteHead) {
    const origin = repository.origin.replaceAll('\\', '/');
    writeFileSync(path.join(repository.origin, 'hooks', 'post-receive'),
      `#!/bin/sh\ngit --git-dir="${origin}" update-ref refs/heads/${branch} ${repository.commit}^\n`,
      { encoding: 'utf8', mode: 0o755 });
  }
  const gh = createFakeGh(repository.root, options);
  const reviewOutputPath = path.join(repository.root, 'review-result.json');
  const savedEnv = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  };
  const restoreVariable = (name) => {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  };
  const withFakeAgent = options.agentCli === 'claude' ? withFakeClaude : withFakeCodex;

  try {
    await withFakeGh(gh.logicBody, async () => {
      await withFakeAgent(
        reviewerSource(reviewOutputPath, verdictJson, repository, options.agentCli),
        async () => {
          process.env.GIT_DIR = path.join(repository.workTree, '.git');
          process.env.GIT_WORK_TREE = repository.workTree;
          try {
            await operation({ repository, gh, reviewOutputPath });
          } finally {
            restoreVariable('GIT_DIR');
            restoreVariable('GIT_WORK_TREE');
          }
        },
      );
    });
  } finally {
    setActiveStateStore(null);
    rmSync(repository.root, { recursive: true, force: true });
  }
}

function agentInvocations(reviewOutputPath) {
  try {
    return readFileSync(`${reviewOutputPath}.invocations`, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const passVerdict = JSON.stringify({ verdict: 'pass', summary: 'Clean.', findings: [] });
const failVerdict = JSON.stringify({
  verdict: 'fail',
  summary: 'Found a defect.',
  findings: [
    {
      severity: 'P1',
      title: 'Broken invariant',
      file: 'work.txt',
      line: 1,
      body: 'The invariant is broken.',
    },
  ],
});

test('an accepted no-op repair freshly reviews the complete task at the same HEAD without development', async () => {
  await withLifecycleStand('ralph/lifecycle-lisa-clean', failVerdict, async (stand) => {
    const store = recordingStateStore({ number: issueNumber, title: issueTitle, body: issueBody,
      phase: 'review-failed', startingCommit: stand.repository.commit, commit: stand.repository.commit,
      recoveryHead: stand.repository.commit, pushedHead: null, reviewedCommit: stand.repository.commit,
      reviewReceipt: { head: stand.repository.commit, result: JSON.parse(failVerdict) },
      reviewFindings: 'NOOP_PRIOR_FINDING: The invariant is still broken', reviewFixAttempts: 2,
      foreignPaths: [], foreignPathsFormat: 'exact-v1' });
    setActiveStateStore(store);
    resetLiveStatus();
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    config.supervisor.enabled = true;
    config.maxReviewFixAttempts = 10;
    const before = { branch: stand.repository.branch, head: stand.repository.commit, repairId: 'clean-repair' };
    prepareLisaResume(config, store, before, { acceptedRepair: true,
      run: (command, args) => { assert.equal(command, 'git'); return { status: 0, stdout: git(stand.repository.workTree, args) }; },
    });
    store.state.lisaRepair = { ...before, runId: store.state.runId, phaseIndex: store.state.phaseIndex,
      issueNumber, status: 'resuming', acceptedTreeHash: 'checked' };
    const result = await runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');
    assert.equal(result.review.verdict, 'fail');
    assert.deepEqual(agentInvocations(stand.reviewOutputPath), ['review']);
    assert.equal(result.parked, true);
    const prompt = readFileSync(`${stand.reviewOutputPath}.review-prompt`, 'utf8');
    assert.match(prompt, /NOOP_PRIOR_FINDING/);
    assert.match(prompt, /complete set of changes made for this issue/);
    assert.match(prompt, /\+implemented/);
    assert.equal(git(stand.repository.workTree, ['rev-parse', 'HEAD']), before.head);
    assert.equal(stand.gh.issueState().state, 'open');
    assert.equal(store.issue.lisaRepairId, before.repairId);
    assert.notEqual(readLiveStatus().lastPassedStep?.step, 'review-failed');
    resetLiveStatus();
  });
});

test('a product FAIL after accepted Lisa repair returns to Lisa before another development session', async () => {
  await withLifecycleStand('ralph/lifecycle-lisa-fail', failVerdict, async (stand) => {
    const store = recordingStateStore({ number: issueNumber, title: issueTitle, body: issueBody,
      phase: 'committed', commit: stand.repository.commit, recoveryHead: stand.repository.commit,
      startingCommit: git(stand.repository.workTree, ['rev-parse', 'HEAD^']),
      lisaRepairId: 'repair', foreignPaths: [], foreignPathsFormat: 'exact-v1' });
    store.state.lisaRepair = { repairId: 'repair', runId: store.state.runId,
      phaseIndex: store.state.phaseIndex, issueNumber, status: 'resuming', acceptedTreeHash: 'checked' };
    setActiveStateStore(store);
    resetLiveStatus();
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    config.supervisor.enabled = true;
    config.maxReviewFixAttempts = 10;
    const result = await runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');
    assert.equal(result.parked, true);
    assert.equal(store.issue.reviewFixAttempts, 1);
    assert.equal(stand.gh.issueState().state, 'open');
    assert.deepEqual(agentInvocations(stand.reviewOutputPath), ['review']);
    assert.notEqual(readLiveStatus().lastPassedStep?.step, 'review-failed');
    resetLiveStatus();
  });
});

for (const agentCli of ['codex', 'claude']) {
  test(`локальное ревью предшествует push и закрытию issue (${agentCli})`, async () => {
    await withLifecycleStand('ralph/lifecycle-pass', passVerdict, async (stand) => {
      const store = recordingStateStore();
      setActiveStateStore(store);
      const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
      config.agentCli = agentCli;

      const result = await runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');

      assert.equal(result.completed, true);
      assert.equal(result.commit, stand.repository.commit);
      assert.equal(result.review.verdict, 'pass');

      // Ветка дошла до origin ровно тем commit, который прошёл ревью.
      const pushed = git(stand.repository.workTree, [
        'ls-remote',
        '--heads',
        'origin',
        'refs/heads/ralph/lifecycle-pass',
      ]);
      assert.equal(pushed.split(/\s+/)[0], stand.repository.commit);
      assert.equal(readFileSync(`${stand.reviewOutputPath}.remote-at-review`, 'utf8'), '');

      // Сессия агента не запускалась: trailer-коммит уже содержал работу.
      assert.deepEqual(agentInvocations(stand.reviewOutputPath), ['review']);

      // Issue закрыта как выполненная, и до того порядок фаз дошёл до закрытия.
      assert.equal(stand.gh.issueState().state, 'closed');
      const patches = stand.gh.calls().filter((call) => call.method === 'PATCH');
      assert.equal(patches.length, 1);
      assert.match(patches[0].input, /"state":"closed"/);
      assert.deepEqual(store.record.phases, ['validating', 'reviewing', 'closing']);
      assert.equal(store.issue, null);
    }, { agentCli });
  });
}

test('PASS подтверждает восстановление после отказа ревью до сбоя закрытия задачи', async () => {
  await withLifecycleStand('ralph/lifecycle-close-failed', passVerdict, async (stand) => {
    const store = recordingStateStore();
    setActiveStateStore(store);
    resetLiveStatus();
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    const pending = { runId: store.state.runId, phaseIndex: store.state.phaseIndex,
      issueNumber, failureStep: 'review-failed' };
    let proved = false;
    const unsubscribe = subscribeLiveStatus(({ lastPassedStep }) => {
      if (repairStepPassed(pending, lastPassedStep)) proved = true;
    });
    try {
      await assert.rejects(runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules'),
        { ralphFailureStep: 'close' });
    } finally {
      unsubscribe();
      resetLiveStatus();
    }
    assert.equal(store.issue.phase, 'closing');
    assert.equal(stand.gh.issueState().state, 'open');
    assert.equal(proved, true);
  }, { rejectClose: true });
});

test('после смены опубликованного HEAD Ralph оставляет ремонт неподтверждённым', async () => {
  await withLifecycleStand('ralph/lifecycle-head-moved', passVerdict, async (stand) => {
    setActiveStateStore(recordingStateStore());
    resetLiveStatus();
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    try {
      await assert.rejects(runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules'),
        /Проверка pushed HEAD не прошла/u);
      assert.equal(readLiveStatus().lastPassedStep?.step, 'review');
      assert.equal(stand.gh.issueState().state, 'open');
      assert.equal(stand.gh.calls().some(({ method }) => method === 'PATCH'), false);
    } finally {
      resetLiveStatus();
    }
  }, { moveRemoteHead: true });
});

test('already-fixed issue validates the linked commit instead of an empty HEAD diff', async () => {
  await withLifecycleStand('ralph/lifecycle-scoped', passVerdict, async (stand) => {
    const store = recordingStateStore();
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    const validationPath = path.join(stand.repository.root, 'validate.cjs');
    const reportPath = path.join(stand.repository.root, 'validation-scope.json');
    writeFileSync(validationPath,
      `require('node:fs').writeFileSync(process.env.RALPH_LIFECYCLE_REPORT, ` +
        `JSON.stringify({ scope: process.env.RALPH_VALIDATION_SCOPE, ` +
        `base: process.env.RALPH_VALIDATION_BASE_COMMIT }));\n`, 'utf8');
    config.validationEnvironment = [
      `RALPH_LIFECYCLE_VALIDATION=${validationPath}`,
      `RALPH_LIFECYCLE_REPORT=${reportPath}`,
    ];
    const command = process.platform === 'win32'
      ? 'node -e require(process.env.RALPH_LIFECYCLE_VALIDATION)'
      : "node -e 'require(process.env.RALPH_LIFECYCLE_VALIDATION)'";
    config.validationProfiles = { issue: [command], phase: [command], baseSync: [command] };

    const result = await runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');
    assert.equal(result.completed, true);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), {
      scope: 'issue', base: git(stand.repository.workTree, ['rev-parse', 'HEAD^']),
    });
  });
});

test('a declared UI issue cannot push or close without configured browser checks', async () => {
  await withLifecycleStand('ralph/lifecycle-ui', passVerdict, async (stand) => {
    setActiveStateStore(recordingStateStore());
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    const issue = { ...lifecycleIssue(), body: '<!-- ralph-process: ui-change -->\nCheck the updated flow.' };
    config.approvedIssueSnapshots[issueNumber].body = issue.body;
    await assert.rejects(runAgentOnIssue(config, 'owner/repository', issue, 'rules'), {
      code: 'RALPH_PROCESS_CONFIG', message: /browserValidationScripts/,
    });
    assert.equal(git(stand.repository.workTree, ['ls-remote', '--heads', 'origin']), '');
    assert.equal(stand.gh.issueState().state, 'open');
    assert.deepEqual(agentInvocations(stand.reviewOutputPath), []);
  });
});

for (const route of ['already-fixed', 'committed']) {
  test(`a report-only issue rejects product changes before revalidation (${route})`, async () => {
    const reportPath = `docs/ralph-reports/issue-${issueNumber}.md`;
    await withLifecycleStand('ralph/lifecycle-research-scope', passVerdict, async (stand) => {
      const issue = { ...lifecycleIssue(), body: '<!-- ralph-process: research -->\nCompare the options.' };
      const { workTree, commit } = stand.repository;
      setActiveStateStore(recordingStateStore(route === 'committed' ? {
        ...issue, phase: 'committed', commit, startingCommit: git(workTree, ['rev-parse', 'HEAD^']),
      } : null));
      const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
      config.approvedIssueSnapshots[issueNumber].body = issue.body;
      config.validationScripts = ['node missing-fixture-script.cjs'];
      await assert.rejects(runAgentOnIssue(config, 'owner/repository', issue, 'rules'), {
        code: 'RALPH_PROCESS_EVIDENCE', message: /docs\/ralph-reports/,
      });
      assert.equal(git(workTree, ['ls-remote', '--heads', 'origin']), '');
      assert.equal(stand.gh.issueState().state, 'open');
    }, { files: { [reportPath]: '# Comparison\n', 'work.txt': 'unrelated product change\n' } });
  });
}

test('a report-only issue closes after its report is published and reviewed', async () => {
  const reportPath = `docs/ralph-reports/issue-${issueNumber}.md`;
  await withLifecycleStand('ralph/lifecycle-review-report', passVerdict, async (stand) => {
    setActiveStateStore(recordingStateStore());
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    const issue = { ...lifecycleIssue(), body: '<!-- ralph-process: review -->\nReview this branch.' };
    config.approvedIssueSnapshots[issueNumber].body = issue.body;
    stand.gh.setIssue({ body: issue.body });
    const result = await runAgentOnIssue(config, 'owner/repository', issue, 'rules');
    assert.equal(result.completed, true);
    assert.equal(stand.gh.issueState().state, 'closed');
    assert.deepEqual(agentInvocations(stand.reviewOutputPath), ['review']);
    assert.equal(git(stand.repository.workTree, ['show', `${result.commit}:${reportPath}`]), '# Findings');
  }, { files: { [reportPath]: '# Findings\n' } });
});

test('отказ ревью оставляет коммит локально и сохраняет задачу при исчерпании попыток', async () => {
  await withLifecycleStand('ralph/lifecycle-fail', failVerdict, async (stand) => {
    const store = recordingStateStore();
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);

    const first = await runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');

    assert.equal(first.completed, false);
    assert.equal(first.parked, undefined);
    assert.equal(first.review.verdict, 'fail');
    // Замечания уехали в тело issue, а сама issue осталась в работе.
    assert.equal(store.issue.phase, 'review-failed');
    assert.equal(store.issue.reviewFixAttempts, 1);
    assert.equal(store.issue.startingCommit, stand.repository.commit);
    const bodyPatch = stand.gh
      .calls()
      .filter((call) => call.method === 'PATCH')
      .find((call) => /Broken invariant/.test(call.input));
    assert.notEqual(bodyPatch, undefined);
    assert.equal(stand.gh.issueState().state, 'open');
    assert.equal(git(stand.repository.workTree, ['ls-remote', '--heads', 'origin']), '');

    // Сессия исправления вернула прежний SHA. Повторное ревью не нужно, но
    // попытка исчерпана и публикация ветки ждёт исправления.
    const second = await runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');

    assert.equal(second.completed, false);
    assert.equal(second.parked, true);
    assert.equal(second.publicationBlocked, true);
    assert.equal(store.issue.phase, 'review-failed');
    assert.deepEqual(agentInvocations(stand.reviewOutputPath), [
      'review',
      'development',
    ]);
    assert.match(
      readFileSync(`${stand.reviewOutputPath}.development-prompt`, 'utf8'),
      /Broken invariant/u,
    );
  });
});

test('повторное ревью передаёт короткое исправление после проверенного HEAD', async () => {
  await withLifecycleStand('ralph/lifecycle-incremental', failVerdict, async (stand) => {
    const workTree = stand.repository.workTree;
    const afterHead = stand.repository.commit;
    writeFileSync(path.join(workTree, 'fix.txt'), 'exact lifecycle fix\n');
    git(workTree, ['add', '--', 'fix.txt']);
    git(workTree, ['commit', '--quiet', '-m', 'fix: resolve the finding', '-m', `Ralph-Issue: #${issueNumber}`]);
    const head = git(workTree, ['rev-parse', 'HEAD']);
    const store = recordingStateStore({
      number: issueNumber, title: issueTitle, body: issueBody,
      startingCommit: afterHead, foreignPaths: [], phase: 'committed', commit: head, recoveryHead: head,
      reviewReceipt: { head: afterHead, result: JSON.parse(failVerdict) },
      reviewFindings: 'Guard required by the previous review',
    });
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);

    const result = await runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');
    assert.equal(result.review.verdict, 'fail');
    const prompt = readFileSync(`${stand.reviewOutputPath}.review-prompt`, 'utf8');
    assert.match(prompt, /\+exact lifecycle fix/u);
    assert.match(prompt, /Guard required by the previous review/u);
    assert.doesNotMatch(prompt, /\+already reviewed line|The diff above is truncated/u);
  }, { files: { 'work.txt': 'already reviewed line\n'.repeat(4000) } });
});

test('пройденное на прошлом прогоне ревью не повторяется: issue закрывается сразу', async () => {
  await withLifecycleStand('ralph/lifecycle-resume', passVerdict, async (stand) => {
    // Состояние прерванного прогона: вердикт PASS записан, закрытие не успело.
    const store = recordingStateStore({
      number: issueNumber,
      title: issueTitle,
      body: issueBody,
      startingCommit: stand.repository.commit,
      foreignPaths: [],
      phase: 'closing',
      commit: stand.repository.commit,
      reviewedCommit: stand.repository.commit,
      pushedHead: stand.repository.commit,
      validationFixAttempts: 0,
    });
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);

    git(stand.repository.workTree, ['push', 'origin', 'HEAD']);

    const result = await runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');

    assert.equal(result.completed, true);
    assert.match(result.review.summary, /previous run/);
    // Ни одной сессии агента: ни разработки, ни повторного ревью.
    assert.deepEqual(agentInvocations(stand.reviewOutputPath), []);
    assert.equal(stand.gh.issueState().state, 'closed');
    assert.equal(store.issue, null);
  });
});

test('после двух отказов закрытия сохранённый PASS используется до успешного закрытия', async () => {
  await withLifecycleStand('ralph/lifecycle-close-twice', passVerdict, async (stand) => {
    const store = recordingStateStore();
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    const complete = () => runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(complete(), { ralphFailureStep: 'close' });
      assert.equal(store.issue.reviewReceipt?.head, stand.repository.commit);
      assert.equal(store.issue.reviewReceipt?.result.verdict, 'pass');
    }
    assert.equal((await complete()).completed, true);
    assert.deepEqual(agentInvocations(stand.reviewOutputPath), ['review']);
    assert.equal(stand.gh.issueState().state, 'closed');
  }, { rejectCloseAttempts: 2 });
});

test('FAIL сохраняет замечания при отказе GitHub обновить тело issue', async () => {
  await withLifecycleStand('ralph/lifecycle-review-update-failed', failVerdict, async (stand) => {
    const store = recordingStateStore();
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    const complete = () => runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');

    await assert.rejects(complete(), { code: 'RALPH_COMMAND_FAILED' });
    assert.equal(store.issue.phase, 'review-failed');
    assert.equal(store.issue.reviewReceipt?.result.verdict, 'fail');
    assert.match(store.issue.reviewFindings, /Broken invariant/u);
    assert.equal(remoteHeads(stand.repository), '');
  }, { rejectReviewUpdate: true });
});

test('смена условий issue после локального ревью сохраняет PASS и останавливает push', async () => {
  await withLifecycleStand('ralph/lifecycle-changed-issue', passVerdict, async (stand) => {
    const store = recordingStateStore();
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    stand.gh.setIssue({ body: 'Different requirements.' });

    await assert.rejects(runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules'), {
      code: 'RALPH_UNTRUSTED_ISSUE',
    });
    assert.equal(store.issue.reviewReceipt?.head, stand.repository.commit);
    assert.equal(store.issue.reviewReceipt?.result.verdict, 'pass');
    assert.equal(remoteHeads(stand.repository), '');
  });
});

test('служебная метка issue после локального ревью останавливает push', async () => {
  await withLifecycleStand('ralph/lifecycle-infrastructure-issue', passVerdict, async (stand) => {
    const store = recordingStateStore();
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    stand.gh.setIssue({ labels: [{ name: 'ralph-infrastructure' }] });

    await assert.rejects(runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules'), {
      code: 'RALPH_UNTRUSTED_ISSUE',
    });
    assert.equal(store.issue.pendingPublishHead, stand.repository.commit);
    assert.equal(remoteHeads(stand.repository), '');
  });
});

test('ремонт Lisa не публикует впервые коммит уже закрытой issue', async () => {
  await withLifecycleStand('ralph/lifecycle-unpublished-closed-repair', passVerdict, async (stand) => {
    const commit = stand.repository.commit;
    const store = recordingStateStore({ ...lifecycleIssue(), startingCommit: commit, phase: 'committed',
      commit, recoveryHead: commit, lisaRepairId: 'repair' });
    store.state.lisaRepair = { repairId: 'repair', runId: store.state.runId,
      phaseIndex: store.state.phaseIndex, issueNumber, status: 'resuming', acceptedTreeHash: 'verified' };
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    stand.gh.setIssue({ state: 'closed' });

    await assert.rejects(runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules'), {
      code: 'RALPH_UNTRUSTED_ISSUE',
    });
    assert.equal(store.issue.pendingPublishHead, commit);
    assert.equal(remoteHeads(stand.repository), '');
  });
});

test('сбой GitHub после принятия issue сохраняет локальный PASS и ожидающий push', async () => {
  await withLifecycleStand('ralph/lifecycle-offline-publication', passVerdict, async (stand) => {
    const store = recordingStateStore();
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    const complete = () => runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');

    await assert.rejects(complete(), { ralphFailureStep: 'push' });
    assert.equal(store.issue.pendingPublishHead, stand.repository.commit);
    assert.equal(store.issue.reviewReceipt?.result.verdict, 'pass');
    assert.deepEqual(agentInvocations(stand.reviewOutputPath), ['review']);
    assert.equal(remoteHeads(stand.repository), '');
  }, { githubUnavailable: true });
});

test('failed validation of a manual commit returns to development before validation and review', async () => {
  await withLifecycleStand('ralph/lifecycle-manual', passVerdict, async (stand) => {
    const store = recordingStateStore({
      number: issueNumber,
      title: issueTitle,
      body: issueBody,
      startingCommit: git(stand.repository.workTree, ['rev-parse', 'HEAD^']),
      foreignPaths: [],
      phase: 'committed',
      commit: stand.repository.commit,
      recoveryHead: stand.repository.commit,
      reviewedCommit: null,
      validationFixAttempts: 0,
    });
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);
    const validationPath = path.join(stand.repository.root, 'validate.cjs');
    const writeValidation = (exitCode) =>
      writeFileSync(
        validationPath,
        `require('node:fs').appendFileSync(${JSON.stringify(`${stand.reviewOutputPath}.invocations`)}, 'validation\\n');\nprocess.exit(${exitCode});\n`,
        'utf8',
      );
    config.validationEnvironment = [
      ...(config.validationEnvironment ?? []),
      `RALPH_LIFECYCLE_VALIDATION=${validationPath}`,
    ];
    config.validationScripts = [
      process.platform === 'win32'
        ? 'node -e require(process.env.RALPH_LIFECYCLE_VALIDATION)'
        : "node -e 'require(process.env.RALPH_LIFECYCLE_VALIDATION)'",
    ];

    writeValidation(1);
    await assert.rejects(
      runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules'),
      (error) => {
        assert.equal(error.code, 'RALPH_VALIDATION_FAILED');
        assert.deepEqual(agentInvocations(stand.reviewOutputPath), ['validation'], error.message);
        return true;
      },
    );

    assert.deepEqual(agentInvocations(stand.reviewOutputPath), ['validation']);
    assert.equal(stand.gh.issueState().state, 'open');
    assert.equal(stand.gh.calls().some((call) => call.method === 'PATCH'), false);
    assert.equal(store.issue.phase, 'working-tree');
    assert.equal(store.issue.startingCommit, stand.repository.commit);
    assert.equal(store.issue.commit, null);
    assert.equal(store.issue.recoveryHead, null);
    assert.equal(store.issue.reviewedCommit, null);
    assert.equal(store.issue.validationFixAttempts, 1);
    assert.equal(store.issue.lastFailureSummary.code, 'RALPH_VALIDATION_FAILED');

    writeValidation(0);
    const result = await runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');

    assert.equal(result.completed, true);
    assert.equal(result.commit, stand.repository.commit);
    assert.equal(result.review.verdict, 'pass');
    assert.deepEqual(agentInvocations(stand.reviewOutputPath), [
      'validation',
      'development',
      'validation',
      'review',
    ]);
    assert.equal(stand.gh.issueState().state, 'closed');
    assert.equal(store.issue, null);
  });
});
