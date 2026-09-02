import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import {
  applySeverityFloor,
  fail,
  isRalphInfrastructurePath,
  scopeMilestoneReviewToProduct,
} from './ralph-scope.mjs';
import { run, runNetwork, runtimeSettings } from './ralph-process-runner.mjs';
import { retryTransientOperation } from './ralph-runtime.mjs';
import { runReviewWithRetries } from './ralph-agent-session.mjs';
import { runReviewSession } from './ralph-agent-backends.mjs';
import { parseJson } from './ralph-config.mjs';
import {
  githubPagedArray,
  milestoneIssues,
  patchIssue,
  postIssueCommentOnce,
  postPullRequestReview,
} from './ralph-github-client.mjs';
import { branchChangeInventory, isAncestorCommit } from './ralph-git.mjs';
import { assertReviewPayloadShape, normalizeReviewResult } from './ralph-issue-contract.mjs';
import { buildMilestoneReviewPrompt } from './ralph-prompts.mjs';

/**
 * Итоговое ревью milestone и превращение его замечаний в GitHub issues.
 */

function milestoneReviewIdentity(config, milestone) {
  return createHash('sha256')
    .update(
      `${milestone.number}\n${milestone.title}\n${milestone.description ?? ''}\n${config.baseBranch}`,
    )
    .digest('hex')
    .slice(0, 16);
}

export function milestoneReviewMarker(config, milestone, pullRequest) {
  return `<!-- ralph-milestone-review milestone:${milestoneReviewIdentity(config, milestone)} head:${pullRequest.headRefOid} model:${config.milestoneReview.model} effort:${config.milestoneReview.effort} -->`;
}

// Второй маркер рядом с основным: ревью, которое не вместило все findings в
// maxFindings, не имеет права быть базой инкрементального круга — отрезанные
// findings живут только в невыполненном обещании «deferred to the next full
// review», и сузить следующий круг значило бы потерять их навсегда.
export const milestonePartialCoverageMarker = '<!-- ralph-milestone-review-coverage:partial -->';

/**
 * Последнее опубликованное milestone-ревью этого PR: его head и полный текст.
 *
 * Источник — сам PR, а не локальный state: выходной файл ревью перезаписывается
 * каждым прогоном и не переживает смену машины, а опубликованный review — это
 * ровно тот результат, который оркестратор признал и показал людям. Маркер
 * привязан к milestone (номер, title, description, база), поэтому ревью чужой
 * фазы на том же PR не считается предыдущим. Маркеры технических отказов
 * (`ralph-milestone-review-failed`) префиксом не совпадают и не учитываются.
 *
 * Базой инкрементального круга признаётся только новейшее подходящее ревью, и
 * только целиком совместимое: сделанное текущей моделью с текущим effort (смена
 * модели — документированный способ заказать свежий полный аудит) и не
 * помеченное как partial. Несовместимое новейшее ревью не заменяется более
 * старым: старое уже перекрыто новым, и опираться на него значило бы проверять
 * закрытие устаревших findings.
 */
export function lastPublishedMilestoneReview(
  config,
  milestone,
  repository,
  pullRequest,
  dependencies = {},
) {
  const listPages = dependencies.githubPagedArray ?? githubPagedArray;
  const prefix = `<!-- ralph-milestone-review milestone:${milestoneReviewIdentity(config, milestone)} head:`;
  const reviews = listPages(
    repository,
    `pulls/${pullRequest.number}/reviews`,
    [],
    `GitHub reviews for PR #${pullRequest.number}`,
  );
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    const body = reviews[index]?.body;
    if (typeof body !== 'string') continue;
    const markerStart = body.indexOf(prefix);
    if (markerStart === -1) continue;
    const head = body.slice(markerStart + prefix.length).match(/^[0-9a-f]{40}/)?.[0];
    if (!head) return null;
    const expectedMarker = milestoneReviewMarker(config, milestone, { headRefOid: head });
    if (!body.includes(expectedMarker)) return null;
    if (body.includes(milestonePartialCoverageMarker)) return null;
    return { head, body };
  }
  return null;
}

