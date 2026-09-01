import { createHash } from 'node:crypto';

import { fail, isRalphInfrastructureIssue } from './ralph-scope.mjs';
import { run, runNetwork, runtimeSettings } from './ralph-process-runner.mjs';
import { retryTransientOperation } from './ralph-runtime.mjs';
import { parseJson } from './ralph-config.mjs';

/**
 * Обращения к GitHub через `gh`: milestones, issues, комментарии и pull requests.
 *
 * Здесь вызовы API, разбор ответа и сверка ответа с локальным состоянием ветки.
 * Что считать доверенной issue и что писать в её тело — не здесь.
 */

export function repositoryName() {
  const repository = parseJson(
    runNetwork('gh', ['repo', 'view', '--json', 'nameWithOwner']).stdout,
    'gh repo view',
  );
  return repository.nameWithOwner;
}

/**
 * Проверяет, что `gh` авторизован тем аккаунтом, которым Ralph будет работать.
 *
 * Без `githubAccount` хост не называется: Ralph работает активной авторизацией
 * `gh`, а она может быть выдана GitHub Enterprise, и требование github.com
 * остановило бы такую установку на ровном месте.
 *
 * С `githubAccount` проверяется именно он, а не активный аккаунт: команды `gh`
 * получают токен выбранного аккаунта, и проверка активного подтвердила бы не ту
 * авторизацию — отказ пришёл бы уже посреди прогона.
 */
export function verifyGitHubAuthentication(config, dependencies = {}) {
  const execute = dependencies.runNetwork ?? runNetwork;
  if (config.githubAccount == null) {
    execute('gh', ['auth', 'status']);
    return null;
  }
  const login = execute('gh', ['api', 'user', '--jq', '.login']).stdout.trim();
  if (login.toLowerCase() !== config.githubAccount.toLowerCase()) {
    fail(
      `GitHub CLI отдаёт токен аккаунта ${login || '(имя не получено)'}, ` +
        `а в конфиге задан githubAccount "${config.githubAccount}". ` +
        'Выполните gh auth login для этого аккаунта или исправьте поле.',
    );
  }
  return login;
}

/**
 * `gh auth status` завершается нулём при любом залогиненном аккаунте и ничего
 * не говорит о правах на целевой репозиторий. Без этой проверки отказ приходит
 * на push ветки или закрытии issue — то есть после того, как агент отработал,
 * а commit уже создан.
 */
export function verifyRepositoryWriteAccess(repository, dependencies = {}) {
  const execute = dependencies.runNetwork ?? runNetwork;
  const permissions = parseJson(
    execute('gh', ['api', `repos/${repository}`, '--jq', '.permissions']).stdout,
    `gh api repos/${repository}`,
  );
  if (permissions?.push === true) return permissions;

  const login = execute('gh', ['api', 'user', '--jq', '.login'], { allowFailure: true }).stdout;
  fail(
    `Активный аккаунт GitHub${login ? ` (${login})` : ''} не имеет права записи в ${repository}. ` +
      'Ralph остановлен до запуска агента: push и закрытие issue отказали бы уже после его работы.',
  );
}

export function githubPagedArray(repository, resource, fields, source, dependencies = {}) {
  const execute = dependencies.runNetwork ?? runNetwork;
  const maxPages = dependencies.maxPages ?? runtimeSettings().maxPages;
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const args = [
      'api',
      '--method',
      'GET',
      `repos/${repository}/${resource}`,
      ...fields.flatMap(([name, value]) => ['-f', `${name}=${value}`]),
      '-F',
      'per_page=100',
      '-F',
      `page=${page}`,
    ];
    const currentPage = parseJson(execute('gh', args).stdout, `${source}, page ${page}`);
    if (!Array.isArray(currentPage)) {
      fail(`${source} вернул не массив на странице ${page}.`);
    }
    items.push(...currentPage);
    if (currentPage.length < 100) return items;
  }
  fail(
    `${source} достиг лимита ${maxPages * 100} объектов. ` +
      'Увеличьте runtime.maxPages после проверки объёма.',
  );
}

export function verifyMilestone(repository, title) {
  const milestones = githubPagedArray(
    repository,
    'milestones',
    [['state', 'all']],
    'GitHub milestones API',
  );
  const matches = milestones.filter((milestone) => milestone.title === title);

  if (matches.length === 0) {
    fail(`Milestone с точным названием "${title}" не найден в ${repository}.`);
  }
  if (matches.length > 1) {
    fail(`В ${repository} найдено несколько milestones с названием "${title}".`);
  }

  return matches[0];
}

export function openIssues(repository, milestone) {
  const issues = githubPagedArray(
    repository,
    'issues',
    [
      ['state', 'open'],
      ['milestone', milestone.number],
    ],
    'GitHub milestone issues API',
  );

  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: issue.html_url,
      updatedAt: issue.updated_at,
      authorLogin: issue.user?.login ?? null,
      authorAssociation: issue.author_association ?? null,
      labels: issue.labels ?? [],
    }))
    .filter((issue) => {
      if (!isRalphInfrastructureIssue(issue)) return true;
      console.log(
        `Issue #${issue.number} относится к Ralph-инфраструктуре и исключена из очереди.`,
      );
      return false;
    })
    .sort((left, right) => left.number - right.number);
}

