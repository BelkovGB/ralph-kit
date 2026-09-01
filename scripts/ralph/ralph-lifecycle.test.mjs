import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runAgentOnIssue } from './ralph-loop.mjs';
import { loadConfig } from './ralph-config.mjs';
import { setActiveStateStore } from './ralph-state-store.mjs';
import { withFakeCodex } from './ralph-test-support.mjs';

/**
 * Жизненный цикл issue целиком, in-process: commit найден → push → ревью →
 * закрытие. До этих тестов путь после валидации не проверялся ничем — по нему
 * можно было пройти только настоящим прогоном с настоящим GitHub.
 *
 * Устройство стенда: git-команды цикла уводятся в одноразовый репозиторий
 * переменными GIT_DIR и GIT_WORK_TREE — cwd команд остаётся прежним, поэтому
 * годится любой путь без относительных pathspec; путь со staging сюда не
 * входит и остаётся за будущим швом. `gh` подменяется скриптом на PATH, который
 * ведёт журнал вызовов и состояние issue в файлах. Ревью-сессию обслуживает
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

/** Одноразовый репозиторий с базовым коммитом, trailer-коммитом и bare origin. */
function createLifecycleRepository(branch) {
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
  writeFileSync(path.join(workTree, 'work.txt'), 'implemented\n', 'utf8');
  git(workTree, ['add', 'work.txt']);
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
function createFakeGh(root) {
  const directory = path.join(root, 'fake-gh');
  mkdirSync(directory);
  const statePath = path.join(directory, 'issue-state.json');
  const callsPath = path.join(directory, 'calls.jsonl');
  writeFileSync(
    statePath,
    JSON.stringify({ number: issueNumber, title: issueTitle, body: issueBody, state: 'open' }),
    'utf8',
  );
  writeFileSync(callsPath, '', 'utf8');

  // Логика подделки — CommonJS, потому что на Windows она подключается через
  // NODE_OPTIONS --require: цикл запускает `gh.exe`, найденный по PATH, и
  // текстовый шим тут не годится — CreateProcess исполняет только настоящие
  // exe. Поэтому gh.exe — копия node.exe, а поведение задаёт preload, который
  // узнаёт себя по имени исполняемого файла. На POSIX достаточно shell-шима.
  const logicPath = path.join(directory, 'fake-gh-logic.cjs');
  writeFileSync(
    logicPath,
    `
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const nodePath = require('node:path');
const executable = nodePath.basename(process.execPath).toLowerCase();
const invokedAsGh = executable === 'gh.exe' || executable === 'gh';
const invokedAsScript = process.argv[1] === __filename;
if (invokedAsGh || invokedAsScript) {
  const statePath = ${JSON.stringify(statePath)};
  const callsPath = ${JSON.stringify(callsPath)};
  const args = process.argv.slice(invokedAsScript ? 2 : 1);
  let method = 'GET';
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--method') method = args[++i];
    else if (args[i] === '--input') i += 1;
    else if (args[i] === '-F' || args[i] === '-f') i += 1;
    else positional.push(args[i]);
  }
  const resource = positional[1] ?? '';
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {}
  appendFileSync(callsPath, JSON.stringify({ method, resource, input }) + '\\n', 'utf8');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (method === 'PATCH') {
    Object.assign(state, JSON.parse(input || '{}'));
    writeFileSync(statePath, JSON.stringify(state), 'utf8');
    process.stdout.write(JSON.stringify(state));
  } else if (method === 'POST') {
    process.stdout.write('{}');
  } else if (/comments/.test(resource)) {
    process.stdout.write('[]');
  } else {
    process.stdout.write(JSON.stringify(state));
  }
  process.exit(0);
}
`,
    'utf8',
  );

  if (process.platform === 'win32') {
    copyFileSync(process.execPath, path.join(directory, 'gh.exe'));
  } else {
    const executablePath = path.join(directory, 'gh');
    writeFileSync(executablePath, `#!/bin/sh
exec node "${logicPath}" "$@"
`, 'utf8');
    chmodSync(executablePath, 0o755);
  }

  return {
    directory,
    logicPath,
    calls: () =>
      readFileSync(callsPath, 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    issueState: () => JSON.parse(readFileSync(statePath, 'utf8')),
  };
}

/**
 * Минимальное хранилище состояния: то же поведение, что у настоящего
 * beginIssue/updateIssue/clearIssue, плюс журнал фаз для проверок.
 */
function recordingStateStore(initialIssue = null) {
  const record = { issue: initialIssue, phases: [] };

  return {
    record,
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
function codexSource(reviewOutputPath, verdictJson, commit) {
  return `
import { appendFileSync, writeFileSync } from 'node:fs';
const reviewOutputPath = ${JSON.stringify(reviewOutputPath)};
appendFileSync(reviewOutputPath + '.invocations', process.argv.includes(reviewOutputPath) ? 'review\\n' : 'development\\n', 'utf8');
const message = (text) =>
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text } }) + '\\n');
if (process.argv.includes(reviewOutputPath)) {
  writeFileSync(reviewOutputPath, ${JSON.stringify(verdictJson)}, 'utf8');
  message('Review recorded.');
} else {
  message('ALREADY_FIXED: ${commit}');
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
    validationMode: 'host',
    preflightScripts: [],
    validationScripts: [],
    validationArtifactPaths: [],
    maxReviewFixAttempts: 2,
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
  };
}

async function withLifecycleStand(branch, verdictJson, operation) {
  const repository = createLifecycleRepository(branch);
  repository.branch = branch;
  const gh = createFakeGh(repository.root);
  const reviewOutputPath = path.join(repository.root, 'review-result.json');
  const savedEnv = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    PATH: null,
  };
  const restoreVariable = (name) => {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  };

  try {
    await withFakeCodex(
      codexSource(reviewOutputPath, verdictJson, repository.commit),
      async () => {
        savedEnv.PATH = process.env.PATH;
        process.env.PATH = `${gh.directory}${path.delimiter}${process.env.PATH}`;
        process.env.GIT_DIR = path.join(repository.workTree, '.git');
        process.env.GIT_WORK_TREE = repository.workTree;
        if (process.platform === 'win32') {
          // gh.exe — копия node.exe; поведение ему выдаёт preload, который
          // в любом другом процессе node узнаёт чужое имя и молчит.
          process.env.NODE_OPTIONS =
            `${savedEnv.NODE_OPTIONS ?? ''} --require ${gh.logicPath}`.trim();
        }
        try {
          await operation({ repository, gh, reviewOutputPath });
        } finally {
          process.env.PATH = savedEnv.PATH;
          restoreVariable('GIT_DIR');
          restoreVariable('GIT_WORK_TREE');
          restoreVariable('NODE_OPTIONS');
        }
      },
    );
  } finally {
    setActiveStateStore(null);
    rmSync(repository.root, { recursive: true, force: true });
  }
}

function codexInvocations(reviewOutputPath) {
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

test('счастливый путь: найденный commit доходит до push, ревью и закрытия issue', async () => {
  await withLifecycleStand('ralph/lifecycle-pass', passVerdict, async (stand) => {
    const store = recordingStateStore();
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);

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

    // Сессия агента не запускалась: trailer-коммит уже содержал работу.
    assert.deepEqual(codexInvocations(stand.reviewOutputPath), ['review']);

    // Issue закрыта как выполненная, и до того порядок фаз дошёл до закрытия.
    assert.equal(stand.gh.issueState().state, 'closed');
    const patches = stand.gh.calls().filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.match(patches[0].input, /"state":"closed"/);
    assert.deepEqual(store.record.phases, ['validating', 'pushed', 'reviewing', 'closing']);
    assert.equal(store.issue, null);
  });
});

test('отказ ревью возвращает issue агенту, повторный отказ паркует её', async () => {
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

    // Второй заход: сессия чинит поверх HEAD, ревью отклоняет снова — и issue
    // паркуется, освобождая бюджет прогона остальным задачам.
    const second = await runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');

    assert.equal(second.completed, false);
    assert.equal(second.parked, true);
    assert.equal(store.issue, null);
    assert.deepEqual(codexInvocations(stand.reviewOutputPath), [
      'review',
      'development',
      'review',
    ]);
  });
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
      validationFixAttempts: 0,
    });
    setActiveStateStore(store);
    const config = lifecycleConfig(stand.repository, stand.reviewOutputPath);

    const result = await runAgentOnIssue(config, 'owner/repository', lifecycleIssue(), 'rules');

    assert.equal(result.completed, true);
    assert.match(result.review.summary, /previous run/);
    // Ни одной сессии агента: ни разработки, ни повторного ревью.
    assert.deepEqual(codexInvocations(stand.reviewOutputPath), []);
    assert.equal(stand.gh.issueState().state, 'closed');
    assert.equal(store.issue, null);
  });
});