export function milestonePassReviewIsClean(body, marker) {
  if (typeof body !== 'string' || !body.includes(marker)) {
    return false;
  }

  const normalized = body.replace(/\r\n/g, '\n').trim();
  const findingsSections = normalized.match(/^### Findings\s*$/gm) ?? [];
  // Секция «ниже порога» не мешает чистоте PASS: такие замечания по определению
  // не блокируют работу, вынесены в отложенные issues, и повторное ревью того
  // же head вернуло бы тот же вердикт. Без этого допуска short-circuit не
  // срабатывал бы ни на одном PASS при поднятом reviewSeverityFloor.
  return (
    findingsSections.length === 1 &&
    normalized.includes('**Verdict:** **PASS**') &&
    /### Findings\s*\n\s*No actionable findings\.\s*\n(?:\s*### Below the severity floor \(not blocking\)\s*\n[\s\S]*?)?\s*The pull request remains draft so a human can make the final merge decision\.\s*$/.test(
      normalized,
    )
  );
}

function milestonePassWasPublished(config, repository, milestone, pullRequest) {
  const marker = milestoneReviewMarker(config, milestone, pullRequest);
  const reviews = githubPagedArray(
    repository,
    `pulls/${pullRequest.number}/reviews`,
    [],
    `GitHub reviews for PR #${pullRequest.number}`,
  );

  return reviews.some((review) => milestonePassReviewIsClean(review.body, marker));
}

export function limitMilestoneReviewFindings(review, pullRequest, maxFindings) {
  const priorities = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const unique = new Map();
  for (const finding of review.findings) {
    unique.set(reviewFindingFingerprint(pullRequest, finding), finding);
  }
  const sorted = [...unique.values()].sort((left, right) => {
    const severity = (priorities[left.severity] ?? 99) - (priorities[right.severity] ?? 99);
    if (severity !== 0) return severity;
    return `${left.file}:${left.line}:${left.title}`.localeCompare(
      `${right.file}:${right.line}:${right.title}`,
    );
  });
  const omitted = Math.max(0, sorted.length - maxFindings);
  return {
    ...review,
    summary:
      omitted > 0
        ? `${review.summary} Ralph queued the first ${maxFindings} unique findings by severity; ${omitted} findings were deferred to the next full review.`
        : review.summary,
    findings: sorted.slice(0, maxFindings),
    // Признак неполного покрытия попадает в публикуемый маркер: такое ревью не
    // может служить базой инкрементального круга.
    omittedFindings: omitted,
  };
}

function formatFindingList(list) {
  return list
    .map((finding) => {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      return `- **${finding.severity} — ${finding.title}** (${location})\n  ${finding.body}`;
    })
    .join('\n');
}

function formatMilestoneReview(config, milestone, pullRequest, review) {
  const findings = review.findings.length
    ? formatFindingList(review.findings)
    : 'No actionable findings.';
  // Замечания ниже порога печатаются целиком, а не пересчитываются: вырезанные
  // до сборки комментария, они оставили бы отчёт с пустым списком под фразой
  // «четыре замечания ниже порога» — то есть исчезли бы из виду ровно там, где
  // порог обещал их сохранить.
  const belowFloor = review.belowFloorFindings?.length
    ? `\n### Below the severity floor (not blocking)\n\n${formatFindingList(review.belowFloorFindings)}\n`
    : '';
  const verdict = review.verdict === 'pass' ? 'PASS' : 'FINDINGS';

  const nextStep =
    review.verdict === 'pass'
      ? 'The pull request remains draft so a human can make the final merge decision.'
      : 'Ralph Loop will create or reopen one milestone issue per finding, run the implementation loop, push the fixes, and review the new head again.';

  const coverageMarker = review.omittedFindings > 0 ? `\n${milestonePartialCoverageMarker}` : '';

  return `${milestoneReviewMarker(config, milestone, pullRequest)}${coverageMarker}
## Ralph Loop: milestone review

- **Model:** \`${config.milestoneReview.model}\`
- **Milestone:** ${milestone.title}
- **Reviewed head:** \`${pullRequest.headRefOid}\`
- **Verdict:** **${verdict}**

${review.summary}

### Findings

${findings}
${belowFloor}
${nextStep}`;
}

