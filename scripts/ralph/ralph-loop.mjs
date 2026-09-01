#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { acquireRunLock, initializePersistentLog, readJsonFile } from './ralph-runtime.mjs';

import {
  applySeverityFloor,
  fail,
  isRalphInfrastructureIssue,
  scopeReviewToProduct,
} from './ralph-scope.mjs';

import { run } from './ralph-process-runner.mjs';

import { agentReportedWriteAccessFailure } from './ralph-codex-session.mjs';

import { runReviewWithRetries } from './ralph-agent-session.mjs';

import {
  agentBinary,
  runDevelopmentSession,
  runReviewSession,
  verifyAgentAuthentication,
} from './ralph-agent-backends.mjs';

import {
  configForPhase,
  configPath,
  controlPlaneSnapshot,
  loadConfig,
  loadRalphRules,
  parseJson,
  verifyAgentSkills,
} from './ralph-config.mjs';

import {
  activeStateStore,
  createStateStore,
  runtimeStatePath,
  setActiveStateStore,
} from './ralph-state-store.mjs';

import { clearedFailure, recordedFailure, recoveryPrompt } from './ralph-failure-summary.mjs';

import {
  beginIssueMetrics,
  finishIssueMetrics,
  formatIssueMetrics,
  incompleteIssueOutcome,
  startStage,
} from './ralph-run-metrics.mjs';

import {
  assertTrustedControlFilesUnchanged,
  hostWorkingTreeHash,
  runConfiguredValidation,
  runPreflight,
} from './ralph-validation-runner.mjs';

import {
  alreadyFixedCommitFromAgent,
  commitMessageFromAgent,
  commitStagedChanges,
  commitTrailerForIssue,
  filesChangedBetween,
  isAncestorCommit,
  issueChangeInventory,
  linkedCommitForIssue,
  pushBranchAndVerify,
  reconcileStateAfterCrash,
  syncPhaseBranchWithBase,
  verifiedIssueCommit,
  verifyBaseHistory,
  verifyPushedHead,
  verifyRepository,
  workingTreeEntries,
  workingTreePaths,
} from './ralph-git.mjs';

import {
  closeMilestone,
  ensurePullRequestForBranch,
  issueState,
  openIssues,
  patchIssue,
  postIssueCommentOnce,
  pullRequestDetails,
  refreshIssue,
  reopenIssueWithComment,
  repositoryName,
  verifyGitHubAuthentication,
  verifyMilestone,
  verifyPullRequestTarget,
  verifyRepositoryWriteAccess,
} from './ralph-github-client.mjs';

import {
  approveConfiguredIssue,
  assertReviewPayloadShape,
  assertTrustedIssue,
  clearIssueCompletionState,
  formatFindingList,
  formatReviewComment,
  issueBodyWithoutRalphMetadata,
  normalizeReviewResult,
  reviewContextFromIssueBody,
  updateIssueReviewContext,
} from './ralph-issue-contract.mjs';

import { buildIndependentReviewPrompt, renderPrompt } from './ralph-prompts.mjs';

import { KIT_VERSION } from './ralph-version.mjs';

import {
  createOrReopenReviewIssues,
  recordDeferredFindingsSafely,
  runMilestoneReview,
} from './ralph-milestone-review.mjs';

// -----------------------------------------------------------------------------
// Пути проекта и режим запуска
// -----------------------------------------------------------------------------

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mode = process.argv[2] ?? '--check';
const supportedModes = new Set(['--check', '--run']);
const runtimeDirectory = path.join(projectRoot, '.git', 'ralph-loop');
const runtimeLockPath = path.join(runtimeDirectory, 'run.lock');
const runtimeLogPath = path.join(runtimeDirectory, 'run.log');

// -----------------------------------------------------------------------------
// Проверка инструментов, Git-репозитория и рабочей ветки
// -----------------------------------------------------------------------------

function workingTreeStatus() {
  return run('git', ['status', '--porcelain']).stdout;
}

function assertCleanTree(message) {
  if (workingTreeStatus() !== '') fail(message);
}

// Проверки не имеют права трогать рабочее дерево: сгенерированный ими файл
// означает, что коммит уже не соответствует проверенному состоянию.
function assertValidationLeftTree(expected, message) {
  if (workingTreeStatus() !== expected) fail(message);
}

// Таксономия исходов переехала к контракту журнала — ralph-run-metrics.mjs.
// Ре-экспорт остаётся: имя опубликовано из этого модуля с самого начала.
export { incompleteIssueOutcome };

/**
 * Фазы, с которых issue продолжается без новой сессии агента: работа уже
 * закоммичена, осталось её протолкнуть и отревьюить.
 *
 * `review-failed` сюда не входит и входить не должен. На этой фазе commit тоже
 * существует, но ревью его уже отклонило: продолжение без сессии агента
 * означало бы бесконечный повтор того же ревью над тем же деревом.
 */
export const committedRecoveryPhases = ['committed', 'pushed', 'reviewing', 'closing'];

/**
 * Фаза между вердиктом PASS и закрытием issue.
 *
 * Пишется только после успешного ревью, поэтому отличает «этот commit проверен
 * и признан годным» от `review-failed`, где `reviewedCommit` тот же, а вердикт
 * противоположный.
 */
const reviewPassedPhase = 'closing';

function reportIssueMetrics(outcome) {
  const record = finishIssueMetrics(outcome);
  if (record) console.log(formatIssueMetrics(record));
}

// Валидация вызывается из трёх мест lifecycle, и замер, поставленный только в
// одном, занизил бы стоимость issue молча. Обёртка одна на все три.
function measuredValidation(runValidation) {
  const endStage = startStage('validation');
  try {
    const outcome = runValidation();
    endStage({ attested: outcome?.attested === true });
    return outcome;
  } catch (error) {
    endStage({ failed: true });
    throw error;
  }
}

/**
 * Полная проверка ветки сразу после того, как в неё влита база.
 *
 * Слияние без конфликта не значит рабочее дерево: база могла изменить контракт,
 * который работа фазы использует, и Git об этом ничего не знает. Без этой
 * проверки поломка всплыла бы на первой же issue, и чинил бы её агент, который
 * её не вносил: он получил бы чужую ошибку под видом своей.
 *
 * Набор полный, а не сокращённый по области: изменения базы могут быть любыми.
 */
function verifyMergedBase(config) {
  console.log('\n=== Проверка ветки после слияния базы ===\n');
  const endStage = startStage('validation');
  try {
    runConfiguredValidation(config);
    endStage();
  } catch (error) {
    endStage({ failed: true });
    fail(
      `Ветка ${config.branch} не проходит проверки после слияния базы ${config.baseBranch}: ` +
        `${error.message}. Слияние уже в истории ветки; разберитесь с ним вручную, ` +
        'прежде чем отдавать работу агенту.',
    );
  }
  assertValidationLeftTree(
    '',
    `Проверки после слияния базы изменили рабочее дерево ветки ${config.branch}.`,
  );
}

function verifyTools(config) {
  run('git', ['--version']);
  run('gh', ['--version']);
  run(agentBinary(config), ['--version']);
  // Docker нужен только контейнерному режиму и только при непустом наборе.
  if (
    config.validationMode === 'container' &&
    config.preflightScripts.length + config.validationScripts.length > 0
  ) {
    run('docker', ['version']);
  }
  verifyGitHubAuthentication(config);
}

// -----------------------------------------------------------------------------
// Формирование prompt для реализации одной issue
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Локальное ревью commit одной issue отдельной сессией агента
// -----------------------------------------------------------------------------

