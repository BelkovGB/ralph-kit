import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeMilestone,
  ensurePullRequestForBranch,
  existingPullRequest,
  verifyPullRequestTarget,
} from './ralph-github-client.mjs';
import { run } from './ralph-process-runner.mjs';
import { withFakeGh } from './ralph-test-support.mjs';

/**
 * Механика PR и milestone, переехавшая из цикла: до переноса эти функции были
 * недостижимы тестами — вызывались только через defaultActions из main.
 *
 * gh подменяется сценарием: список пар «регулярное выражение по строке
 * аргументов → тело ответа», первое совпадение отвечает. Git не подменяется:
 * verifyPullRequestTarget читает HEAD, и тест сверяет его с настоящим.
 */

function scriptedGhLogic(responsesPath, callsPath) {
  return `
  const { appendFileSync, readFileSync } = require('node:fs');
  const joined = ghArguments.join(' ');
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(joined) + String.fromCharCode(10), 'utf8');
  const responses = JSON.parse(readFileSync(${JSON.stringify(responsesPath)}, 'utf8'));
  const found = responses.find((response) => new RegExp(response.pattern).test(joined));
  if (!found) {
    process.stderr.write('fake gh: нет ответа на ' + joined);
    process.exit(1);
  }
  process.stdout.write(found.body);
`;
}

async function withScriptedGh(responses, operation) {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-gh-scripted-'));
  const responsesPath = path.join(root, 'responses.json');
  const callsPath = path.join(root, 'calls.jsonl');
  writeFileSync(responsesPath, JSON.stringify(responses), 'utf8');
  writeFileSync(callsPath, '', 'utf8');

  try {
    await withFakeGh(scriptedGhLogic(responsesPath, callsPath), async () => {
      await operation({
        calls: () =>
          readFileSync(callsPath, 'utf8')
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const config = {
  branch: 'ralph/gh-mechanics',
  baseBranch: 'main',
  milestone: 'Фаза 1: механика',
  draftPullRequest: true,
  githubAccount: null,
};

function pullRequestJson(overrides = {}) {
  return {
    number: 7,
    url: 'https://example.test/pull/7',
    title: config.milestone,
    headRefOid: run('git', ['rev-parse', 'HEAD']).stdout,
    headRefName: config.branch,
    baseRefName: config.baseBranch,
    ...overrides,
  };
}

test('existingPullRequest возвращает первый открытый PR ветки или null', async () => {
  await withScriptedGh(
    [{ pattern: '^pr list', body: JSON.stringify([{ number: 7, url: 'https://example.test/pull/7' }]) }],
    async () => {
      assert.deepEqual(existingPullRequest(config, 'owner/repository'), {
        number: 7,
        url: 'https://example.test/pull/7',
      });
    },
  );

  await withScriptedGh([{ pattern: '^pr list', body: '[]' }], async () => {
    assert.equal(existingPullRequest(config, 'owner/repository'), null);
  });
});

test('verifyPullRequestTarget принимает совпавший PR и называет каждое расхождение', async () => {
  const matching = pullRequestJson();
  assert.deepEqual(verifyPullRequestTarget(config, matching), matching);

  assert.throws(
    () =>
      verifyPullRequestTarget(config, {
        ...matching,
        headRefName: 'feature/other',
        headRefOid: 'deadbeef',
      }),
    (error) => {
      assert.match(error.message, /head=feature\/other/);
      assert.match(error.message, /local HEAD=/);
      return true;
    },
  );
});

test('ensurePullRequestForBranch переиспользует существующий PR, не создавая нового', async () => {
  const details = pullRequestJson();
  await withScriptedGh(
    [
      { pattern: '^pr list', body: JSON.stringify([{ number: 7, url: details.url }]) },
      { pattern: '^pr view 7', body: JSON.stringify(details) },
    ],
    async (gh) => {
      assert.deepEqual(ensurePullRequestForBranch(config, 'owner/repository'), details);
      assert.equal(gh.calls().some((call) => /^pr create/.test(call)), false);
    },
  );
});

test('ensurePullRequestForBranch создаёт черновик и проверяет его же', async () => {
  const details = pullRequestJson();
  await withScriptedGh(
    [
      { pattern: '^pr list', body: '[]' },
      { pattern: '^pr create', body: details.url },
      { pattern: '^pr view', body: JSON.stringify(details) },
    ],
    async (gh) => {
      assert.deepEqual(ensurePullRequestForBranch(config, 'owner/repository'), details);
      const create = gh.calls().find((call) => /^pr create/.test(call));
      assert.match(create, /--base main/);
      assert.match(create, /--head ralph\/gh-mechanics/);
      assert.match(create, /--draft/);
    },
  );
});

test('closeMilestone закрывает пустой milestone и подтверждает закрытие', async () => {
  await withScriptedGh(
    [
      { pattern: 'issues -f state=open', body: '[]' },
      { pattern: '--method PATCH .*milestones/5', body: JSON.stringify({ state: 'closed' }) },
      { pattern: 'milestones/5$', body: JSON.stringify({ state: 'open' }) },
    ],
    async (gh) => {
      const closed = closeMilestone('owner/repository', { number: 5, title: 'Фаза' });

      assert.equal(closed.state, 'closed');
      assert.equal(gh.calls().some((call) => /--method PATCH/.test(call)), true);
    },
  );
});

test('closeMilestone отказывается закрывать milestone с открытой issue', async () => {
  const openIssue = JSON.stringify([
    { number: 44, title: 'Открытая задача', body: '', html_url: 'https://example.test/44' },
  ]);
  await withScriptedGh(
    [
      { pattern: 'issues -f state=open', body: openIssue },
      { pattern: 'issues/44$', body: JSON.stringify({ state: 'open' }) },
    ],
    async (gh) => {
      assert.throws(
        () => closeMilestone('owner/repository', { number: 5, title: 'Фаза' }),
        /нельзя закрыть: появились открытые issues #44/,
      );
      // До PATCH дело не дошло: milestone остался как был.
      assert.equal(gh.calls().some((call) => /--method PATCH/.test(call)), false);
    },
  );
});