function postMilestoneReviewFailure(config, repository, milestone, pullRequest, message) {
  const marker = milestoneReviewMarker(config, milestone, pullRequest).replace(
    'ralph-milestone-review ',
    'ralph-milestone-review-failed ',
  );
  postPullRequestReview(
    repository,
    pullRequest,
    `${marker}\n## Ralph Loop: milestone review did not complete\n\n${message}\n\nThe PR remains draft. Restart Ralph Loop after resolving the failure.`,
  );
}

export async function runMilestoneReview(config, repository, milestone, pullRequest) {
  if (!config.milestoneReview.enabled) {
    console.log('Milestone review выключен в конфиге.');
    return {
      verdict: 'pass',
      summary: 'Milestone review is disabled in config.',
      findings: [],
    };
  }

  if (milestonePassWasPublished(config, repository, milestone, pullRequest)) {
    console.log(
      `Milestone уже проверен моделью ${config.milestoneReview.model} для commit ${pullRequest.headRefOid}.`,
    );
    return {
      verdict: 'pass',
      summary: 'PASS review for this head was already published.',
      findings: [],
    };
  }

  // Со второго круга ревью инкрементально: инвентарь сужается до коммитов после
  // уже отревьюенного head, а прежнее ревью передаётся дословно с требованием
  // проверить закрытие его findings. Полный аудит остаётся на первом круге, при
  // выключенном milestoneReview.incremental и когда прежний head не является
  // предком текущего (force-push, другая база).
  let changes = null;
  let previousReview = null;
  if (config.milestoneReview.incremental) {
    const previous = lastPublishedMilestoneReview(config, milestone, repository, pullRequest);
    if (previous?.head === pullRequest.headRefOid) {
      // Тот же head: новых коммитов нет, инвентарь не нужен — только проверка
      // закрытия прежних findings.
      previousReview = { head: previous.head, body: previous.body, hasNewCommits: false };
    } else if (previous && isAncestorCommit(previous.head, pullRequest.headRefOid)) {
      // Merge базы в ветку («Update branch» на PR) оставляет прежний head
      // предком, но заливает диапазон всей чужой работой из базы: инвентарь
      // распух бы упущенным, а настоящие правки milestone утонули бы за
      // бюджетом diff. Любой merge в диапазоне — и любая неуверенность в его
      // отсутствии — возвращает полный аудит.
      const merges = run(
        'git',
        ['rev-list', '--merges', `${previous.head}..${pullRequest.headRefOid}`],
        { allowFailure: true },
      );
      const incrementalChanges =
        merges.status === 0 && merges.stdout === ''
          ? branchChangeInventory(previous.head, pullRequest.headRefOid)
          : null;
      if (incrementalChanges) {
        changes = incrementalChanges;
        previousReview = { head: previous.head, body: previous.body, hasNewCommits: true };
        console.log(
          `Milestone review инкрементально: предыдущее ревью на ${previous.head.slice(0, 8)}, ` +
            'проверяются коммиты после него.',
        );
      }
    }
  }
  if (!previousReview) {
    // База берётся с origin, а не с локальной ветки: локальная может отставать,
    // и тогда в diff попадёт чужая работа, которую ревьюер обязан игнорировать.
    changes = branchChangeInventory(`origin/${config.baseBranch}`, pullRequest.headRefOid);
  }
  const reviewPrompt = buildMilestoneReviewPrompt(config, milestone, pullRequest, {
    changes,
    previousReview,
  });

  console.log(
    `\n=== Milestone review for PR #${pullRequest.number} (${config.milestoneReview.model}) ===\n`,
  );

  let review;
  try {
    review = await runReviewWithRetries(
      config,
      async () => {
        if (run('git', ['status', '--porcelain']).stdout !== '') {
          const error = new Error('Milestone review требует чистое рабочее дерево.');
          error.nonRetryable = true;
          throw error;
        }
        const reviewedHead = run('git', ['rev-parse', 'HEAD']).stdout;
        const reviewedBranch = run('git', ['branch', '--show-current']).stdout;
        if (existsSync(config.milestoneReview.outputPath)) {
          unlinkSync(config.milestoneReview.outputPath);
        }

        await runReviewSession(config, config.milestoneReview, {
          input: reviewPrompt,
          maxTurns: config.milestoneReview.maxTurns,
          timeoutMs: config.runtime.agentTimeoutMs,
          label: `Milestone review PR #${pullRequest.number}`,
        });
        if (!existsSync(config.milestoneReview.outputPath)) {
          fail(`Milestone review PR #${pullRequest.number} не создал файл результата.`);
        }

        const candidate = parseJson(
          readFileSync(config.milestoneReview.outputPath, 'utf8'),
          config.milestoneReview.outputPath,
        );
        assertReviewPayloadShape(candidate, `Milestone review PR #${pullRequest.number}`);
        const normalized = normalizeReviewResult(candidate);
        const changed = run('git', ['status', '--porcelain']).stdout !== '';
        const headChanged = run('git', ['rev-parse', 'HEAD']).stdout !== reviewedHead;
        const branchChanged = run('git', ['branch', '--show-current']).stdout !== reviewedBranch;
        if (changed || headChanged || branchChanged) {
          const error = new Error(
            `Milestone review PR #${pullRequest.number} изменил Git-состояние.`,
          );
          error.nonRetryable = true;
          throw error;
        }
        return normalized;
      },
      `Milestone review PR #${pullRequest.number}`,
    );
  } catch (error) {
    try {
      postMilestoneReviewFailure(config, repository, milestone, pullRequest, error.message);
    } catch (commentError) {
      console.error(`Не удалось опубликовать ошибку milestone review: ${commentError.message}`);
    }
    fail(`Milestone review PR #${pullRequest.number} не завершился: ${error.message}`);
  }
  review = applySeverityFloor(
    scopeMilestoneReviewToProduct(review),
    config.reviewSeverityFloor,
    'Milestone review',
  );
  review = limitMilestoneReviewFindings(review, pullRequest, config.milestoneReview.maxFindings);

  postPullRequestReview(
    repository,
    pullRequest,
    formatMilestoneReview(config, milestone, pullRequest, review),
  );
  recordDeferredFindingsSafely(
    config,
    repository,
    review,
    `milestone review of PR #${pullRequest.number} at head ${pullRequest.headRefOid}`,
  );
  console.log(
    `Milestone review опубликован в ${pullRequest.url}: ${review.verdict.toUpperCase()} (${review.findings.length} findings).`,
  );
  return review;
}

