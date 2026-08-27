import { createHash } from 'node:crypto';

import { fail, isRalphInfrastructureIssue } from './ralph-scope.mjs';
import { activeStateStore } from './ralph-state-store.mjs';
import { issueDetails, patchIssue } from './ralph-github-client.mjs';

/**
 * Договор Ralph с issue: что считается доверенным содержимым и какие маркеры
 * Ralph дописывает в тело.
 *
 * Обе части лежат вместе, потому что snapshot сравнивается с телом, из
 * которого маркеры вырезаны: разделение развело бы формат маркера и его
 * вырезание по разным файлам.
 */

export function issueContentHash(issue) {
  const canonicalBody = String(issue.body ?? '')
    .replaceAll('\r\n', '\n')
    .replace(/\n+$/, '');
  return createHash('sha256')
    .update(JSON.stringify({ title: issue.title ?? '', body: canonicalBody }))
    .digest('hex');
}

function assertTrustedIssueAuthor(config, issue, repository) {
  if (isRalphInfrastructureIssue(issue)) {
    rejectUntrustedIssue(
      `Issue #${issue.number} относится к Ralph-инфраструктуре. ` +
        'Ralph выполняет только продуктовые задачи; настройка цикла выполняется вручную.',
    );
  }
  const author = typeof issue.authorLogin === 'string' ? issue.authorLogin : '';
  const repositoryOwner = repository?.split('/')[0]?.toLowerCase();
  const trustedAuthors = new Set(
    [...(config.trustedIssueAuthors ?? []), repositoryOwner]
      .filter(Boolean)
      .map((trustedAuthor) => trustedAuthor.toLowerCase()),
  );
  if (!trustedAuthors.has(author.toLowerCase())) {
    rejectUntrustedIssue(
      `Issue #${issue.number} authored by "${author || 'unknown'}" is not trusted. ` +
        'Only the repository owner or authors configured in trustedIssueAuthors may provide AFK instructions.',
    );
  }
}

export function approveConfiguredIssue(
  config,
  issue,
  repository,
  stateStore = activeStateStore(),
  { replace = false } = {},
) {
  const key = String(issue.number);
  if ((config.approvedIssueSnapshots?.[key] && !replace) || !config.autoApproveConfiguredIssues) {
    return issue;
  }

  assertTrustedIssueAuthor(config, issue, repository);
  const snapshot = {
    title: issue.title,
    body: issueBodyWithoutRalphMetadata(issue),
  };
  const approvedSnapshot =
    stateStore?.approveIssueSnapshot(issue.number, snapshot, replace) ?? snapshot;
  config.approvedIssueSnapshots[key] = approvedSnapshot;
  console.log(
    `Issue #${issue.number}: immutable snapshot снят с текущего содержимого issue ` +
      'на GitHub при первом запуске.',
  );
  return issue;
}

function rejectUntrustedIssue(message) {
  const error = new Error(message);
  error.code = 'RALPH_UNTRUSTED_ISSUE';
  throw error;
}

export function assertTrustedIssue(config, issue, repository) {
  assertTrustedIssueAuthor(config, issue, repository);
  const snapshot = config.approvedIssueSnapshots?.[String(issue.number)];
  if (!snapshot) {
    rejectUntrustedIssue(
      `Issue #${issue.number} has no approved immutable snapshot. ` +
        'Add its exact title and body to approvedIssueSnapshots before AFK execution.',
    );
  }
  const issueAuthoredContent = {
    title: issue.title,
    body: issueBodyWithoutRalphMetadata(issue),
  };
  if (issueContentHash(issueAuthoredContent) !== issueContentHash(snapshot)) {
    rejectUntrustedIssue(
      `Issue #${issue.number} does not match the approved immutable snapshot. ` +
        'Its mutable GitHub title or body changed after approval; review and explicitly update the snapshot.',
    );
  }
  return {
    ...issue,
    title: snapshot.title,
    // Completion markers are only recovery pointers. Review context is retained
    // so the next implementation session receives the latest reviewer findings.
    body: issueBodyWithoutCompletionState(issue),
  };
}

export function formatFindingList(list) {
  return list
    .map((finding) => {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      return `- **${finding.severity} — ${finding.title}** (${location})\n  ${finding.body}`;
    })
    .join('\n');
}

export function formatReviewComment(review) {
  const findings = formatFindingList(review.findings);
  // Замечания ниже порога важности печатаются здесь же: они не отклоняют
  // работу, но читателю нужен их текст, а не число.
  const belowFloor = review.belowFloorFindings?.length
    ? `\n\n### Below the severity floor (not blocking)\n\n${formatFindingList(review.belowFloorFindings)}`
    : '';

  return `## Ralph Loop: independent review found problems\n\n${review.summary}\n\n${findings}${belowFloor}\n\nIssue reopened. Fix the findings, rerun the relevant checks, and start Ralph Loop again.`;
}