/**
 * Коммит, уже проверенный прошлым ревью целиком, и то, что добавилось после.
 *
 * Возвращает null на первом ревью issue и на повторном ревью того же самого
 * коммита: в обоих случаях сокращать нечего.
 */
function previouslyAuditedCommit(changes, commit) {
  const reviewedCommit = activeStateStore()?.issue?.reviewedCommit;
  if (!reviewedCommit || reviewedCommit === commit) return null;
  if (!isAncestorCommit(reviewedCommit, commit)) return null;

  return {
    commit: reviewedCommit,
    // Проверенными считаются только те коммиты issue, что были достижимы из
    // уже отревьюенного: остальные добавились после и требуют полного разбора.
    newCommits: (changes?.commits ?? []).filter(
      (candidate) => !isAncestorCommit(candidate, reviewedCommit),
    ),
  };
}

async function runIndependentReview(config, repository, issue, commit) {
  if (!config.review.enabled) {
    return { verdict: 'pass', summary: 'Independent review is disabled.', findings: [] };
  }

  const reviewedHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const reviewedBranch = run('git', ['branch', '--show-current']).stdout;
  if (existsSync(config.review.outputPath)) {
    unlinkSync(config.review.outputPath);
  }

  // Замечания прошлого ревью вынимаются из тела issue в отдельную секцию
  // prompt: внутри тела они приезжают без подписи, вперемешку с критериями
  // готовности, и требованию «проверь их закрытие» опереться не на что.
  const inventory = issueChangeInventory(issue, commit, {
    excludedPaths: config.reviewDiffExcludedPaths,
  });
  const reviewPrompt = buildIndependentReviewPrompt(
    config,
    { ...issue, body: issueBodyWithoutRalphMetadata(issue) },
    commit,
    {
      changes: inventory,
      previousFindings: reviewContextFromIssueBody(issue),
      previousReview: previouslyAuditedCommit(inventory, commit),
    },
  );

  console.log(`\n=== Independent review for issue #${issue.number} ===\n`);

  await runReviewSession(config, config.review, {
    input: reviewPrompt,
    maxTurns: config.maxTurns,
    timeoutMs: config.runtime.agentTimeoutMs,
    label: `Review issue #${issue.number}`,
  });

  if (!existsSync(config.review.outputPath)) {
    fail(`Review issue #${issue.number} не создал файл результата.`);
  }

  let review = parseJson(readFileSync(config.review.outputPath, 'utf8'), config.review.outputPath);

  assertReviewPayloadShape(review, `Review issue #${issue.number}`);
  const reviewLabel = `Review issue #${issue.number}`;
  review = applySeverityFloor(
    scopeReviewToProduct(normalizeReviewResult(review), reviewLabel),
    config.reviewSeverityFloor,
    reviewLabel,
  );

  const changes = run('git', ['status', '--porcelain']).stdout;
  const headAfterReview = run('git', ['rev-parse', 'HEAD']).stdout;
  const branchAfterReview = run('git', ['branch', '--show-current']).stdout;
  if (changes !== '' || headAfterReview !== reviewedHead || branchAfterReview !== reviewedBranch) {
    fail(`Review issue #${issue.number} изменил рабочее дерево.`);
  }

  if (review.verdict !== 'pass') {
    console.log(
      `Review issue #${issue.number}: FAIL — найдено замечаний: ${review.findings.length}.`,
    );
    return review;
  }

  console.log(`Review issue #${issue.number}: PASS — ${review.summary}`);
  return review;
}

// -----------------------------------------------------------------------------
// Подготовка commit и закрытие issue силами оркестратора
// -----------------------------------------------------------------------------

function closeIssue(config, repository, issue, commit, review = null) {
  const completion = config.review.enabled
    ? 'Ralph Loop validations and independent review passed.'
    : 'Ralph Loop validations passed; independent review is disabled in config.';
  const commentMarker = `<!-- ralph-issue-complete commit:${commit} -->`;
  // На PASS с замечаниями ниже порога комментарий закрытия — единственный
  // гарантированный след этих замечаний в GitHub: запись отложенных issues
  // может отказать и осознанно не роняет прогон.
  const belowFloor = review?.belowFloorFindings?.length
    ? `\n\n### Below the severity floor (recorded as deferred issues)\n\n${formatFindingList(review.belowFloorFindings)}`
    : '';
  // Комментарий — след для человека, а не часть контракта: его marker никто не
  // читает, а связь issue с работой держат trailer коммита, тело issue и PR.
  // Закрытие ниже обязательно, публикация — нет.
  try {
    postIssueCommentOnce(
      repository,
      issue.number,
      `Implemented in commit ${commit}. ${completion}${belowFloor}`,
      commentMarker,
    );
  } catch (error) {
    console.error(
      `Issue #${issue.number}: не удалось опубликовать комментарий о завершении: ${error.message}. ` +
        'Issue всё равно закрывается: работа сделана и проверена.',
    );
  }

  const closedIssue = patchIssue(repository, issue.number, {
    state: 'closed',
    state_reason: 'completed',
  });
  if (closedIssue.state?.toUpperCase() !== 'CLOSED') {
    fail(`Issue #${issue.number} не закрылась после успешной реализации.`);
  }
}

/**
 * Прошло ли ревью этого самого commit на прошлом прогоне.
 *
 * Читается до первого updateIssue: тот сразу перезаписывает фазу, и после него
 * отличить прерванное закрытие от обычного продолжения уже нечем.
 */
/**
 * С какого коммита следующая сессия продолжит issue.
 *
 * Это HEAD, если работа issue уже в его истории, и сам commit, если история
 * разошлась: перенос базы вперёд по чужой ветке потерял бы работу вместо того,
 * чтобы её продолжить.
 */
export function baseForNextSession(commit, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const head = execute('git', ['rev-parse', 'HEAD']).stdout;
  const contains = dependencies.isAncestorCommit ?? isAncestorCommit;

  return head && contains(commit, head, execute) ? head : commit;
}

export function reviewAlreadyPassed(issue, commit) {
  const storedIssue = activeStateStore()?.issue;

  return (
    storedIssue?.number === issue.number &&
    storedIssue?.phase === reviewPassedPhase &&
    storedIssue?.reviewedCommit === commit
  );
}