export function issueDetails(repository, issueNumber) {
  return parseJson(
    runNetwork('gh', ['api', `repos/${repository}/issues/${issueNumber}`]).stdout,
    `GitHub issue ${issueNumber}`,
  );
}

export function issueState(repository, issueNumber) {
  const issue = issueDetails(repository, issueNumber);
  return issue.state?.toUpperCase();
}

export function refreshIssue(repository, issueNumber) {
  const issue = issueDetails(repository, issueNumber);
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    url: issue.html_url,
    state: issue.state?.toUpperCase(),
    updatedAt: issue.updated_at,
    authorLogin: issue.user?.login ?? null,
    authorAssociation: issue.author_association ?? null,
    labels: issue.labels ?? [],
  };
}

export function patchIssue(repository, issueNumber, values) {
  return parseJson(
    runNetwork(
      'gh',
      ['api', '--method', 'PATCH', `repos/${repository}/issues/${issueNumber}`, '--input', '-'],
      { input: JSON.stringify(values) },
    ).stdout,
    `GitHub update issue ${issueNumber}`,
  );
}

/**
 * Публикация комментария повторяется при временной ошибке: без повтора один 503
 * от GitHub убивает прогон целиком в самом конце — когда ревью уже вернуло PASS
 * и осталось закрыть issue.
 *
 * Повторяется не сам POST, а проверка вместе с ним. Публикация комментария не
 * идемпотентна, и слепой повтор мог бы напечатать его дважды; повтор с
 * перечитыванием списка находит комментарий, если предыдущая попытка всё же
 * дошла, и не делает ничего.
 */
export function postIssueCommentOnce(repository, issueNumber, body, marker) {
  return retryTransientOperation(
    () => {
      const comments = githubPagedArray(
        repository,
        `issues/${issueNumber}/comments`,
        [],
        `GitHub comments for issue #${issueNumber}`,
      );
      if (
        comments.some(
          (comment) => typeof comment.body === 'string' && comment.body.includes(marker),
        )
      ) {
        console.log(`Комментарий ${marker} уже опубликован в issue #${issueNumber}.`);
        return;
      }
      run(
        'gh',
        [
          'api',
          '--method',
          'POST',
          `repos/${repository}/issues/${issueNumber}/comments`,
          '--input',
          '-',
        ],
        { input: JSON.stringify({ body: `${marker}\n${body}`.slice(0, 60_000) }) },
      );
    },
    {
      attempts: runtimeSettings().networkRetryAttempts,
      baseDelayMs: runtimeSettings().networkRetryBaseDelayMs,
      onRetry: (error, attempt, delay) =>
        console.error(
          `Временная ошибка публикации комментария (попытка ${attempt}): ${error.message}. ` +
            `Повтор через ${delay} ms.`,
        ),
    },
  );
}

/**
 * Открытие issue обязательно, комментарий — нет.
 *
 * Закрытая issue выпадает из очереди, поэтому её состояние обязано совпадать с
 * сохранённым, и отказ на нём останавливает цикл. Комментарий же — след для
 * человека: всё, что Ralph читает сам, лежит в теле issue и в state.
 * Обязательный комментарий обрывал бы прогон на сетевой ошибке и уничтожал бы
 * уже сделанную работу.
 */
export function reopenIssueWithComment(repository, issue, comment, dependencies = {}) {
  const readState = dependencies.issueState ?? issueState;
  const reopen = dependencies.patchIssue ?? patchIssue;
  const publish = dependencies.postComment ?? postIssueCommentOnce;

  if (readState(repository, issue.number) === 'CLOSED') {
    reopen(repository, issue.number, { state: 'open' });
  }

  const fingerprint = createHash('sha256').update(comment).digest('hex').slice(0, 20);
  try {
    publish(repository, issue.number, comment, `<!-- ralph-issue-comment id:${fingerprint} -->`);
  } catch (error) {
    console.error(
      `Issue #${issue.number}: не удалось опубликовать комментарий: ${error.message}. ` +
        'Состояние цикла сохранено, потерян только комментарий.',
    );
  }
}

export function milestoneIssues(repository, milestone) {
  const issues = githubPagedArray(
    repository,
    'issues',
    [
      ['state', 'all'],
      ['milestone', milestone.number],
    ],
    `GitHub issues for milestone ${milestone.title}`,
  );

  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state?.toUpperCase(),
      url: issue.html_url,
    }));
}