export function assertReviewPayloadShape(review, label) {
  if (
    !['pass', 'fail'].includes(review.verdict) ||
    typeof review.summary !== 'string' ||
    !Array.isArray(review.findings)
  ) {
    fail(`${label} вернул некорректный результат.`);
  }
}

export function normalizeReviewResult(review) {
  if (review.verdict === 'fail' && review.findings.length === 0) {
    fail('Review returned FAIL without actionable findings.');
  }

  if (review.verdict === 'pass' && review.findings.length > 0) {
    return {
      ...review,
      verdict: 'fail',
      summary:
        `Codex returned PASS together with ${review.findings.length} actionable findings. ` +
        `Ralph treated the result as FAIL. ${review.summary}`,
    };
  }

  return review;
}

const reviewContextPattern =
  /\n*<!-- ralph-issue-review-context:start -->[\s\S]*?<!-- ralph-issue-review-context:end -->\n*/g;

export function issueBodyWithoutRalphMetadata(issue) {
  return issueBodyWithoutCompletionState(issue).replace(reviewContextPattern, '').trim();
}

/**
 * Замечания прошлого ревью, если они есть в теле issue.
 *
 * Внутри тела блок доезжает до ревьюера без подписи, вперемешку с критериями
 * готовности. Отдельная секция нужна, чтобы можно было потребовать проверить
 * закрытие каждого пункта: неподписанный текст такого требования не выдерживает.
 */
export function reviewContextFromIssueBody(issue) {
  const [block] = issueBodyWithoutCompletionState(issue).match(reviewContextPattern) ?? [];
  if (!block) return null;

  return block
    .replace('<!-- ralph-issue-review-context:start -->', '')
    .replace('<!-- ralph-issue-review-context:end -->', '')
    .trim();
}

export function issueBodyWithReviewContext(issue, review) {
  const startMarker = '<!-- ralph-issue-review-context:start -->';
  const endMarker = '<!-- ralph-issue-review-context:end -->';
  const originalBody = issueBodyWithoutCompletionState(issue)
    .replace(reviewContextPattern, '')
    .trimEnd();
  // В тело issue попадают только блокирующие замечания: этот блок читает
  // следующая fix-сессия, и замечания ниже порога в нём означали бы приказ
  // чинить то, что порог осознанно не блокирует. Их текст живёт в комментарии
  // ревью и в отложенных issues; здесь — только счётчик со ссылкой на них.
  const belowFloorCount = review.belowFloorFindings?.length ?? 0;
  const reviewContext = formatReviewComment({ ...review, belowFloorFindings: undefined }).replace(
    '\n\nIssue reopened. Fix the findings, rerun the relevant checks, and start Ralph Loop again.',
    '',
  );
  const belowFloorNote =
    belowFloorCount > 0
      ? `\n\n${belowFloorCount} finding(s) below the severity floor are tracked as separate deferred GitHub issues and are not part of this issue. Do not fix them here.`
      : '';
  return `${originalBody}\n\n${startMarker}\n${reviewContext}${belowFloorNote}\n${endMarker}`.trim();
}

export function updateIssueReviewContext(repository, issue, review) {
  const latest = issueDetails(repository, issue.number);
  const updatedBody = issueBodyWithReviewContext({ ...issue, body: latest.body }, review);
  issue.body = patchIssue(repository, issue.number, { body: updatedBody }).body;
}

export function issueBodyWithoutCompletionState(issue) {
  return (issue.body ?? '')
    .replace(
      /\n*<!-- ralph-issue-completion status:(?:pending-review|review-passed) commit:[0-9a-f]{40} -->\n*/gi,
      '\n',
    )
    .trim();
}

// Формат читается, но не записывается: тела issue прежних прогонов содержат
// этот маркер, и он не должен попадать в prompt.
export function issueCompletionState(issue) {
  const match = (issue.body ?? '').match(
    /<!-- ralph-issue-completion status:(pending-review|review-passed) commit:([0-9a-f]{40}) -->/i,
  );
  return match ? { status: match[1].toLowerCase(), commit: match[2].toLowerCase() } : null;
}

// Убирает маркер прежних версий из тела issue. Ничего не делает, когда его
// там нет, поэтому лишнего GitHub-запроса на чистых issue не будет.
export function clearIssueCompletionState(repository, issue) {
  const latest = issueDetails(repository, issue.number);
  const updatedBody = issueBodyWithoutCompletionState({ ...issue, body: latest.body });
  if (updatedBody === (latest.body ?? '').trim()) {
    issue.body = latest.body ?? '';
    return;
  }

  issue.body = patchIssue(repository, issue.number, { body: updatedBody }).body;
}