async function reviewAndCloseCommittedIssue(config, repository, issue, commit) {
  const passedOnPreviousRun = reviewAlreadyPassed(issue, commit);
  const pushedHead = pushBranchAndVerify(config);
  activeStateStore()?.updateIssue({
    phase: 'pushed',
    commit,
    pushedHead,
    ...clearedFailure,
  });

  if (!config.review.enabled) {
    verifyPushedHead(config, pushedHead);
    closeIssue(config, repository, issue, commit);
    activeStateStore()?.clearIssue();
    return {
      completed: true,
      commit,
      review: { verdict: 'pass', summary: 'Independent review is disabled.', findings: [] },
    };
  }

  if (passedOnPreviousRun) {
    // Прошлый прогон дошёл до PASS и упал на закрытии issue. Вердикт относится
    // к дереву, а не к попытке записи в GitHub, а дерево с тех пор не менялось:
    // повторное ревью того же commit стоило бы целой сессии агента и ответило бы
    // то же самое.
    console.log(
      `Issue #${issue.number}: ревью commit ${commit} прошло на прошлом прогоне; ` +
        'повтор пропущен, осталось закрыть issue.',
    );
    verifyPushedHead(config, pushedHead);
    closeIssue(config, repository, issue, commit);
    activeStateStore()?.clearIssue();
    return {
      completed: true,
      commit,
      review: {
        verdict: 'pass',
        summary: 'Review passed on a previous run; the reviewed commit is unchanged.',
        findings: [],
      },
    };
  }

  activeStateStore()?.updateIssue({ phase: 'reviewing' });
  let review;
  // Замер охватывает повторы: попытка ревью, упавшая технически, стоит полной
  // сессии, а таких попыток допускается reviewRetryAttempts.
  const endReview = startStage('review');
  try {
    review = await runReviewWithRetries(
      config,
      () => runIndependentReview(config, repository, issue, commit),
      `Review issue #${issue.number}`,
    );
    endReview();
    // Замечания ниже порога не блокируют работу, но и не теряются: каждое
    // становится отложенной GitHub issue для ручного разбора.
    recordDeferredFindingsSafely(
      config,
      repository,
      review,
      `independent review of issue #${issue.number} at commit ${commit}`,
    );
  } catch (error) {
    endReview({ failed: true });
    activeStateStore()?.updateIssue({
      phase: 'pushed',
      ...recordedFailure(error),
    });
    try {
      reopenIssueWithComment(
        repository,
        issue,
        `## Ralph Loop: independent review did not complete\n\n${error.message}\n\nThe pushed commit is preserved. AFK will retry the review on the next run.`,
      );
    } catch (commentError) {
      console.error(
        `Не удалось опубликовать техническую ошибку review issue #${issue.number}: ${commentError.message}`,
      );
    }
    throw error;
  }
  if (review.verdict !== 'pass') {
    const reviewFixAttempts = (activeStateStore()?.issue?.reviewFixAttempts ?? 0) + 1;
    // Замечания попадают в тело issue первыми: именно их читает следующая
    // сессия агента, и без них она не знает, что чинить.
    updateIssueReviewContext(repository, issue, review);
    // Состояние сохраняется, а не стирается: реализация уже в HEAD и уже прошла
    // валидацию, и следующая сессия должна чинить замечания поверх неё, а не
    // выяснять заново, что сделано. `startingCommit` обязан переехать вперёд —
    // иначе сверка HEAD отвергнет повторный прогон, а проверка «ровно один
    // commit» отвергнет исправляющий commit.
    //
    // Переезжает он именно на HEAD, а не на commit issue. Между ними могут
    // лежать чужие коммиты — например, правки Ralph, попавшие в ветку тем же
    // прогоном, — и тогда следующая итерация требует HEAD, который остался
    // позади. Примирение в начале фазы такое не ловит: фаза начинается раньше,
    // чем состояние записано.
    //
    // Запись идёт до публикации комментария: обрыв на комментарии оставил бы
    // фазу `reviewing` без `reviewedCommit`, и вердикт FAIL пришлось бы
    // получать заново.
    activeStateStore()?.updateIssue({
      phase: 'review-failed',
      startingCommit: baseForNextSession(commit),
      commit,
      // Отметка «этот commit проверен целиком»: следующему ревью не нужно
      // заново проходить то, что уже признано чистым.
      reviewedCommit: commit,
      pushedHead: null,
      expectedTree: null,
      commitMessage: null,
      validationFixAttempts: 0,
      reviewFixAttempts,
      ...clearedFailure,
    });
    reopenIssueWithComment(repository, issue, formatReviewComment(review));

    // Бюджет итераций общий на всю фазу, и без этого предела одна issue съедает
    // его целиком: ревью отклоняет работу заход за заходом, а число замечаний
    // скачет и не доходит до нуля. Дальше идут другие issues, а эта остаётся
    // открытой с замечаниями в теле.
    if (reviewFixAttempts >= config.maxReviewFixAttempts) {
      console.error(
        `Issue #${issue.number}: ревью отклонило работу ${reviewFixAttempts} раз подряд. ` +
          'Issue отложена до конца прогона: работа в ветке, замечания в её теле. ' +
          'Следующие заходы повторяли бы тот же круг.',
      );
      activeStateStore()?.clearIssue();
      return { completed: false, parked: true, commit, review };
    }
    return { completed: false, commit, review };
  }

  // Вердикт записывается до обращения к GitHub. Публикация комментария и
  // закрытие issue — сетевые операции, и падение на них иначе стоит повторного
  // ревью того же самого дерева на следующем прогоне.
  activeStateStore()?.updateIssue({ phase: reviewPassedPhase, reviewedCommit: commit });
  verifyPushedHead(config, pushedHead);
  closeIssue(config, repository, issue, commit, review);
  activeStateStore()?.clearIssue();
  return { completed: true, commit, review };
}