// -----------------------------------------------------------------------------
// Преобразование замечаний milestone-review в GitHub issues
// -----------------------------------------------------------------------------

export function reviewFindingFingerprint(pullRequest, finding) {
  const normalizedTitle = finding.title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const source = [pullRequest.number, finding.severity, finding.file, normalizedTitle].join('\n');
  return createHash('sha256').update(source).digest('hex').slice(0, 20);
}

export function reviewFindingMarker(pullRequest, finding) {
  return `<!-- ralph-milestone-finding pr:${pullRequest.number} id:${reviewFindingFingerprint(pullRequest, finding)} -->`;
}

/**
 * Замечания, которые имеет смысл чинить одной задачей.
 *
 * Ключ — файл и полоса важности. Файл потому, что фиксированная часть цикла —
 * холодная сессия, чтение репозитория, проверки, ревью — не зависит
 * от размера правки: замечания к одному файлу, разнесённые по разным задачам,
 * стоят по целому циклу каждое.
 *
 * Полоса важности потому, что задача закрывается целиком: без разделения
 * косметическое P3, не прошедшее ревью, держало бы открытым исправленный P1.
 */
const criticalSeverities = new Set(['P0', 'P1']);

function findingBatchKey(finding) {
  return `${criticalSeverities.has(finding.severity) ? 'critical' : 'routine'}\n${finding.file}`;
}