export function postPullRequestReview(repository, pullRequest, body) {
  const marker = body.match(/<!-- ralph-[^\r\n>]+ -->/)?.[0];
  if (marker) {
    const reviews = githubPagedArray(
      repository,
      `pulls/${pullRequest.number}/reviews`,
      [],
      `GitHub reviews for PR #${pullRequest.number}`,
    );
    if (reviews.some((review) => typeof review.body === 'string' && review.body.includes(marker))) {
      console.log(`Review с marker ${marker} уже опубликован в PR #${pullRequest.number}.`);
      return;
    }
  }
  run(
    'gh',
    [
      'pr',
      'review',
      String(pullRequest.number),
      '--repo',
      repository,
      '--comment',
      '--body-file',
      '-',
    ],
    { input: body.slice(0, 60_000) },
  );
}

// -----------------------------------------------------------------------------
// Pull request ветки и закрытие milestone
// -----------------------------------------------------------------------------
// Переехали из ralph-loop.mjs: их причина меняться — поля JSON, которые отдаёт
// gh, та же, что у остального модуля. Оркестровая половина — валидация, push и
// сверка истории перед PR — осталась в цикле.

export function existingPullRequest(config, repository) {
  const pullRequests = parseJson(
    runNetwork('gh', [
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--head',
      config.branch,
      '--limit',
      '100',
      '--json',
      'number,url',
    ]).stdout,
    'gh pr list',
  );
  return pullRequests[0] ?? null;
}

export function pullRequestDetails(repository, pullRequest) {
  return parseJson(
    runNetwork('gh', [
      'pr',
      'view',
      String(pullRequest),
      '--repo',
      repository,
      '--json',
      'number,url,title,headRefOid,headRefName,baseRefName',
    ]).stdout,
    `gh pr view ${pullRequest}`,
  );
}

export function verifyPullRequestTarget(config, pullRequest) {
  const localHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const violations = [];
  if (pullRequest.headRefName !== config.branch) {
    violations.push(`head=${pullRequest.headRefName}`);
  }
  if (pullRequest.baseRefName !== config.baseBranch) {
    violations.push(`base=${pullRequest.baseRefName}`);
  }
  if (pullRequest.headRefOid !== localHead) {
    violations.push(`GitHub head=${pullRequest.headRefOid}, local HEAD=${localHead}`);
  }
  if (violations.length > 0) {
    fail(`PR #${pullRequest.number} не соответствует текущему запуску: ${violations.join('; ')}.`);
  }

  return pullRequest;
}

/** Возвращает существующий открытый PR ветки или создаёт новый — проверенным. */
export function ensurePullRequestForBranch(config, repository) {
  const existing = existingPullRequest(config, repository);
  if (existing) {
    console.log(`PR уже существует: ${existing.url}`);
    return verifyPullRequestTarget(config, pullRequestDetails(repository, existing.number));
  }

  const args = [
    'pr',
    'create',
    '--base',
    config.baseBranch,
    '--head',
    config.branch,
    '--title',
    `${config.milestone}`,
    '--body',
    `Завершены все issues milestone **${config.milestone}**.\n\nPR создан Ralph Loop и требует ручной проверки.`,
  ];
  if (config.draftPullRequest) {
    args.push('--draft');
  }

  // Через runNetwork: создание PR — сетевой вызов, и 503 от GitHub не повод
  // терять прогон. Повторная попытка при уже созданном PR падает своей ошибкой
  // «pull request already exists», а не молча создаёт второй.
  const url = runNetwork('gh', args).stdout;
  console.log(`Создан PR: ${url}`);
  return verifyPullRequestTarget(config, pullRequestDetails(repository, url));
}

export function closeMilestone(repository, milestone) {
  const beforeClose = openIssues(repository, milestone).filter(
    (issue) => issueState(repository, issue.number) === 'OPEN',
  );
  if (beforeClose.length > 0) {
    fail(
      `Milestone #${milestone.number} нельзя закрыть: появились открытые issues ` +
        beforeClose.map((issue) => `#${issue.number}`).join(', '),
    );
  }
  const current = parseJson(
    runNetwork('gh', ['api', `repos/${repository}/milestones/${milestone.number}`]).stdout,
    `GitHub milestone ${milestone.number}`,
  );
  if (current.state === 'closed') {
    console.log(`Milestone #${milestone.number} уже закрыт.`);
    return current;
  }

  const closed = parseJson(
    runNetwork('gh', [
      'api',
      '--method',
      'PATCH',
      `repos/${repository}/milestones/${milestone.number}`,
      '-f',
      'state=closed',
    ]).stdout,
    `GitHub close milestone ${milestone.number}`,
  );
  if (closed.state !== 'closed') {
    fail(`Milestone #${milestone.number} не закрылся после PASS.`);
  }
  console.log(`Milestone #${milestone.number} закрыт после чистого PASS.`);
  const afterClose = openIssues(repository, milestone).filter(
    (issue) => issueState(repository, issue.number) === 'OPEN',
  );
  if (afterClose.length > 0) {
    runNetwork('gh', [
      'api',
      '--method',
      'PATCH',
      `repos/${repository}/milestones/${milestone.number}`,
      '-f',
      'state=open',
    ]);
    fail(
      `После закрытия milestone появились issues ${afterClose
        .map((issue) => `#${issue.number}`)
        .join(', ')}; milestone снова открыт.`,
    );
  }
  return closed;
}