async function commitAndCompleteIssue(config, repository, issue, startingCommit, lastAgentMessage) {
  assertTrustedControlFilesUnchanged(config);
  const currentBranch = run('git', ['branch', '--show-current']).stdout;
  const currentCommit = run('git', ['rev-parse', 'HEAD']).stdout;
  const changes = run('git', ['status', '--porcelain']).stdout;
  const violations = [];

  if (currentBranch !== config.branch) {
    violations.push(`Агент переключился на ветку ${currentBranch}`);
  }
  if (currentCommit !== startingCommit) {
    violations.push('Агент самостоятельно создал commit');
  }
  if (issueState(repository, issue.number) !== 'OPEN') {
    violations.push('Агент самостоятельно изменил состояние issue');
  }
  if (violations.length > 0) {
    fail(`Issue #${issue.number}: ${violations.join('; ')}. Цикл остановлен.`);
  }

  // Что в дереве принадлежит агенту, а что лежало там до начала issue.
  //
  // Стадирование всего подряд уводит в коммит задачи чужие правки: оставленный
  // оператором конфиг и черновик на сотни килобайт, который следующий коммит
  // агента удаляет вместе с рабочей копией. Ревьюер, увидев в диффе задачи
  // чужой файл, отклоняет работу заход за заходом.
  const foreignPaths = new Set(activeStateStore()?.issue?.foreignPaths ?? []);
  const agentEntries = workingTreeEntries(changes).filter((entry) => !foreignPaths.has(entry.path));
  const agentPaths = agentEntries.map((entry) => entry.path);
  const untouchedForeign = workingTreePaths(changes).filter((file) => foreignPaths.has(file));
  if (untouchedForeign.length > 0) {
    console.log(
      `Issue #${issue.number}: вне коммита оставлено ${untouchedForeign.length} файлов, ` +
        `изменённых до начала задачи: ${untouchedForeign.slice(0, 5).join(', ')}` +
        `${untouchedForeign.length > 5 ? ' и другие' : ''}.`,
    );
  }

  if (agentPaths.length === 0) {
    const alreadyFixedCommit = alreadyFixedCommitFromAgent(lastAgentMessage);
    if (!alreadyFixedCommit) {
      fail(`Issue #${issue.number}: агент не оставил изменений и не указал ALREADY_FIXED commit.`);
    }
    const commit = verifiedIssueCommit(alreadyFixedCommit, issue);
    activeStateStore()?.updateIssue({ phase: 'validating' });
    try {
      measuredValidation(() => runConfiguredValidation(config));
    } catch (error) {
      if (error.code === 'RALPH_VALIDATION_MUTATED') {
        activeStateStore()?.updateIssue({
          phase: 'validation-mutated',
          validationExpectedTreeHash: error.expectedTreeHash,
          ...recordedFailure(error),
        });
        throw error;
      }
      const attempts = (activeStateStore()?.issue?.validationFixAttempts ?? 0) + 1;
      activeStateStore()?.updateIssue({
        phase: 'working-tree',
        validationFixAttempts: attempts,
        ...recordedFailure(error),
      });
      if (attempts >= config.maxTestFixAttempts) throw error;
      console.error(
        `Issue #${issue.number}: validation не прошла (${attempts}/${config.maxTestFixAttempts}); ` +
          'Ralph передаст ошибку агенту на следующей итерации.',
      );
      return { completed: false, validationFailed: true };
    }
    assertValidationLeftTree(
      changes,
      `Issue #${issue.number}: проверки already-fixed решения изменили рабочее дерево.`,
    );
    return reviewAndCloseCommittedIssue(config, repository, issue, commit);
  }

  activeStateStore()?.updateIssue({ phase: 'validating' });
  try {
    measuredValidation(() => runConfiguredValidation(config));
  } catch (error) {
    if (error.code === 'RALPH_VALIDATION_MUTATED') {
      activeStateStore()?.updateIssue({
        phase: 'validation-mutated',
        validationExpectedTreeHash: error.expectedTreeHash,
        ...recordedFailure(error),
      });
      throw error;
    }
    const attempts = (activeStateStore()?.issue?.validationFixAttempts ?? 0) + 1;
    activeStateStore()?.updateIssue({
      phase: 'working-tree',
      validationFixAttempts: attempts,
      ...recordedFailure(error),
    });
    if (attempts >= config.maxTestFixAttempts) throw error;
    console.error(
      `Issue #${issue.number}: validation не прошла (${attempts}/${config.maxTestFixAttempts}); ` +
        'Ralph продолжит исправление существующего diff.',
    );
    return { completed: false, validationFailed: true };
  }
  assertValidationLeftTree(
    changes,
    `Issue #${issue.number}: проектные проверки изменили рабочее дерево. ` +
      'Проверьте generated-файлы перед повторным запуском.',
  );
  activeStateStore()?.updateIssue({ phase: 'staging' });
  // Именно пути агента, а не `--all`: остальное в дереве принадлежит оператору
  // и обязано остаться незакоммиченным.
  //
  // Стадируется только то, что изменено в рабочем дереве. Путь, уже полностью
  // лежащий в индексе, `git add` не примет: после `git rm` файла нет ни в
  // дереве, ни в индексе, и pathspec не совпадает ни с чем — код 128 и обрыв
  // прогона. В коммит такой путь и так попадёт, он уже застадирован.
  const pathsToStage = agentEntries
    .filter((entry) => entry.worktree !== ' ')
    .map((entry) => entry.path);
  if (pathsToStage.length > 0) {
    run('git', ['add', '--all', '--', ...pathsToStage]);
  }

  const stagedDiff = run('git', ['diff', '--cached', '--quiet'], {
    allowFailure: true,
  });
  if (stagedDiff.status === 0) {
    fail(`Issue #${issue.number}: после staging нет изменений для commit.`);
  }
  if (stagedDiff.status !== 1) {
    fail(`Issue #${issue.number}: не удалось проверить staged diff.`);
  }

  const commitMessage = commitMessageFromAgent(lastAgentMessage, issue);
  // expectedTree переживает падение процесса: только он позволяет
  // восстановлению отличить «проверенный индекс цел» от «индекс кто-то трогал».
  // Сверять его с tree только что созданного commit не нужно — commitStagedChanges
  // коммитит индекс с пустым core.hooksPath, между двумя вызовами ничего не
  // выполняется.
  const expectedTree = run('git', ['write-tree']).stdout;
  activeStateStore()?.updateIssue({
    phase: 'staging',
    expectedTree,
    commitMessage,
  });
  commitStagedChanges(commitMessage, issue, config.runtime.validationTimeoutMs);

  const commitCount = Number(run('git', ['rev-list', '--count', `${startingCommit}..HEAD`]).stdout);
  // Чистое дерево здесь не требуется: файлы оператора намеренно остались вне
  // коммита. Требуется другое — чтобы после коммита не осталось ничего, что
  // агент изменил сам.
  const leftBehind = workingTreePaths(run('git', ['status', '--porcelain']).stdout).filter(
    (file) => !foreignPaths.has(file),
  );
  if (commitCount !== 1 || leftBehind.length > 0) {
    fail(
      `Issue #${issue.number}: оркестратор ожидал один commit и никаких своих изменений вне него, ` +
        `получено commits=${commitCount}, вне коммита: ${leftBehind.join(', ') || 'нет'}.`,
    );
  }

  const commit = run('git', ['rev-parse', 'HEAD']).stdout;
  activeStateStore()?.updateIssue({
    phase: 'committed',
    commit,
    pushedHead: null,
    ...clearedFailure,
  });
  return reviewAndCloseCommittedIssue(config, repository, issue, commit);
}

// -----------------------------------------------------------------------------
// Реализация одной issue агентом и проверка правил завершения
// -----------------------------------------------------------------------------

// Фазы, на которых работа issue лежит незакоммиченной в рабочем дереве.
const uncommittedWorkPhases = new Set([
  'agent-running',
  'working-tree',
  'validating',
  'validation-mutated',
]);

/**
 * Можно ли продолжить issue, если ветка ушла вперёд с сохранённого commit.
 *
 * Требование точного совпадения HEAD теряет задачу каждый раз, когда между
 * прогонами в ветку попадает посторонний commit — а это ровно то, что делает
 * оператор, правя Ralph между запусками.
 *
 * Условие зависит от того, где лежит работа. После отказа ревью она в HEAD, а
 * дерево чистое: двигать базу безопасно всегда. На фазах с незакоммиченным
 * diff — только если пришедшие коммиты не трогают ни одного файла, который
 * сейчас правит агент; иначе его правки лягут поверх изменившегося файла, и
 * это уже не продолжение, а конфликт.
 *
 * `staging` не входит: там в состоянии лежит `expectedTree`, собранный против
 * прежнего HEAD.
 */
export function advanceStartingCommitIfBranchMovedOn(stateStore = activeStateStore()) {
  const storedIssue = stateStore?.issue;
  const currentHead = run('git', ['rev-parse', 'HEAD']).stdout;
  if (!branchMovedWithoutDisturbingIssue(storedIssue, currentHead)) return false;

  console.log(
    `Issue #${storedIssue.number}: ветка ушла вперёд с ` +
      `${storedIssue.startingCommit.slice(0, 8)} до ${currentHead.slice(0, 8)}; ` +
      'продолжаем поверх нового HEAD.',
  );
  stateStore.updateIssue({ startingCommit: currentHead });

  return true;
}

export function recoverHostValidationMutation(
  storedIssue,
  stateStore = activeStateStore(),
  dependencies = {},
) {
  if (storedIssue?.phase !== 'validation-mutated') return false;
  const hashTree = dependencies.hostWorkingTreeHash ?? hostWorkingTreeHash;
  const currentTreeHash = hashTree();
  if (
    !storedIssue.validationExpectedTreeHash ||
    currentTreeHash !== storedIssue.validationExpectedTreeHash
  ) {
    fail(
      `Issue #${storedIssue.number}: host-проверка изменила рабочее дерево. ` +
        'Удалите созданные проверкой изменения; Ralph продолжит только после восстановления ' +
        'точного diff, который был до проверки.',
    );
  }
  stateStore?.updateIssue({
    phase: 'working-tree',
    validationExpectedTreeHash: null,
    ...clearedFailure,
  });
  console.log(
    `Issue #${storedIssue.number}: изменения host-проверки удалены; продолжаем с исходным diff.`,
  );
  return true;
}