export function groupFindingsIntoBatches(findings, maxBatchSize = 5) {
  const batches = new Map();
  for (const finding of findings) {
    const key = findingBatchKey(finding);
    const open = batches.get(key);
    // Ограничение размера: задача должна оставаться обозримой на ревью.
    if (open && open.at(-1).length < maxBatchSize) open.at(-1).push(finding);
    else if (open) open.push([finding]);
    else batches.set(key, [[finding]]);
  }

  return [...batches.values()].flat();
}

function severityRank(severity) {
  return Number.parseInt(String(severity).replace(/\D/g, ''), 10);
}

function batchSeverity(batch) {
  return batch.reduce((worst, finding) =>
    severityRank(finding.severity) < severityRank(worst.severity) ? finding : worst,
  ).severity;
}

function findingIssueTitle(batch) {
  const [first] = batch;
  const title =
    batch.length === 1
      ? `[${first.severity}] ${first.title}`
      : `[${batchSeverity(batch)}] ${first.file.split('/').at(-1)}: ${batch.length} review findings`;

  return title.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function findingIssueBody(config, pullRequest, batch) {
  // Группа собрана по файлу, поэтому локация у неё одна — и определитель
  // инфраструктурных issues, читающий эту строку, продолжает работать.
  const location =
    batch.length === 1 && batch[0].line ? `${batch[0].file}:${batch[0].line}` : batch[0].file;
  const markers = batch.map((finding) => reviewFindingMarker(pullRequest, finding)).join('\n');
  const findings = batch
    .map((finding, index) => {
      const at = finding.line ? ` (line ${finding.line})` : '';
      const heading =
        batch.length === 1
          ? '## Finding'
          : `### ${index + 1}. [${finding.severity}] ${finding.title}${at}`;
      return `${heading}\n\n${finding.body}`;
    })
    .join('\n\n');
  const checklist = batch
    .map((finding) => `- [ ] [${finding.severity}] ${finding.title}`)
    .join('\n');

  return `${markers}
## Context

**Source:** automated milestone review of PR #${pullRequest.number}
**Milestone:** ${config.milestone}
**Reviewed head:** \`${pullRequest.headRefOid}\`
**Severity:** ${batchSeverity(batch)}
**Location:** \`${location}\`

${findings}

## Definition of done

${checklist}

Fix the root cause of every finding above and add regression coverage for each failure path, without weakening existing tests. The issue is not done until every box is ticked.`;
}

/**
 * Создание задачи повторяется вместе с проверкой, а не само по себе.
 *
 * Без повтора один таймаут TLS-рукопожатия обрывает прогон после того, как
 * milestone-ревью уже отработало — а это самая дорогая сессия цикла. Слепой
 * повтор был бы хуже: POST не идемпотентен, и попытка после дошедшего запроса
 * завела бы вторую задачу с тем же замечанием. Поэтому внутри повтора список
 * задач milestone перечитывается, и задача с тем же marker принимается как уже
 * созданная.
 */
function createReviewFindingIssue(config, repository, milestone, pullRequest, batch) {
  const issue = retryTransientOperation(
    () => {
      const existing = milestoneIssues(repository, milestone).find((candidate) =>
        batch.some((finding) =>
          String(candidate.body ?? '').includes(reviewFindingMarker(pullRequest, finding)),
        ),
      );
      if (existing) {
        console.log(`Задача из этого замечания уже создана: #${existing.number}.`);
        return existing;
      }
      return parseJson(
        run('gh', ['api', `repos/${repository}/issues`, '--method', 'POST', '--input', '-'], {
          input: JSON.stringify({
            title: findingIssueTitle(batch),
            body: findingIssueBody(config, pullRequest, batch),
            milestone: milestone.number,
          }),
        }).stdout,
        'GitHub issue creation',
      );
    },
    {
      attempts: runtimeSettings().networkRetryAttempts,
      baseDelayMs: runtimeSettings().networkRetryBaseDelayMs,
      onRetry: (error, attempt, delay) =>
        console.error(
          `Временная ошибка создания задачи (попытка ${attempt}): ${error.message}. ` +
            `Повтор через ${delay} ms.`,
        ),
    },
  );
  console.log(`Создана issue #${issue.number} из milestone finding: ${issue.html_url}`);
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state?.toUpperCase() ?? 'OPEN',
    url: issue.html_url,
  };
}