function branchMovedWithoutDisturbingIssue(storedIssue, currentHead) {
  const storedStart = storedIssue?.startingCommit;
  if (!storedStart || storedStart === currentHead) return false;
  if (!isAncestorCommit(storedStart, currentHead)) return false;

  const status = workingTreeStatus();
  if (storedIssue.phase === 'review-failed') return status === '';
  // `staging` исключён из uncommittedWorkPhases из-за expectedTree, собранного
  // против прежнего HEAD. Пока его нет, исключать нечего: сбой пришёлся на
  // время до фиксации индекса — например, на `git add`, — и в дереве лежит
  // обычная незакоммиченная работа.
  const phase =
    storedIssue.phase === 'staging' && !storedIssue.expectedTree
      ? 'working-tree'
      : storedIssue.phase;
  if (!uncommittedWorkPhases.has(phase) || status === '') return false;

  const dirtyFiles = new Set(workingTreePaths(status));
  const moved = filesChangedBetween(storedStart, currentHead);

  return moved !== null && moved.every((file) => !dirtyFiles.has(file));
}

export async function runAgentOnIssue(config, repository, issue, rules) {
  issue = assertTrustedIssue(config, issue, repository);
  const storedIssue =
    activeStateStore()?.issue?.number === issue.number ? activeStateStore().issue : null;
  recoverHostValidationMutation(storedIssue);
  if (storedIssue?.commit && committedRecoveryPhases.includes(storedIssue.phase)) {
    assertCleanTree(`Issue #${issue.number}: committed recovery требует чистое рабочее дерево.`);
    const commit = verifiedIssueCommit(storedIssue.commit, issue);
    console.log(
      `Issue #${issue.number}: продолжаем pipeline с сохранённого commit ${commit} ` +
        `(phase=${storedIssue.phase}).`,
    );
    const resumePhase = storedIssue.phase;
    try {
      measuredValidation(() => runConfiguredValidation(config));
    } catch (error) {
      activeStateStore().updateIssue({ phase: resumePhase, ...recordedFailure(error) });
      throw error;
    }
    return reviewAndCloseCommittedIssue(config, repository, issue, commit);
  }

  const currentHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const continuation = Boolean(storedIssue);
  // База уже сдвинута в начале фазы, до проверки рабочего дерева; здесь
  // остаётся простое сравнение.
  const startingCommit = storedIssue?.startingCommit ?? currentHead;
  if (startingCommit !== currentHead) {
    fail(
      `Issue #${issue.number}: recovery ожидал HEAD ${startingCommit}, но найден ${currentHead}.`,
    );
  }
  activeStateStore()?.beginIssue(issue, startingCommit, workingTreePaths(workingTreeStatus()));

  const linkedCommit = issue.linkedCommit ?? linkedCommitForIssue(issue);
  if (!continuation && linkedCommit) {
    console.log(
      `Issue #${issue.number}: найден свежий commit ${linkedCommit} с trailer ` +
        `${commitTrailerForIssue(issue)}; повторная сессия агента не требуется.`,
    );
    return commitAndCompleteIssue(
      config,
      repository,
      issue,
      startingCommit,
      `ALREADY_FIXED: ${linkedCommit}`,
    );
  }

  let codexResult;
  console.log(`\n=== Issue #${issue.number}: ${issue.title} ===\n`);
  const endImplementation = startStage('implementation');
  try {
    codexResult = await runDevelopmentSession(config, {
      input: renderPrompt(config, issue, rules) + (continuation ? recoveryPrompt(storedIssue) : ''),
      maxTurns: config.maxTurns,
      timeoutMs: config.runtime.agentTimeoutMs,
      label: `${config.agentCli} issue #${issue.number}`,
    });
    endImplementation();
  } catch (error) {
    endImplementation({ failed: true });
    activeStateStore()?.updateIssue({
      phase: 'working-tree',
      ...recordedFailure(error),
    });
    if (error.code === 'RALPH_AGENT_AUTH') {
      throw error;
    }
    if (['RALPH_MAX_TURNS', 'RALPH_AGENT_TIMEOUT'].includes(error.code)) {
      reopenIssueWithComment(
        repository,
        issue,
        `## Ralph Loop: agent circuit breaker\n\nThe ${config.agentCli} session was stopped by **${error.code}** after ${error.turns ?? 'an unknown number of'} observable steps. Existing work is preserved and AFK will continue the same issue while the shared iteration budget allows.`,
      );
    }
    console.error(
      `Issue #${issue.number}: сессия агента не завершилась; существующий diff сохранён: ${error.message}`,
    );
    return { completed: false, agentFailed: true };
  }

  if (agentReportedWriteAccessFailure(codexResult.lastAgentMessage)) {
    const error = new Error(
      `Issue #${issue.number}: дочерний агент сообщил об отсутствии write-доступа, ` +
        'хотя development-сессия запущена с полным доступом к файловой системе.',
    );
    error.code = 'RALPH_AGENT_WRITE_ACCESS';
    activeStateStore()?.updateIssue({ phase: 'working-tree', ...recordedFailure(error) });
    throw error;
  }

  return commitAndCompleteIssue(
    config,
    repository,
    issue,
    startingCommit,
    codexResult.lastAgentMessage,
  );
}

// -----------------------------------------------------------------------------
// Финальные проверки, push ветки и создание draft Pull Request
// -----------------------------------------------------------------------------

// Механика pull request и milestone переехала к остальным вызовам gh —
// в ralph-github-client.mjs. Здесь осталась оркестрация вокруг них.

// Сравнение с OID до ревью формально перекрывается verifyPullRequestTarget,
// который и так требует совпадения с локальным HEAD. Оно остаётся ради
// сообщения: «PR изменился во время milestone review» называет реальное
// событие — кто-то запушил в ветку, пока шло ревью, — а не «head не совпал».
function verifyReviewedPullRequestHead(config, repository, pullRequest) {
  const refreshed = verifyPullRequestTarget(
    config,
    pullRequestDetails(repository, pullRequest.number),
  );
  if (refreshed.headRefOid !== pullRequest.headRefOid) {
    fail(
      `PR #${pullRequest.number} изменился во время milestone review: ` +
        `${pullRequest.headRefOid} -> ${refreshed.headRefOid}. Нужен review нового HEAD.`,
    );
  }
  verifyPushedHead(config, pullRequest.headRefOid);
  return refreshed;
}

function createPullRequest(config, repository) {
  assertCleanTree('Нельзя создать PR: в рабочем дереве есть незакоммиченные изменения.');

  runConfiguredValidation(config);
  assertValidationLeftTree(
    '',
    'Нельзя обновить PR: проектные проверки изменили чистое рабочее дерево.',
  );
  verifyBaseHistory(config);
  const commitCount = Number(
    run('git', ['rev-list', '--count', `origin/${config.baseBranch}..HEAD`]).stdout,
  );
  if (!Number.isInteger(commitCount) || commitCount < 1) {
    fail(`В ветке ${config.branch} нет коммитов поверх origin/${config.baseBranch}.`);
  }

  pushBranchAndVerify(config);

  return ensurePullRequestForBranch(config, repository);
}


// -----------------------------------------------------------------------------
// Итоговое ревью всего milestone и публикация результата в PR
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Диагностика конфигурации для безопасного режима --check
// -----------------------------------------------------------------------------

// Бюджет итераций живёт в state и переживает перезапуск, поэтому конфигурация
// может быть корректной, а `--run` при этом останавливаться сразу.
export function iterationBudget(config, stateStore) {
  const limit = config.maxIterations;
  const used = stateStore?.iterationsUsed ?? 0;
  return { used, limit, remaining: Math.max(0, limit - used) };
}