function reopenReviewFindingIssue(repository, issue, pullRequest) {
  patchIssue(repository, issue.number, { state: 'open' });
  const marker = `<!-- ralph-finding-reopened head:${pullRequest.headRefOid} issue:${issue.number} -->`;
  postIssueCommentOnce(
    repository,
    issue.number,
    `The milestone review found this issue again at PR head ${pullRequest.headRefOid}. Reopened for another fix iteration.`,
    marker,
  );
  console.log(`Переоткрыта issue #${issue.number}: finding всё ещё присутствует.`);
}

function updateReviewFindingIssue(config, repository, issue, pullRequest, batch) {
  const title = findingIssueTitle(batch);
  const body = findingIssueBody(config, pullRequest, batch);
  const updated = patchIssue(repository, issue.number, { title, body });
  issue.title = updated.title;
  issue.body = updated.body;
}

export function createOrReopenReviewIssues(
  config,
  repository,
  milestone,
  pullRequest,
  review,
  dependencies = {
    milestoneIssues,
    createReviewFindingIssue,
    updateReviewFindingIssue,
    reopenReviewFindingIssue,
  },
) {
  if (review.verdict !== 'fail') {
    return [];
  }
  if (review.findings.length === 0) {
    fail('Milestone review вернул FAIL без findings; задачи исправления создать невозможно.');
  }

  const infrastructureFindings = review.findings.filter((finding) =>
    isRalphInfrastructurePath(finding.file),
  );
  if (infrastructureFindings.length > 0) {
    fail(
      `Milestone review содержит ${infrastructureFindings.length} замечаний к Ralph-инфраструктуре. ` +
        'Они не могут быть превращены в продуктовые issues.',
    );
  }

  const existingIssues = dependencies.milestoneIssues(repository, milestone);
  const queuedIssues = [];
  const queuedNumbers = new Set();
  // Группа разбивается обратно на отдельные замечания, если её пункты уже
  // разъехались по разным задачам прошлого раунда: слияние осиротило бы их со
  // старым содержимым, а это хуже лишней задачи.
  const batches = groupFindingsIntoBatches(review.findings).flatMap((batch) => {
    const matched = new Set(
      batch
        .map((finding) => matchingIssueFor(existingIssues, pullRequest, finding))
        .filter(Boolean)
        .map((issue) => issue.number),
    );
    return matched.size > 1 ? batch.map((finding) => [finding]) : [batch];
  });

  for (const batch of batches) {
    let issue = batch
      .map((finding) => matchingIssueFor(existingIssues, pullRequest, finding))
      .find(Boolean);

    if (!issue) {
      issue = dependencies.createReviewFindingIssue(
        config,
        repository,
        milestone,
        pullRequest,
        batch,
      );
      existingIssues.push(issue);
    } else {
      dependencies.updateReviewFindingIssue(config, repository, issue, pullRequest, batch);
      if (issue.state === 'CLOSED') {
        dependencies.reopenReviewFindingIssue(repository, issue, pullRequest);
        issue.state = 'OPEN';
      } else {
        console.log(`Issue #${issue.number} для finding уже открыта; дубликат не создан.`);
      }
    }

    if (!queuedNumbers.has(issue.number)) {
      queuedNumbers.add(issue.number);
      queuedIssues.push(issue);
    }
  }

  return queuedIssues;
}