export function printCheck(
  config,
  repository,
  milestone,
  repositoryState,
  issues,
  budget = iterationBudget(config, null),
) {
  console.log('Ralph Loop настроен корректно.');
  console.log(`Версия набора: ${KIT_VERSION}`);
  console.log(`Фаза: ${(config.phaseIndex ?? 0) + 1}/${config.phaseCount ?? 1}`);
  console.log(`Репозиторий: ${repository}`);
  console.log(`Milestone: ${milestone.title} (${issues.length} открытых issues)`);
  console.log(`Ветка: ${repositoryState.currentBranch}`);
  console.log(`Рабочее дерево: ${repositoryState.clean ? 'чистое' : 'есть изменения'}`);
  console.log(
    `Итерации: использовано ${budget.used}/${budget.limit}, осталось ${budget.remaining}`,
  );
  console.log(`Лимит шагов на сессию: ${config.maxTurns}`);
  console.log(`Лимит исправлений тестов: ${config.maxTestFixAttempts}`);
  console.log(`Модель разработки: ${config.developmentModel} (effort=${config.developmentEffort})`);
  console.log(`Правила сессии: ${config.rulesFile}`);
  console.log(
    `Review issue: ${
      config.review.enabled ? `${config.review.model} (effort=${config.review.effort})` : 'выключен'
    }`,
  );
  console.log(
    `Review milestone: ${
      config.milestoneReview.enabled
        ? `${config.milestoneReview.model} (effort=${config.milestoneReview.effort}, ` +
          `maxTurns=${config.milestoneReview.maxTurns})`
        : 'выключен'
    }`,
  );
  if (issues[0]) {
    console.log(`Следующая issue: #${issues[0].number} ${issues[0].title}`);
  } else {
    console.log('Открытых issues нет; режим --run попытается создать PR.');
  }
  // Журнал внутри scripts/ralph — ловушка обновления: каталог перезаписывают
  // целиком, и журнал проекта погибает вместе с ним. Проверка по строке
  // конфига, а не по диску: предупреждение нужно до того, как файл потеряли.
  const approvedLedger = String(config.approvedIssueSnapshotsFile ?? '').replaceAll('\\', '/');
  if (approvedLedger.startsWith('scripts/ralph/')) {
    console.log(
      `ВНИМАНИЕ: журнал одобренных issues лежит в ${approvedLedger}, а этот каталог ` +
        'обновление набора перезаписывает целиком. Перенесите файл, например в ' +
        '.agents/approved-issues.json, поправьте "approvedIssueSnapshotsFile" и ' +
        'сумму в конфиге; порядок описан в INSTALL.md набора.',
    );
  }
  if (budget.remaining === 0) {
    console.log(
      `ВНИМАНИЕ: сохранённый бюджет итераций исчерпан (${budget.used}/${budget.limit}). ` +
        'Режим --run остановится на первой issue, которой нужна новая итерация.',
    );
    console.log(
      `Продолжение без ручного редактирования state: увеличьте "maxIterations" в ${path.relative(
        projectRoot,
        configPath,
      )} и закоммитьте конфигурацию; осталось будет пересчитано автоматически.`,
    );
  }
  return budget;
}

// -----------------------------------------------------------------------------
// Главный цикл Ralph Loop: --check и --run
// -----------------------------------------------------------------------------

// Запись метрик открывается из трёх мест цикла — запуск задачи, остановка по
// лимиту итераций, ревью milestone. Поля собраны здесь, чтобы они не разъехались:
// запись без `iteration` или без `agentCli` выглядит как запись другого рода.
function issueMetricsContext(config, issue, iteration) {
  return {
    issue: issue?.number ?? null,
    issueTitle: issue?.title ?? null,
    milestone: config.milestone,
    branch: config.branch,
    iteration,
    agentCli: config.agentCli,
  };
}