function matchingIssueFor(existingIssues, pullRequest, finding) {
  const marker = reviewFindingMarker(pullRequest, finding);

  return existingIssues.find(
    (candidate) => typeof candidate.body === 'string' && candidate.body.includes(marker),
  );
}

// -----------------------------------------------------------------------------
// Отложенные замечания: находки ниже порога важности записываются в GitHub
// -----------------------------------------------------------------------------

/**
 * Порог важности убирает замечание из цикла, но не имеет права его терять:
 * каждое пропущенное замечание становится issue с label ниже — без milestone,
 * поэтому в очередь Ralph оно не попадает и закрытию milestone не мешает.
 * Разбирает такие issues человек: группирует, закрывает как wontfix или
 * назначает milestone, после чего задачу берёт обычный цикл.
 */
export const deferredFindingLabel = 'ralph-deferred';

/**
 * Отпечаток без привязки к PR и кругу ревью: одно и то же замечание, найденное
 * повторно другим ревью, находит свою issue, а не заводит дубликат. Плата
 * двусторонняя, и обе стороны разбираются вручную: переформулированное
 * замечание станет новой issue, а два действительно разных замечания с
 * одинаковыми title, файлом и важностью склеятся в одну — номер строки в
 * отпечаток не входит намеренно, иначе каждый сдвиг кода плодил бы дубликаты.
 */
export function deferredFindingFingerprint(finding) {
  const normalizedTitle = finding.title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const source = [finding.severity, finding.file, normalizedTitle].join('\n');
  return createHash('sha256').update(source).digest('hex').slice(0, 20);
}

export function deferredFindingMarker(finding) {
  return `<!-- ralph-deferred-finding id:${deferredFindingFingerprint(finding)} -->`;
}

function listDeferredIssues(repository) {
  return githubPagedArray(
    repository,
    'issues',
    [
      ['state', 'all'],
      ['labels', deferredFindingLabel],
    ],
    `GitHub issues with label ${deferredFindingLabel}`,
  )
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      state: issue.state?.toUpperCase(),
      body: issue.body,
      url: issue.html_url,
    }));
}

const ensuredDeferredLabelRepositories = new Set();

// `--force` делает команду идемпотентной: существующий label обновляется, а не
// вызывает ошибку. Без label дедупликация не работает, поэтому отказ здесь
// прерывает запись отложенных замечаний целиком.
function ensureDeferredFindingLabel(repository) {
  if (ensuredDeferredLabelRepositories.has(repository)) return;
  runNetwork('gh', [
    'label',
    'create',
    deferredFindingLabel,
    '--repo',
    repository,
    '--force',
    '--color',
    'D4C5F9',
    '--description',
    'Ralph: review finding below the severity floor, deferred for manual triage',
  ]);
  ensuredDeferredLabelRepositories.add(repository);
}

function deferredFindingIssueBody(config, batch, source) {
  const location =
    batch.length === 1 && batch[0].line ? `${batch[0].file}:${batch[0].line}` : batch[0].file;
  const markers = batch.map((finding) => deferredFindingMarker(finding)).join('\n');
  const findings = batch
    .map((finding, index) => {
      const at = finding.line ? ` (line ${finding.line})` : '';
      const heading =
        batch.length === 1
          ? '## Finding'
          : `### ${index + 1}. [${finding.severity}] ${finding.title}${at}`;
      return `${heading}\n\n${finding.body}`;
    })
    .join('\n\n');

  return `${markers}
## Context

**Source:** ${source}
**Severity:** ${batchSeverity(batch)}
**Location:** \`${location}\`
**Deferred:** below the "${config.reviewSeverityFloor}" review severity floor; not queued for the Ralph loop.

${findings}

## Definition of done

${batch.map((finding) => `- [ ] [${finding.severity}] ${finding.title}`).join('\n')}

## Triage

This finding did not block the work and was recorded for a human decision. Close it as wontfix, fold it into another issue, or assign it to a milestone to schedule the fix; Ralph ignores it while it carries no milestone.`;
}