export async function runContinuousLoop(context, actions) {
  const { config, repository, milestone, rules } = context;
  const stateStore = context.stateStore ?? activeStateStore();
  let iteration = stateStore?.iterationsUsed ?? 0;
  const pendingIssues = new Map();
  const completedIssueNumbers = new Set();
  // Issues, которые ревью отклоняло подряд до предела. Из очереди этого прогона
  // они убраны, но остаются открытыми: их разбирает оператор или следующий
  // прогон, а бюджет достаётся остальным.
  const parkedIssueNumbers = new Set();

  while (true) {
    const listedIssues = actions
      .openIssues(repository, milestone)
      .filter((issue) => !isRalphInfrastructureIssue(issue));
    const issuesByNumber = new Map();
    // Сначала добавляем ответ GitHub, затем локальную очередь: локальная копия
    // содержит самый свежий body после review и должна победить устаревший REST-ответ.
    for (const issue of [...listedIssues, ...pendingIssues.values()]) {
      if (parkedIssueNumbers.has(issue.number)) continue;
      if (completedIssueNumbers.has(issue.number)) {
        // REST-список может кратко вернуть уже закрытую issue. Прямой GET
        // отличает этот stale-ответ от настоящего повторного открытия.
        if (actions.issueState(repository, issue.number) !== 'OPEN') {
          continue;
        }
        completedIssueNumbers.delete(issue.number);
      }
      issuesByNumber.set(issue.number, issue);
    }
    const recoveryIssue = stateStore?.issue;
    if (recoveryIssue && isRalphInfrastructureIssue(recoveryIssue)) {
      if (actions.workingTreeStatus() !== '') {
        fail(
          `Сохранённая служебная issue #${recoveryIssue.number} имеет незавершённый diff. ` +
            'Ralph остановлен: служебные изменения должен разобрать оператор вручную.',
        );
      }
      console.log(
        `Recovery issue #${recoveryIssue.number} относится к Ralph-инфраструктуре; ` +
          'служебное состояние очищено без запуска агента.',
      );
      stateStore.clearIssue();
      continue;
    }
    if (recoveryIssue && !issuesByNumber.has(recoveryIssue.number)) {
      if (actions.issueState(repository, recoveryIssue.number) === 'OPEN') {
        issuesByNumber.set(recoveryIssue.number, {
          number: recoveryIssue.number,
          title: recoveryIssue.title,
          url: recoveryIssue.url,
          body: recoveryIssue.body ?? '',
          authorLogin: recoveryIssue.authorLogin ?? null,
          authorAssociation: recoveryIssue.authorAssociation ?? null,
        });
      } else {
        if (actions.workingTreeStatus() !== '') {
          fail(
            `Сохранённая issue #${recoveryIssue.number} закрыта, но её рабочее дерево ` +
              'содержит изменения. Ralph не будет переносить их в следующую issue.',
          );
        }
        actions.clearIssueCompletionState(repository, recoveryIssue);
        console.log(
          `Сохранённая issue #${recoveryIssue.number} уже закрыта; локальная recovery-фаза очищена.`,
        );
        stateStore.clearIssue();
      }
    }
    const issues = [...issuesByNumber.values()].sort((left, right) => {
      if (recoveryIssue) {
        if (left.number === recoveryIssue.number) return -1;
        if (right.number === recoveryIssue.number) return 1;
      }
      return left.number - right.number;
    });
    if (issues.length === 0) {
      if (config.stopAfterFirstIssue) {
        console.log('Открытых issues нет. Для push и создания PR снимите stopAfterFirstIssue.');
        stateStore?.finish();
        return { mode: 'run', completed: 0 };
      }
      const pullRequest = actions.createPullRequest(config, repository);
      // Телеметрия роли `milestone-review` снимается только внутри активной
      // записи, а между задачами её нет: без отдельной записи самая дорогая
      // сессия прогона не попадает в журнал вовсе. Запись без номера issue —
      // приписать её последней задаче milestone значило бы завысить именно ту
      // задачу, которой не повезло закрыться последней.
      actions.beginIssueMetrics?.(issueMetricsContext(config, null, iteration));
      let review;
      try {
        review = await actions.runMilestoneReview(config, repository, milestone, pullRequest);
      } catch (error) {
        actions.reportIssueMetrics?.({
          outcome: error.code ?? 'aborted',
          reason: error.message?.slice(0, 200) ?? null,
        });
        throw error;
      }
      actions.reportIssueMetrics?.({
        outcome: 'milestone-review',
        reason: `вердикт ${review.verdict}, замечаний ${review.findings.length}`,
      });
      if (review.verdict === 'pass' && review.findings.length === 0) {
        const appearedIssues = actions
          .openIssues(repository, milestone)
          // Отложенная issue открыта и здесь бы вернулась в очередь, а фильтр
          // выше снова бы её убрал — цикл крутился бы на месте.
          .filter((issue) => !parkedIssueNumbers.has(issue.number))
          .filter((issue) => actions.issueState(repository, issue.number) === 'OPEN');
        if (appearedIssues.length > 0) {
          for (const issue of appearedIssues) pendingIssues.set(issue.number, issue);
          console.log(
            `Во время milestone review появились issues: ${appearedIssues
              .map((issue) => `#${issue.number}`)
              .join(', ')}. Ralph продолжает цикл.`,
          );
          continue;
        }
        actions.verifyReviewedPullRequestHead(config, repository, pullRequest);
        // Отложенная issue открыта и невыполнена: закрывать milestone под неё
        // значило бы объявить фазу законченной, когда работа осталась.
        // Очередь её не видит по построению, поэтому проверка нужна отдельно —
        // иначе цикл доходит до `closeMilestone`, тот перечитывает issues без
        // этого фильтра и падает на «появились открытые issues».
        if (parkedIssueNumbers.size > 0) {
          const parked = [...parkedIssueNumbers].map((number) => `#${number}`).join(', ');
          console.log(
            `Milestone не закрыт: ${parked} отложены после ${config.maxReviewFixAttempts} отказов ревью подряд. ` +
              'Работа в ветке, замечания в теле задач; разберите их и запустите цикл снова.',
          );
          stateStore?.finish();
          return {
            mode: 'run',
            verdict: 'parked',
            iterations: iteration,
            pullRequest,
            parkedIssues: [...parkedIssueNumbers],
          };
        }
        actions.closeMilestone(repository, milestone);
        return { verdict: 'pass', iterations: iteration, pullRequest };
      }

      const reviewIssues = actions.createOrReopenReviewIssues(
        config,
        repository,
        milestone,
        pullRequest,
        review,
      );
      if (reviewIssues.length === 0) {
        fail('Milestone review завершился с FAIL, но ни одной issue исправления не создано.');
      }
      for (const issue of reviewIssues) {
        const refreshedReviewIssue = actions.refreshIssue(repository, issue.number, issue);
        approveConfiguredIssue(config, refreshedReviewIssue, repository, stateStore, {
          replace: true,
        });
        completedIssueNumbers.delete(refreshedReviewIssue.number);
        pendingIssues.set(refreshedReviewIssue.number, refreshedReviewIssue);
      }
      console.log(
        `Milestone review создал или переоткрыл ${reviewIssues.length} issues. Ralph продолжает цикл исправлений.`,
      );
      continue;
    }

    let currentIssue = issues[0];
    const refreshedIssue = actions.refreshIssue(repository, currentIssue.number, currentIssue);
    if (refreshedIssue.state !== 'OPEN') {
      if (stateStore?.issue?.number === currentIssue.number) {
        if (actions.workingTreeStatus() !== '') {
          fail(
            `Issue #${currentIssue.number} закрылась во время работы, но локальный diff не пуст. ` +
              'Ralph остановлен, чтобы не смешать изменения со следующей задачей.',
          );
        }
        actions.clearIssueCompletionState(repository, currentIssue);
        stateStore.clearIssue();
      }
      pendingIssues.delete(currentIssue.number);
      completedIssueNumbers.add(currentIssue.number);
      continue;
    }
    approveConfiguredIssue(config, refreshedIssue, repository, stateStore);
    currentIssue = refreshedIssue;
    const storedPhase =
      stateStore?.issue?.number === currentIssue.number ? stateStore.issue.phase : null;
    const linkedCommit = storedPhase ? null : actions.linkedCommitForIssue?.(currentIssue);
    if (linkedCommit) currentIssue.linkedCommit = linkedCommit;
    const needsDevelopmentIteration =
      !committedRecoveryPhases.includes(storedPhase) && !linkedCommit;

    if (needsDevelopmentIteration && iteration >= config.maxIterations) {
      // Запись до остановки: иначе прогон обрывается молча, и в журнале
      // расхода нет строки о том, на какой задаче кончился бюджет.
      actions.beginIssueMetrics?.(issueMetricsContext(config, currentIssue, iteration));
      actions.reportIssueMetrics?.({
        outcome: 'iteration-limit',
        reason: `бюджет ${config.maxIterations} итераций исчерпан до начала задачи`,
      });
      fail(
        `Достигнут лимит ${config.maxIterations} итераций; ` +
          `осталось открытых issues: ${issues.length}. PR цикл здесь не создаёт и не трогает: ` +
          'он открывается только когда открытых issues не остаётся. Состояние сохранено — ' +
          'увеличьте maxIterations, и следующий --run продолжит с него.',
      );
    }

    if (needsDevelopmentIteration) {
      iteration = stateStore?.reserveIteration() ?? iteration + 1;
    }
    console.log(
      `${needsDevelopmentIteration ? 'Итерация' : 'Resume'} ${iteration}/${config.maxIterations}; ` +
        `осталось issues: ${issues.length}.`,
    );
    let result;
    actions.beginIssueMetrics?.(issueMetricsContext(config, currentIssue, iteration));
    try {
      result = await actions.runAgentOnIssue(config, repository, currentIssue, rules);
    } catch (error) {
      actions.reportIssueMetrics?.({
        outcome: error.code ?? 'aborted',
        reason: error.message?.slice(0, 200) ?? null,
      });
      if (
        needsDevelopmentIteration &&
        ['RALPH_AGENT_AUTH', 'RALPH_AGENT_WRITE_ACCESS', 'RALPH_UNTRUSTED_ISSUE'].includes(
          error.code,
        )
      ) {
        // Возврат итерации в состояние — единственный нужный эффект: следом
        // идёт throw, и локальная `iteration` уже никем не читается.
        stateStore?.releaseIteration();
      }
      throw error;
    }
    actions.reportIssueMetrics?.(
      result?.completed === false
        ? incompleteIssueOutcome(result)
        : { outcome: 'completed', reason: 'issue закрыта' },
    );
    if (result?.parked) {
      parkedIssueNumbers.add(currentIssue.number);
      pendingIssues.delete(currentIssue.number);
    } else if (result?.completed === false) {
      pendingIssues.set(currentIssue.number, currentIssue);
    } else {
      pendingIssues.delete(currentIssue.number);
      completedIssueNumbers.add(currentIssue.number);
    }
    if (config.stopAfterFirstIssue) {
      if (result?.completed === false) {
        const { reason, runOutcome } = incompleteIssueOutcome(result);
        console.log(
          `Issue #${currentIssue.number} осталась открытой: ${reason}. ` +
            'Цикл остановлен после одной итерации.',
        );
        return { mode: 'run', completed: 0, ...runOutcome };
      }
      stateStore?.finish();
      console.log(`Issue #${currentIssue.number} завершена. Цикл остановлен после одной итерации.`);
      return { mode: 'run', completed: 1 };
    }
  }
}

export async function executeMode(context, actions) {
  const { mode: selectedMode, config, repository, milestone, repositoryState } = context;

  if (selectedMode === '--check') {
    const issues = actions.openIssues(repository, milestone);
    const budget = iterationBudget(config, context.stateStore);
    actions.printCheck(config, repository, milestone, repositoryState, issues, budget);
    return { mode: 'check', issues: issues.length, iterationBudget: budget };
  }

  actions.runPreflight(config);

  return runContinuousLoop(context, actions);
}

function defaultActions() {
  return {
    closeMilestone,
    clearIssueCompletionState,
    issueState,
    openIssues,
    refreshIssue,
    printCheck,
    runPreflight,
    runAgentOnIssue,
    createPullRequest,
    runMilestoneReview,
    createOrReopenReviewIssues,
    linkedCommitForIssue,
    verifyReviewedPullRequestHead,
    workingTreeStatus,
    beginIssueMetrics,
    reportIssueMetrics,
  };
}

function initialPhaseIndex(config, state = readJsonFile(runtimeStatePath, null)) {
  if (
    state?.version === 2 &&
    state.phasePlanId === config.phasePlanId &&
    state.phaseCount === config.phases.length &&
    Number.isInteger(state.phaseIndex) &&
    state.phaseIndex >= 0 &&
    state.phaseIndex < config.phases.length
  ) {
    return state.phaseIndex;
  }
  return 0;
}

export async function runPhasePlan(config, stateStore, runPhase) {
  const results = [];
  let phaseIndex = stateStore?.phaseIndex ?? 0;
  while (true) {
    const currentConfig = configForPhase(config, phaseIndex);
    console.log(
      `\n=== Фаза ${phaseIndex + 1}/${config.phases.length}: ${currentConfig.milestone} ` +
        `(${currentConfig.branch} -> ${currentConfig.baseBranch}) ===`,
    );
    const result = await runPhase(currentConfig, phaseIndex);
    results.push({ phaseIndex, milestone: currentConfig.milestone, ...result });
    if (result?.verdict !== 'pass') {
      return { verdict: result?.verdict ?? 'stopped', phases: results };
    }

    if (phaseIndex + 1 >= config.phases.length) {
      stateStore?.finish();
      console.log(`Все ${config.phases.length} фаз Ralph Loop завершены.`);
      return { verdict: 'pass', phases: results };
    }

    const nextConfig = configForPhase(config, phaseIndex + 1);
    stateStore?.advancePhase(nextConfig);
    console.log(
      `Фаза ${phaseIndex + 1} завершена. Следующая: ${nextConfig.milestone} (${nextConfig.branch}).`,
    );
    phaseIndex = nextConfig.phaseIndex;
  }
}

async function main() {
  // Проверяем, что передан поддерживаемый режим запуска.
  if (!supportedModes.has(mode)) {
    fail(`Неизвестный режим ${mode}. Используйте --check или --run.`);
  }

  const config = loadConfig();
  // Проверяем, включён ли Ralph Loop.
  if (!config.active) {
    console.log('Ralph Loop выключен: active=false.');
    return;
  }

  const firstPhaseIndex = initialPhaseIndex(config);
  const firstPhaseConfig = configForPhase(config, firstPhaseIndex);
  const restoreConsole = initializePersistentLog(runtimeLogPath, {
    mode,
    branch: firstPhaseConfig.branch,
    milestone: firstPhaseConfig.milestone,
    phase: `${firstPhaseIndex + 1}/${config.phases.length}`,
  });
  let releaseLock;
  try {
    releaseLock = acquireRunLock(runtimeLockPath, {
      mode,
      projectRoot,
      branch: firstPhaseConfig.branch,
    });
    setActiveStateStore(createStateStore(firstPhaseConfig, mode));
    Object.assign(config.approvedIssueSnapshots, activeStateStore().approvedIssueSnapshots);
    const rules = loadRalphRules(config);
    verifyTools(config);
    verifyAgentSkills();
    if (mode !== '--check') {
      verifyAgentAuthentication(config);
    }
    for (const phase of config.phases) {
      run('git', ['check-ref-format', '--branch', phase.branch]);
      run('git', ['check-ref-format', '--branch', phase.baseBranch]);
    }
    const repository = repositoryName();
    verifyRepositoryWriteAccess(repository);
    const milestones = config.phases.map((phase) => verifyMilestone(repository, phase.milestone));
    const actions = defaultActions();
    const runPhase = async (phaseConfig) => {
      // Примирение с реальным HEAD идёт до проверки дерева: `verifyRepository`
      // разрешает грязное дерево только через `allowsDirtyRecovery`, а тот
      // требует точного совпадения HEAD с сохранённым startingCommit. Пока база
      // не сдвинута, продолжение отвергается на слой раньше, чем до него
      // доходит очередь.
      if (mode !== '--check') advanceStartingCommitIfBranchMovedOn();
      const repositoryState = verifyRepository(phaseConfig, mode !== '--check');
      // Слияние базы идёт до слепка control plane и после переключения ветки:
      // база может принести правки `.agents/**` или `scripts/ralph/**`, и
      // слепок, снятый до неё, объявил бы их подделкой доверенных файлов.
      const mergedBase =
        mode !== '--check' && phaseConfig.syncBaseBranch && syncPhaseBranchWithBase(phaseConfig);
      // Слепок пересчитывается сразу после переключения ветки и до сессии
      // агента. `verifyRepository` — единственное место, где рабочее дерево
      // меняет сам цикл, а `.claude/**` и `AGENTS.md` есть не на каждой ветке:
      // старт с ветки, где их нет, иначе останавливает прогон с «AFK-сессия
      // изменила набор доверенных файлов инструкций» ещё до валидации:
      // обвиняется сессия, которая не начиналась, а файлы принёс чекаут по
      // команде самого цикла.
      const snapshot = controlPlaneSnapshot(phaseConfig);
      Object.assign(config, snapshot);
      Object.assign(phaseConfig, snapshot);
      if (mergedBase) {
        // HEAD сдвинулся слиянием, а не работой агента: сохранённая база issue
        // обязана переехать вместе с ним, иначе продолжение потребует HEAD,
        // который остался позади.
        advanceStartingCommitIfBranchMovedOn();
        verifyMergedBase(phaseConfig);
      }
      if (mode !== '--check') {
        reconcileStateAfterCrash(phaseConfig, activeStateStore());
      }
      verifyBaseHistory(phaseConfig);
      const milestone = milestones[phaseConfig.phaseIndex];
      return executeMode(
        {
          mode,
          config: phaseConfig,
          repository,
          milestone,
          repositoryState,
          rules,
          stateStore: activeStateStore(),
        },
        actions,
      );
    };

    if (mode === '--run') {
      return await runPhasePlan(config, activeStateStore(), runPhase);
    }
    return await runPhase(firstPhaseConfig);
  } catch (error) {
    console.error(`AFK pipeline error: ${error.message}`);
    throw error;
  } finally {
    try {
      releaseLock?.();
    } finally {
      restoreConsole();
    }
  }
}

// -----------------------------------------------------------------------------
// Точка входа: выполняется только при прямом запуске файла через node
// -----------------------------------------------------------------------------

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

export async function runCli() {
  try {
    await main();
  } catch (error) {
    console.error(`\nRalph Loop остановлен: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isMainModule) {
  await runCli();
}