// Тот же принцип повтора, что и у createReviewFindingIssue: POST не
// идемпотентен, поэтому внутри повтора список перечитывается и задача с тем же
// marker принимается как уже созданная.
function createDeferredFindingIssue(config, repository, batch, source) {
  const issue = retryTransientOperation(
    () => {
      const existing = listDeferredIssues(repository).find((candidate) =>
        batch.some((finding) =>
          String(candidate.body ?? '').includes(deferredFindingMarker(finding)),
        ),
      );
      if (existing) {
        console.log(`Отложенное замечание уже записано: #${existing.number}.`);
        return { ...existing, html_url: existing.url };
      }
      return parseJson(
        run('gh', ['api', `repos/${repository}/issues`, '--method', 'POST', '--input', '-'], {
          input: JSON.stringify({
            title: findingIssueTitle(batch),
            body: deferredFindingIssueBody(config, batch, source),
            labels: [deferredFindingLabel],
          }),
        }).stdout,
        'GitHub deferred issue creation',
      );
    },
    {
      attempts: runtimeSettings().networkRetryAttempts,
      baseDelayMs: runtimeSettings().networkRetryBaseDelayMs,
      onRetry: (error, attempt, delay) =>
        console.error(
          `Временная ошибка записи отложенного замечания (попытка ${attempt}): ${error.message}. ` +
            `Повтор через ${delay} ms.`,
        ),
    },
  );
  return {
    number: issue.number,
    state: issue.state?.toUpperCase() ?? 'OPEN',
    body: issue.body,
    url: issue.html_url,
  };
}

export function recordDeferredFindings(
  config,
  repository,
  review,
  source,
  dependencies = {
    listDeferredIssues,
    createDeferredFindingIssue,
    ensureDeferredFindingLabel,
  },
) {
  const findings = review.belowFloorFindings ?? [];
  if (findings.length === 0) return [];

  dependencies.ensureDeferredFindingLabel(repository);
  const existingIssues = dependencies.listDeferredIssues(repository);
  const recorded = [];
  for (const batch of groupFindingsIntoBatches(findings)) {
    // Дедупликация по каждому замечанию, а не по группе: группа собирается
    // заново на каждом ревью, и одно уже записанное замечание в ней не должно
    // топить остальные. Закрытая issue не переоткрывается: закрыл её человек,
    // и повторная находка того же текста не отменяет его решения.
    const fresh = batch.filter((finding) => {
      const existing = existingIssues.find((candidate) =>
        String(candidate.body ?? '').includes(deferredFindingMarker(finding)),
      );
      if (existing) {
        console.log(
          `Отложенное замечание «${finding.title}» уже записано в issue #${existing.number} ` +
            `(${existing.state}).`,
        );
      }
      return !existing;
    });
    if (fresh.length === 0) continue;
    const issue = dependencies.createDeferredFindingIssue(config, repository, fresh, source);
    existingIssues.push(issue);
    recorded.push(issue);
    console.log(`Создана отложенная issue #${issue.number}: ${issue.url}`);
  }
  if (recorded.length > 0) {
    console.log(
      `Записано отложенных замечаний: ${recorded.length} issue(s) с label ${deferredFindingLabel}; ` +
        'в очередь Ralph они не попадают.',
    );
  }
  return recorded;
}

/**
 * Обёртка для вызова из цикла: отказ GitHub на записи отложенного замечания не
 * имеет права ронять прогон. Текст замечаний при этом не теряется: при FAIL он
 * опубликован в комментарии ревью, при PASS — в комментарии закрытия issue или
 * в milestone-ревью на PR; теряется только карточка в трекере.
 */
export function recordDeferredFindingsSafely(config, repository, review, source) {
  try {
    return recordDeferredFindings(config, repository, review, source);
  } catch (error) {
    console.error(`Не удалось записать отложенные замечания (${source}): ${error.message}`);
    return [];
  }
}
