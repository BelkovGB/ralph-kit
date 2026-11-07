#!/usr/bin/env node

import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  acquireRunLock,
  initializePersistentLog,
  isTransientFailure,
  readJsonFile,
  resolveRalphRuntimeDirectory,
} from './ralph-runtime.mjs';

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
  verifyAgentSkills,
} from './ralph-config.mjs';

import {
  activeStateStore,
  createStateStore,
  holdIssuePublication,
  issueForeignPaths,
  runtimeStatePath,
  setActiveStateStore,
  unpublishedIssueHead,
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
  hostValidationEnvironment,
  hostWorkingTreeHash,
  runConfiguredValidation,
  runPreflight,
} from './ralph-validation-runner.mjs';

import {
  alreadyFixedCommitFromAgent,
  commitMessageFromAgent,
  commitStagedChanges,
  commitTrailerForIssue,
  isAncestorCommit,
  issueChangeInventory,
  linkedCommitForIssue,
  localGitHubRepository,
  pushBranchAndVerify,
  reconcileStateAfterCrash,
  syncPhaseBranchWithBase,
  verifiedIssueCommit,
  verifyBaseHistory,
  verifyPushedHead,
  gitPathKey,
  readWorkingTreeEntries,
  stageWorkingTreeEntries,
  workingTreeEntryPaths,
} from './ralph-git.mjs';

import {
  closeMilestone,
  closeIssueOnce,
  ensurePullRequestForBranch,
  issueState,
  openIssues,
  postIssueCommentOnce,
  publicIssueIdentity,
  pullRequestDetails,
  refreshIssue,
  reopenIssueWithComment,
  repositoryName,
  repositoryPermissions,
  verifyGitHubAuthentication,
  verifyMilestones,
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
  reviewContextText,
  normalizeReviewResult,
  updateIssueReviewContext,
} from './ralph-issue-contract.mjs';

import { buildIndependentReviewPrompt, renderPrompt } from './ralph-prompts.mjs';
import { assertProcessReport, resolveIssueProcess } from './ralph-process-packs.mjs';

import {
  analyzeRecovery, applyRecoveryPlan, committedRecoveryPhases, committedValidationFailurePatch,
  hasAcceptedLisaIssueRepair, prepareRecovery, resumeAcceptedIssue, savedIssueReview,
} from './ralph-recovery.mjs';

import { KIT_VERSION } from './ralph-version.mjs';
import { effectiveLisaIterationReserve, runWithSupervisor } from './ralph-supervisor.mjs';
import { parseUiOption, renderRunSummary } from './ralph-terminal.mjs';
import { createTerminalHost } from './ralph-terminal-host.mjs';
import { publishLiveStatus, readLiveStatus, reportActivity, resetLiveStatus, subscribeLiveStatus } from './ralph-live-status.mjs';
import { currentIssueMetrics } from './ralph-run-metrics.mjs';
import { runRalphLifecycleCli } from './ralph-lifecycle-host.mjs';
import { receiveRalphWorkerStart, sendRalphWorkerMessage, ralphRunOutcome } from './ralph-lifecycle.mjs';
import { lisaRepairTreeHash, lisaRepairIndexHash } from './ralph-lisa-repair.mjs';

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
const supportedModes = new Set(['--check', '--run', '--accept-manual-commit']);
const runtimeDirectory = resolveRalphRuntimeDirectory(projectRoot);
const runtimeLockPath = path.join(runtimeDirectory, 'run.lock');
const runtimeLogPath = path.join(runtimeDirectory, 'run.log');

// -----------------------------------------------------------------------------
// Проверка инструментов, Git-репозитория и рабочей ветки
// -----------------------------------------------------------------------------

function workingTreeStatus() {
  return run('git', ['status', '--porcelain']).stdout;
}

function assertCleanTree(message) {
  if (workingTreeStatus() !== '') {
    throw Object.assign(new Error(message), { code: 'RALPH_RECOVERY_BLOCKED' });
  }
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
export { committedRecoveryPhases };

function reportIssueMetrics(outcome) {
  const record = finishIssueMetrics(outcome);
  if (record) console.log(formatIssueMetrics(record));
}

// Валидация вызывается из трёх мест lifecycle, и замер, поставленный только в
// одном, занизил бы стоимость issue молча. Обёртка одна на все три.
function repairStepSucceeded(step, state = activeStateStore()?.state) {
  if (state) publishLiveStatus({ type: 'repair-step-passed',
    runId: state.runId, phaseIndex: state.phaseIndex, issueNumber: state.issue?.number ?? null, step });
}

function observeIssue(kind, details) {
  const state = activeStateStore()?.state;
  if (state?.issue) publishLiveStatus({ type: 'issue-observation', kind,
    runId: state.runId, phaseIndex: state.phaseIndex, issueNumber: state.issue.number, ...details });
}

async function observedRepairStep(step, operation) {
  try {
    const result = await operation();
    repairStepSucceeded(step);
    return result;
  } catch (error) {
    error.ralphFailureStep = step;
    throw error;
  }
}

function measuredValidation(runValidation) {
  const endStage = startStage('validation');
  try {
    const outcome = runValidation();
    repairStepSucceeded('validation');
    endStage();
    return outcome;
  } catch (error) {
    endStage({ failed: true });
    error.ralphFailureStep = 'validation';
    throw error;
  }
}

const diagnosticValidationCodes = new Set([
  'RALPH_VALIDATION_ENVIRONMENT',
  'RALPH_VALIDATION_PREEXISTING',
  'RALPH_VALIDATION_SCOPE_UNKNOWN',
  'RALPH_VALIDATION_UNSTABLE',
  'RALPH_COMMAND_TIMEOUT',
  'RALPH_COMMAND_IDLE_TIMEOUT',
]);

/**
 * Проверка ветки сразу после того, как в неё влита база.
 *
 * Слияние без конфликта не значит рабочее дерево: база могла изменить контракт,
 * который работа фазы использует, и Git об этом ничего не знает. Без этой
 * проверки поломка всплыла бы на первой же issue, и чинил бы её агент, который
 * её не вносил: он получил бы чужую ошибку под видом своей.
 *
 * В выборочном режиме область задаёт проект. Неизвестное влияние он сообщает
 * отдельным кодом ошибки и требует внешнего регресса.
 */
function verifyMergedBase(config, previousHead) {
  console.log('\n=== Проверка ветки после слияния базы ===\n');
  const endStage = startStage('validation');
  try {
    runConfiguredValidation(config, { scope: 'baseSync', baseCommit: previousHead });
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
  run(agentBinary(config), ['--version']);
}

// -----------------------------------------------------------------------------
// Формирование prompt для реализации одной issue
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Локальное ревью commit одной issue отдельной сессией агента
// -----------------------------------------------------------------------------

async function runIndependentReview(config, issue, commit, expectedHead) {
  const reviewedHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const reviewedBranch = run('git', ['branch', '--show-current']).stdout;
  if (reviewedHead !== expectedHead || reviewedBranch !== config.branch) {
    fail(`Issue #${issue.number}: перед ревью ожидается HEAD ${expectedHead} в ветке ${config.branch}.`);
  }

  // Замечания прошлого ревью вынимаются из тела issue в отдельную секцию
  // prompt: внутри тела они приезжают без подписи, вперемешку с критериями
  // готовности, и требованию «проверь их закрытие» опереться не на что.
  const saved = activeStateStore()?.issue;
  const previous = saved?.number === issue.number ? saved : null;
  const receipt = previous?.reviewReceipt;
  const inventory = issueChangeInventory(issue, commit, {
    afterHead: ['pass', 'fail'].includes(receipt?.result?.verdict) ? receipt.head : undefined,
    excludedPaths: config.reviewDiffExcludedPaths,
  });
  const reviewPrompt = buildIndependentReviewPrompt(
    config,
    { ...issue, body: issueBodyWithoutRalphMetadata(issue) },
    commit,
    {
      changes: inventory,
      previousFindings: previous?.reviewFindings ?? null,
      previousReview: inventory.afterHead ? { commit: inventory.afterHead, newCommits: inventory.commits } : null,
    },
  );

  console.log(`\n=== Independent review for issue #${issue.number} ===\n`);

  const reviewLabel = `Review issue #${issue.number}`;
  const candidate = await runReviewSession(config, config.review, {
    input: reviewPrompt,
    maxTurns: config.maxTurns,
    timeoutMs: config.runtime.agentTimeoutMs,
    label: reviewLabel,
  });

  assertReviewPayloadShape(candidate, reviewLabel);
  const review = applySeverityFloor(
    scopeReviewToProduct(normalizeReviewResult(candidate), reviewLabel),
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

  closeIssueOnce(repository, issue.number);
}

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
  return storedIssue?.number === issue.number && savedIssueReview(storedIssue, commit)?.verdict === 'pass';
}

function assertCommittedProcessReport(issue, commit, reportBase = `${commit}^`) {
  const saved = activeStateStore()?.issue;
  assertProcessReport(issue.processPack, reportBase, commit, {
    head: 'HEAD', committed: true, repair: saved?.commit === commit ? saved.processReportRepair : null,
  });
}

function assertIssueReadyForPublication(config, repository, issue, expectedHead, alreadyPublished = false) {
  if (issue.acceptedRepository && localGitHubRepository(config) !== issue.acceptedRepository) {
    throw Object.assign(new Error(`Issue #${issue.number}: origin изменился. Локальная работа сохранена.`), {
      code: 'RALPH_RECOVERY_BLOCKED',
    });
  }
  const githubHost = process.env.GH_HOST?.toLowerCase();
  if (issue.acceptedRepository && config.githubAccount == null && githubHost && githubHost !== 'github.com') {
    throw Object.assign(new Error(`Issue #${issue.number}: GH_HOST не соответствует публичному GitHub.`), {
      code: 'RALPH_RECOVERY_BLOCKED',
    });
  }
  const latest = refreshIssue(repository, issue.number);
  if (issue.acceptedRepository) {
    const target = publicIssueIdentity(latest.url);
    if (target?.repository !== issue.acceptedRepository || target.number !== issue.number || latest.number !== issue.number) {
      throw Object.assign(new Error(`Issue #${issue.number}: ответ GitHub относится к другой задаче. Локальная работа сохранена.`), {
        code: 'RALPH_UNTRUSTED_ISSUE',
      });
    }
  }
  const state = activeStateStore()?.state;
  const publishedHead = state?.issue?.pushedHead ?? state?.issue?.lastPublishedHead;
  const closedRepair = latest.state === 'CLOSED' && publishedHead && hasAcceptedLisaIssueRepair(state, issue) &&
    isAncestorCommit(publishedHead, expectedHead);
  const closingPublishedIssue = latest.state === 'CLOSED' && (alreadyPublished || closedRepair);
  const changedMilestone = issue.milestone != null ? latest.milestone !== issue.milestone
    : Boolean(issue.expectedMilestone && latest.milestoneTitle !== issue.expectedMilestone);
  if ((latest.state !== 'OPEN' && !closingPublishedIssue) || changedMilestone) {
    throw Object.assign(new Error(
      `Issue #${issue.number}: состояние или milestone изменились перед публикацией. Локальная работа сохранена.`,
    ), { code: 'RALPH_UNTRUSTED_ISSUE' });
  }
  assertTrustedIssue(config, latest, repository);
}

function publicationUnavailable(error) {
  if (isTransientFailure(error) || ['RALPH_GITHUB_ACCOUNT', 'RALPH_COMMAND_IDLE_TIMEOUT'].includes(error.code)) return true;
  return error.code === 'RALPH_COMMAND_FAILED' &&
    /\bdial (?:tcp|udp).*?\b(?:lookup|connectex)|\b(?:no such host|network is unreachable|no route to host|connection refused|couldn't connect to server)\b/iu
      .test(`${error.message}\n${error.stderr ?? ''}`);
}

function publicationValidationFingerprint(config, stateStore, base) {
  if (!config.trustedControlFileHashes?.size || !/^[a-f0-9]{40}$/u.test(base ?? '')) return null;
  const environment = hostValidationEnvironment(config, process.env, stateStore?.validationPathDirectories ?? []);
  return createHash('sha256').update(JSON.stringify({
    base, issue: stateStore?.issue?.number, branch: config.branch,
    controlPlane: [...config.trustedControlFileHashes].sort(),
    preflight: config.preflightScripts, validation: config.validationProfiles ?? config.validationScripts,
    browser: config.browserValidationScripts, artifacts: config.validationArtifactPaths,
    environment: Object.entries(environment).sort(),
  })).digest('hex');
}

function pendingIssuePublication(config, stateStore, head = stateStore?.issue?.recoveryHead) {
  const issue = stateStore?.issue;
  const checkpoint = issue?.publicationCheckpoint;
  if (!config.review?.enabled || !issue?.commit || !committedRecoveryPhases.includes(issue.phase) ||
      !head || checkpoint?.head !== head || issue.reviewReceipt?.head !== head ||
      issue.reviewReceipt.result?.verdict !== 'pass') return null;
  const pending = checkpoint.step === 'push' ? issue.pendingPublishHead === head && issue.pushedHead !== head
    : checkpoint.step === 'close' && issue.phase === 'closing' && issue.pushedHead === head;
  if (!pending || typeof checkpoint.fingerprint !== 'string') return null;
  return checkpoint.fingerprint === publicationValidationFingerprint(config, stateStore, checkpoint.base) ? checkpoint : null;
}

async function reviewAndCloseCommittedIssue(config, repository, issue, commit, expectedHead, { reportBase, validationBase } = {}) {
  assertCommittedProcessReport(issue, commit, reportBase);
  assertCleanTree(`Issue #${issue.number}: перед ревью или публикацией требуется чистое рабочее дерево.`);
  const store = activeStateStore();
  const storedIssue = store?.issue?.number === issue.number ? store.issue : null;
  const alreadyPublished = storedIssue?.pushedHead === expectedHead;
  const pendingPublication = alreadyPublished ? {} : holdIssuePublication(storedIssue, expectedHead);
  let review = config.review.enabled
    ? savedIssueReview(storedIssue, expectedHead)
    : { verdict: 'pass', summary: 'Independent review is disabled.', findings: [] };

  if (!review) {
    store?.updateIssue({ phase: 'reviewing', commit, recoveryHead: expectedHead, ...pendingPublication });
    const endReview = startStage('review');
    try {
      review = await observedRepairStep('review', () => runReviewWithRetries(
        config,
        () => runIndependentReview(config, issue, commit, expectedHead),
        `Review issue #${issue.number}`,
      ));
      endReview();
    } catch (error) {
      endReview({ failed: true });
      store?.updateIssue(recordedFailure(error));
      throw error;
    }
  }

  const receipt = config.review.enabled ? { head: expectedHead, result: review } : null;
  const scope = `independent review of issue #${issue.number} at commit ${expectedHead}`;
  if (review.verdict !== 'pass') {
    const reviewFixAttempts = (store?.issue?.reviewFixAttempts ?? 0) + 1;
    // Следующая сессия читает замечания из состояния, даже если GitHub недоступен.
    store?.updateIssue({
      phase: 'review-failed',
      startingCommit: expectedHead,
      recoveryHead: expectedHead,
      commit,
      reviewedCommit: expectedHead,
      reviewReceipt: receipt,
      publicationCheckpoint: null,
      ...pendingPublication,
      expectedTree: null,
      commitMessage: null,
      validationFixAttempts: 0,
      reviewFixAttempts,
      reviewFindings: reviewContextText(review),
      ...clearedFailure,
    });
    observeIssue('review-fail', { findings: review.findings.length, commit, pushedHead: store?.issue?.pushedHead });
    try {
      assertIssueReadyForPublication(config, repository, issue, expectedHead);
      recordDeferredFindingsSafely(config, repository, review, scope);
      updateIssueReviewContext(repository, issue, review);
      reopenIssueWithComment(repository, issue, formatReviewComment(review));
    } catch (error) {
      if (!publicationUnavailable(error)) throw error;
      console.error(`Issue #${issue.number}: замечания сохранены локально, GitHub недоступен. ${error.message}`);
    }

    const lisaOwnsIssue = hasAcceptedLisaIssueRepair(store?.state, issue);
    if (lisaOwnsIssue || reviewFixAttempts >= config.maxReviewFixAttempts) {
      console.error(
        `Issue #${issue.number}: ревью отклонило работу ${reviewFixAttempts} раз подряд. ` +
          (alreadyPublished
            ? 'Issue отложена до конца прогона: работа в ветке, замечания в её теле.'
            : 'Локальный коммит сохранён. Публикация ветки остановлена до исправления.'),
      );
      if (alreadyPublished && !config.supervisor?.enabled) store?.clearIssue();
      return { completed: false, parked: true, publicationBlocked: !alreadyPublished, commit, review };
    }
    return { completed: false, commit, review };
  }

  // Вердикт относится к проверенному HEAD независимо от состояния публикации.
  const resumePhase = committedRecoveryPhases.includes(store?.issue?.phase) ? {} : { phase: 'committed' };
  const fingerprint = receipt ? publicationValidationFingerprint(config, store, validationBase) : null;
  const checkpoint = fingerprint ? {
    head: expectedHead, base: validationBase, fingerprint, step: alreadyPublished ? 'close' : 'push',
  } : null;
  if (checkpoint) assertTrustedControlFilesUnchanged(config);
  store?.updateIssue({ ...resumePhase, commit, recoveryHead: expectedHead,
    reviewReceipt: receipt, publicationCheckpoint: checkpoint, ...pendingPublication, ...clearedFailure });
  if (!alreadyPublished) {
    assertCleanTree(`Issue #${issue.number}: перед push требуется чистое рабочее дерево.`);
    await observedRepairStep('push', () => {
      assertIssueReadyForPublication(config, repository, issue, expectedHead);
      return pushBranchAndVerify(config, { expectedHead });
    });
    store?.updateIssue({ phase: 'closing', pushedHead: expectedHead, pendingPublishHead: null,
      publicationCheckpoint: checkpoint && { ...checkpoint, step: 'close' } });
  }
  await observedRepairStep('close', () => {
    assertIssueReadyForPublication(config, repository, issue, expectedHead, true);
    verifyPushedHead(config, expectedHead);
    if (alreadyPublished && (storedIssue.phase !== 'closing' || storedIssue.pendingPublishHead)) {
      store?.updateIssue({ phase: 'closing', pendingPublishHead: null });
    }
    if (config.review.enabled) {
      // Lisa подтверждает восстановление только на сверенном опубликованном HEAD.
      repairStepSucceeded('review-failed');
      recordDeferredFindingsSafely(config, repository, review, scope);
    }
    return closeIssue(config, repository, issue, commit, review);
  });
  store?.clearIssue();
  return { completed: true, commit, review };
}

function isForeignEntry(entry, foreignPaths) {
  return workingTreeEntryPaths(entry).some((file) => foreignPaths.has(gitPathKey(file)));
}

function assertNoForeignStaging(entries, foreignPaths) {
  if (entries.some((entry) => isForeignEntry(entry, foreignPaths) && ![' ', '?'].includes(entry.index))) {
    throw Object.assign(new Error('В индексе есть чужие изменения; ремонт сохранён без commit. Нужен оператор.'),
      { code: 'RALPH_RECOVERY_BLOCKED' });
  }
}

// Preflight may generate tracked output. Stage the validated post-preflight
// tree, excluding operator-owned paths; tests themselves remain read-only.
export function validateIssueWorkingTree(config, foreignPaths, dependencies = {}) {
  const readEntries = dependencies.readWorkingTreeEntries ?? readWorkingTreeEntries;
  const validate = dependencies.runConfiguredValidation ?? runConfiguredValidation;
  const foreignKeys = new Set([...foreignPaths].map(gitPathKey));
  let prepared = readEntries();
  validate(config, {
    scope: 'issue',
    baseCommit: dependencies.baseCommit,
    issueNumber: dependencies.issueNumber,
    skipPreflight: Boolean(config.validationProfiles),
    onPrepared: () => { prepared = readEntries(); },
  });
  if (JSON.stringify(readEntries()) !== JSON.stringify(prepared)) fail('Validation changed the prepared working tree.');
  assertNoForeignStaging(prepared, foreignKeys);
  return prepared.filter((entry) => !isForeignEntry(entry, foreignKeys));
}

function retryIssueValidation(config, issue, error) {
  const attempts = (activeStateStore()?.issue?.validationFixAttempts ?? 0) + 1;
  activeStateStore()?.updateIssue({
    phase: 'working-tree',
    validationFixAttempts: attempts,
    ...recordedFailure(error),
  });
  observeIssue('validation-fail');
  if (attempts >= config.maxTestFixAttempts) throw error;
  console.error(
    `Issue #${issue.number}: validation не прошла (${attempts}/${config.maxTestFixAttempts}). ` +
      'Ralph передаст ошибку агенту на следующей итерации.',
  );
  return { completed: false, validationFailed: true };
}

function shouldCommitAcceptedRepair(state, issue) {
  return hasAcceptedLisaIssueRepair(state, issue) && !state.issue.commit &&
    !state.issue.processReportRepair?.needsDevelopment;
}

async function commitAndCompleteIssue(config, repository, issue, startingCommit, lastAgentMessage) {
  assertTrustedControlFilesUnchanged(config);
  const currentBranch = run('git', ['branch', '--show-current']).stdout;
  const currentCommit = run('git', ['rev-parse', 'HEAD']).stdout;
  const changes = readWorkingTreeEntries();
  const violations = [];

  if (currentBranch !== config.branch) {
    violations.push(`Агент переключился на ветку ${currentBranch}`);
  }
  if (currentCommit !== startingCommit) {
    violations.push('Агент самостоятельно создал commit');
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
  const foreignPaths = new Set(issueForeignPaths(activeStateStore()?.issue).map(gitPathKey));
  assertNoForeignStaging(changes, foreignPaths);
  const agentEntries = changes.filter((entry) => !isForeignEntry(entry, foreignPaths));
  const untouchedForeign = changes.filter((entry) => isForeignEntry(entry, foreignPaths)).map((entry) => entry.path);
  if (untouchedForeign.length > 0) {
    console.log(
      `Issue #${issue.number}: вне коммита оставлено ${untouchedForeign.length} файлов, ` +
        `изменённых до начала задачи: ${untouchedForeign.slice(0, 5).join(', ')}` +
        `${untouchedForeign.length > 5 ? ' и другие' : ''}.`,
    );
  }

  if (agentEntries.length === 0) {
    const alreadyFixedCommit = alreadyFixedCommitFromAgent(lastAgentMessage);
    if (!alreadyFixedCommit) {
      fail(`Issue #${issue.number}: агент не оставил изменений и не указал ALREADY_FIXED commit.`);
    }
    const commit = verifiedIssueCommit(alreadyFixedCommit, issue);
    const parent = run('git', ['rev-parse', '--verify', `${commit}^`], { allowFailure: true });
    if (parent.status !== 0 || !/^[0-9a-f]{40}$/.test(parent.stdout)) {
      fail(`Issue #${issue.number}: у ALREADY_FIXED commit ${commit} нет базового родителя для проверки.`);
    }
    assertCommittedProcessReport(issue, commit, parent.stdout);
    const storedIssue = activeStateStore()?.issue;
    const pending = storedIssue?.pushedHead === currentCommit ? {} : holdIssuePublication(storedIssue, currentCommit);
    activeStateStore()?.updateIssue({ phase: 'validating', ...pending });
    try {
      measuredValidation(() => runConfiguredValidation(config, {
        scope: 'issue', baseCommit: parent.stdout,
        issueNumber: issue.number,
        skipPreflight: Boolean(config.validationProfiles),
      }));
    } catch (error) {
      if (error.code === 'RALPH_VALIDATION_MUTATED') {
        activeStateStore()?.updateIssue({
          phase: 'validation-mutated',
          validationExpectedTreeHash: error.expectedTreeHash,
          ...recordedFailure(error),
        });
        throw error;
      }
      if (diagnosticValidationCodes.has(error.code)) {
        activeStateStore()?.updateIssue({
          phase: 'validation-diagnostic', lastAgentMessage, ...recordedFailure(error),
        });
        throw error;
      }
      return retryIssueValidation(config, issue, error);
    }
    if (JSON.stringify(readWorkingTreeEntries()) !== JSON.stringify(changes)) {
      fail(`Issue #${issue.number}: проверки already-fixed решения изменили рабочее дерево.`);
    }
    return reviewAndCloseCommittedIssue(config, repository, issue, commit, currentCommit, { validationBase: parent.stdout });
  }

  activeStateStore()?.updateIssue({ phase: 'validating' });
  let validatedEntries;
  try {
    validatedEntries = measuredValidation(() => validateIssueWorkingTree(config, foreignPaths, {
      baseCommit: startingCommit,
      issueNumber: issue.number,
    }));
  } catch (error) {
    if (error.code === 'RALPH_VALIDATION_MUTATED') {
      activeStateStore()?.updateIssue({
        phase: 'validation-mutated',
        validationExpectedTreeHash: error.expectedTreeHash,
        ...recordedFailure(error),
      });
      throw error;
    }
    if (diagnosticValidationCodes.has(error.code)) {
      activeStateStore()?.updateIssue({
        phase: 'validation-diagnostic', lastAgentMessage, ...recordedFailure(error),
      });
      throw error;
    }
    return retryIssueValidation(config, issue, error);
  }
  activeStateStore()?.updateIssue({ phase: 'staging' });
  // Именно пути агента, а не `--all`: остальное в дереве принадлежит оператору
  // и обязано остаться незакоммиченным.
  //
  // Стадируется только то, что изменено в рабочем дереве. Путь, уже полностью
  // лежащий в индексе, `git add` не примет: после `git rm` файла нет ни в
  // дереве, ни в индексе, и pathspec не совпадает ни с чем — код 128 и обрыв
  // прогона. В коммит такой путь и так попадёт, он уже застадирован.
  stageWorkingTreeEntries(validatedEntries);

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
  const store = activeStateStore();
  const reportRepair = hasAcceptedLisaIssueRepair(store?.state, issue) ? store.issue.processReportRepair : null;
  try {
    assertProcessReport(issue.processPack, startingCommit, expectedTree, { repair: reportRepair });
  } catch (error) {
    if (error.code !== 'RALPH_PROCESS_EVIDENCE') throw error;
    console.error(`Issue #${issue.number}: ${error.message}`);
    if (shouldCommitAcceptedRepair(store?.state, issue)) {
      // Lisa can repair the toolchain before the deliverable is ready.
      store.updateIssue({
        phase: 'working-tree',
        processReportRepair: { ...reportRepair, needsDevelopment: true },
        ...recordedFailure(error),
      });
      return { completed: false, validationFailed: true };
    }
    return retryIssueValidation(config, issue, error);
  }
  store?.updateIssue({
    phase: 'staging',
    expectedTree,
    commitMessage,
    ...(issue.processPack?.reportPath ? { processReportRepair: reportRepair ?? null } : {}),
  });
  commitStagedChanges(commitMessage, issue, config.runtime.validationTimeoutMs);

  const commitCount = Number(run('git', ['rev-list', '--count', `${startingCommit}..HEAD`]).stdout);
  // Чистое дерево здесь не требуется: файлы оператора намеренно остались вне
  // коммита. Требуется другое — чтобы после коммита не осталось ничего, что
  // агент изменил сам.
  const leftBehind = readWorkingTreeEntries().filter((entry) => !isForeignEntry(entry, foreignPaths))
    .map((entry) => entry.path);
  if (commitCount !== 1 || leftBehind.length > 0) {
    fail(
      `Issue #${issue.number}: оркестратор ожидал один commit и никаких своих изменений вне него, ` +
        `получено commits=${commitCount}, вне коммита: ${leftBehind.join(', ') || 'нет'}.`,
    );
  }

  const commit = run('git', ['rev-parse', 'HEAD']).stdout;
  activeStateStore()?.updateIssue({
    phase: 'committed',
    recoveryHead: commit,
    commit,
    pushedHead: null,
    ...holdIssuePublication(store?.issue, commit),
    ...clearedFailure,
  });
  return reviewAndCloseCommittedIssue(config, repository, issue, commit, commit, { validationBase: startingCommit });
}

// -----------------------------------------------------------------------------
// Реализация одной issue агентом и проверка правил завершения
// -----------------------------------------------------------------------------

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

export async function runAgentOnIssue(config, repository, issue, rules) {
  issue = assertTrustedIssue(config, issue, repository);
  issue.processPack = resolveIssueProcess(config, issue.number);
  if (issue.processPack) console.log(`Issue #${issue.number}: режим ${issue.processPack.kind}.`);
  const storedIssue =
    activeStateStore()?.issue?.number === issue.number ? activeStateStore().issue : null;
  if (storedIssue) {
    applyRecoveryPlan(analyzeRecovery(config, storedIssue, { hostWorkingTreeHash }), activeStateStore());
  }
  recoverHostValidationMutation(storedIssue);
  if (shouldCommitAcceptedRepair(activeStateStore()?.state, issue)) {
    return commitAndCompleteIssue(config, repository, issue, storedIssue.startingCommit,
      `fix: repair issue #${issue.number} with Lisa`);
  }
  if (storedIssue?.commit && committedRecoveryPhases.includes(storedIssue.phase)) {
    assertCleanTree(`Issue #${issue.number}: committed recovery требует чистое рабочее дерево.`);
    const commit = verifiedIssueCommit(storedIssue.commit, issue);
    const expectedHead = storedIssue.recoveryHead ?? storedIssue.pushedHead ?? commit;
    const base = storedIssue.startingCommit;
    const reportBase = issue.processPack?.reportPath && base !== commit && isAncestorCommit(base, commit)
      ? base : undefined;
    assertCommittedProcessReport(issue, commit, reportBase);
    console.log(
      `Issue #${issue.number}: продолжаем pipeline с сохранённого commit ${commit} ` +
        `(phase=${storedIssue.phase}).`,
    );
    const publication = pendingIssuePublication(config, activeStateStore(), expectedHead);
    if (publication) {
      assertTrustedControlFilesUnchanged(config);
      console.log(`Issue #${issue.number}: проверки и PASS подтверждены для ${expectedHead}. Продолжаем ${publication.step}.`);
    } else {
      const resumePhase = storedIssue.phase;
      try {
        measuredValidation(() => runConfiguredValidation(config, {
          scope: 'issue', baseCommit: base,
          issueNumber: issue.number,
          skipPreflight: Boolean(config.validationProfiles), retryConnectionFailure: true,
        }));
      } catch (error) {
        activeStateStore().updateIssue({
          phase: resumePhase, publicationCheckpoint: null,
          ...committedValidationFailurePatch(storedIssue, error),
          ...recordedFailure(error),
        });
        throw error;
      }
    }
    return reviewAndCloseCommittedIssue(config, repository, issue, commit, expectedHead, {
      reportBase, validationBase: publication?.base ?? base,
    });
  }

  if (storedIssue?.phase === 'validation-diagnostic') {
    console.log(`Issue #${issue.number}: повторяем проверку после диагностики без запуска агента разработки.`);
    return commitAndCompleteIssue(
      config, repository, issue, storedIssue.startingCommit, storedIssue.lastAgentMessage,
    );
  }

  const currentHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const continuation = Boolean(storedIssue);
  // beginIssue переводит сохранённую issue в agent-running. Recovery-prompt
  // нужно собрать раньше, пока в состоянии ещё видна причина продолжения.
  const continuationPrompt = continuation ? recoveryPrompt(storedIssue) : '';
  // База уже сдвинута в начале фазы, до проверки рабочего дерева; здесь
  // остаётся простое сравнение.
  const startingCommit = storedIssue?.startingCommit ?? currentHead;
  if (startingCommit !== currentHead) {
    fail(
      `Issue #${issue.number}: recovery ожидал HEAD ${startingCommit}, но найден ${currentHead}.`,
    );
  }
  activeStateStore()?.beginIssue(issue, startingCommit,
    continuation ? [] : readWorkingTreeEntries().flatMap(workingTreeEntryPaths));

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
    codexResult = await observedRepairStep('development', () => runDevelopmentSession(config, {
      input: renderPrompt(config, issue, rules) + continuationPrompt,
      maxTurns: config.maxTurns,
      timeoutMs: config.runtime.agentTimeoutMs,
      label: `${config.agentCli} issue #${issue.number}`,
    }));
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

  const phaseBase = verifyBaseHistory(config);
  const checkedHead = config.browserValidationScripts?.length
    ? run('git', ['rev-parse', 'HEAD']).stdout : undefined;
  runConfiguredValidation(config, {
    scope: 'phase', baseCommit: phaseBase,
    skipPreflight: Boolean(config.validationProfiles),
  });
  assertValidationLeftTree(
    '',
    'Нельзя обновить PR: проектные проверки изменили чистое рабочее дерево.',
  );
  const commitCount = Number(
    run('git', ['rev-list', '--count', `origin/${config.baseBranch}..HEAD`]).stdout,
  );
  if (!Number.isInteger(commitCount) || commitCount < 1) {
    fail(`В ветке ${config.branch} нет коммитов поверх origin/${config.baseBranch}.`);
  }

  pushBranchAndVerify(config, { expectedHead: checkedHead });

  const pullRequest = ensurePullRequestForBranch(config, repository);
  if (checkedHead && pullRequest.headRefOid !== checkedHead) {
    fail(`HEAD PR #${pullRequest.number} изменился после проверки фазы: проверен ${checkedHead}, получен ${pullRequest.headRefOid}.`);
  }
  return pullRequest;
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
  const limit = config.maxIterations + effectiveLisaIterationReserve(config, stateStore);
  const used = stateStore?.iterationsUsed ?? 0;
  return { used, limit, remaining: Math.max(0, limit - used) };
}

function printScriptList(label, scripts) {
  const commands = scripts ?? [];
  if (commands.length === 0) return;
  console.log(`${label}:`);
  commands.forEach((command, index) => {
    console.log(`  ${index + 1}. ${command}`);
  });
}

export function printCheck(
  config,
  repository,
  milestone,
  repositoryState,
  issues,
  budget = iterationBudget(config, null),
  { queueError, publicationStatus, baseError } = {},
) {
  const queueAvailable = issues !== null;
  issues ??= [];
  console.log('Диагностика конфигурации Ralph Loop завершена.');
  console.log(`Состояние запуска: active=${config.active === true}`);
  console.log('Агент и команды проверок проекта не запускались; готовность фазы требует их отдельной проверки.');
  console.log(`Версия набора: ${KIT_VERSION}`);
  console.log(`Фаза: ${(config.phaseIndex ?? 0) + 1}/${config.phaseCount ?? 1}`);
  console.log(`Репозиторий: ${repository ?? 'не определён'}`);
  console.log(`Milestone: ${milestone.title}${queueAvailable ? ` (${issues.length} открытых issues)` : ''}`);
  if (queueError) console.log(`Очередь GitHub недоступна: ${queueError}`);
  if (publicationStatus) console.log(`Публикация: ${publicationStatus}`);
  if (baseError) console.log(`История локальной базы не проверена: ${baseError}`);
  console.log(`Ветка: ${repositoryState.currentBranch}`);
  console.log(`Рабочее дерево: ${repositoryState.clean ? 'чистое' : 'есть изменения'}`);
  console.log(
    `Итерации: использовано ${budget.used}/${budget.limit}, осталось ${budget.remaining}`,
  );
  console.log(`Лимит шагов на сессию: ${config.maxTurns}`);
  console.log(`Лимит исправлений тестов: ${config.maxTestFixAttempts}`);
  console.log(`Модель разработки: ${config.developmentModel} (effort=${config.developmentEffort})`);
  if (config.supervisor?.enabled) {
    console.log(
      `Lisa: ${config.supervisor.agentCli} / ${config.supervisor.model} (effort=${config.supervisor.effort}), ` +
        `до ${config.supervisor.maxInterventions} вызовов на фазу`,
    );
  }
  console.log(`Правила сессии: ${config.rulesFile}`);
  // Команды нумерованы, потому что порядок — часть настройки: прогон
  // останавливается на первой упавшей команде, и агент получает сводку только по
  // ней. Подготовка необязательна, её пустой список нормален и молчит.
  printScriptList('Команды подготовки', config.preflightScripts);
  if (config.validationProfiles) {
    printScriptList('Проверки задачи', config.validationProfiles.issue);
    printScriptList('Проверки фазы', config.validationProfiles.phase);
    printScriptList('Проверки после слияния базы', config.validationProfiles.baseSync);
  } else {
    printScriptList('Команды проверок', config.validationScripts);
  }
  printScriptList('Браузерные проверки', config.browserValidationScripts ?? []);
  for (const issue of issues) {
    const approved = config.approvedIssueSnapshots?.[issue.number];
    const pack = resolveIssueProcess(config, issue.number, approved?.body ?? issueBodyWithoutRalphMetadata(issue));
    if (pack) console.log(`Issue #${issue.number}: режим ${pack.kind}.`);
  }
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
  } else if (queueAvailable) {
    console.log('Открытых issues нет; режим --run попытается создать PR.');
  }
  // Журнал внутри scripts/ralph легко заменить образцом при обновлении.
  // Установщик обязан сохранить его содержимое. Проверка по строке
  // конфига, а не по диску: предупреждение нужно до того, как файл потеряли.
  const approvedLedger = String(config.approvedIssueSnapshotsFile ?? '').replaceAll('\\', '/');
  if (approvedLedger.startsWith('scripts/ralph/')) {
    console.log(
      `ВНИМАНИЕ: журнал одобренных issues лежит в ${approvedLedger}; ` +
        'обновление набора перезаписывает файлы поставки в этом каталоге. Сохраните журнал и перенесите его, например в ' +
        '.agents/approved-issues.json, поправьте "approvedIssueSnapshotsFile" и ' +
        'сумму в конфиге; порядок описан в INSTALL.md набора.',
    );
  }
  // Пустой список проверок — самая дорогая незаполненная настройка: цикл дойдёт
  // до коммита и ревью, ни разу не запустив тесты, и промолчит об этом.
  if (!config.validationProfiles && (config.validationScripts ?? []).length === 0) {
    console.log(
      'ВНИМАНИЕ: команды проверок не заданы для обычных задач. ' +
        `Заполните "validationScripts" в ${path.relative(
          projectRoot,
          configPath,
        )} или на вкладке «Проверки» пульта.`,
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
  if (config.stopAfterFirstIssue) {
    console.log('Режим одной задачи: повторы продолжают её до успеха или лимита; следующая issue не берётся.');
  } else if (budget.remaining > 0 && budget.remaining < issues.length) {
    console.log(
      'ВНИМАНИЕ: бюджета итераций меньше, чем открытых issues; полная фаза может остановиться до завершения. ' +
        'Учтите также повторные попытки и новые задачи ревью.',
    );
  }
  if (config.milestoneReview.enabled && config.autoApproveConfiguredIssues === false) {
    console.log(
      'ВНИМАНИЕ: autoApproveConfiguredIssues=false — новые issues ревью фазы требуют ' +
        'ручного добавления одобренных снимков; непрерывное автоисправление остановится.',
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
  const { config, rules } = context;
  let { repository, milestone, localRepository } = context;
  publishPhaseConfig(config);
  const stateStore = context.stateStore ?? activeStateStore();
  let deferredPreflight = context.deferredPreflight;
  let iteration = stateStore?.iterationsUsed ?? 0;
  const pendingIssues = new Map();
  const completedIssueNumbers = new Set();
  const completedInRun = new Set();
  let singleIssueNumber = config.stopAfterFirstIssue ? (stateStore?.issue?.number ?? null) : null;
  // Issues, которые ревью отклоняло подряд до предела. Из очереди этого прогона
  // они убраны, но остаются открытыми: их разбирает оператор или следующий
  // прогон, а бюджет достаётся остальным.
  const parkedIssueNumbers = new Set();
  const reportQueueProgress = (remaining) => publishLiveStatus({
    type: 'queue-progress',
    queueProgress: { completedInRun: completedInRun.size, remaining, parked: parkedIssueNumbers.size },
  });

  while (true) {
    if (deferredPreflight && !pendingIssuePublication(config, stateStore)) {
      actions.runPreflight(config);
      deferredPreflight = false;
    }
    const acceptedIssue = actions.resumeAcceptedIssue?.(config, stateStore);
    if (acceptedIssue) {
      if (repository && repository.toLowerCase() !== acceptedIssue.acceptedRepository) {
        fail(`Issue #${acceptedIssue.number}: локальный origin изменился после выбора задачи.`);
      }
      repository = acceptedIssue.acceptedRepository;
      reportActivity('queue', `Продолжение принятой issue #${acceptedIssue.number} из локального снимка`);
    } else {
      if (context.resolveQueue) ({ repository, milestone, localRepository } = context.resolveQueue(repository));
      reportActivity('queue', 'Обновление очереди задач в GitHub');
    }
    const listedIssues = acceptedIssue ? [acceptedIssue] : actions
      .openIssues(repository, milestone).filter((issue) => !isRalphInfrastructureIssue(issue));
    // GitHub может кратко вернуть пустую страницу сразу после закрытия issue.
    // Держим уже увиденные открытые задачи в локальной очереди, но прямым GET
    // подтверждаем состояние каждой пропавшей задачи.
    for (const issue of listedIssues) {
      if (
        !completedIssueNumbers.has(issue.number) &&
        !parkedIssueNumbers.has(issue.number) &&
        !pendingIssues.has(issue.number)
      ) {
        pendingIssues.set(issue.number, issue);
      }
    }
    const listedIssueNumbers = new Set(listedIssues.map((issue) => issue.number));
    for (const [issueNumber, pendingIssue] of acceptedIssue ? [] : pendingIssues) {
      if (listedIssueNumbers.has(issueNumber)) continue;
      // Пропасть из списка фазы задача может тремя способами, и все три —
      // решение оператора снять её с цикла: её закрыли, вынули из milestone или
      // пометили служебной. Один GET отвечает на все три вопроса сразу.
      let confirmed;
      try {
        confirmed = actions.refreshIssue(repository, issueNumber, pendingIssue);
      } catch (error) {
        // Отказ проверки — не ответ GitHub о задаче: 404 на удалённую задачу и
        // 5xx после повторов выглядят одинаково, поэтому очередь не меняем и
        // прогон не роняем в самом частом месте цикла.
        console.error(
          `Состояние issue #${issueNumber} подтвердить не удалось: ${error.message}. ` +
            'Задача осталась в очереди.',
        );
        continue;
      }
      const removalReason =
        confirmed.state !== 'OPEN'
          ? 'закрыта'
          : confirmed.milestone !== milestone.number
            ? 'вынута из milestone'
            : isRalphInfrastructureIssue(confirmed)
              ? 'помечена служебной'
              : null;
      if (removalReason !== null) {
        pendingIssues.delete(issueNumber);
        console.log(`Issue #${issueNumber} убрана из очереди прогона: ${removalReason}.`);
      }
    }
    const issuesByNumber = new Map();
    // Сначала добавляем ответ GitHub, затем локальную очередь: локальная копия
    // содержит самый свежий body после review и должна победить устаревший REST-ответ.
    for (const issue of acceptedIssue ? listedIssues : [...listedIssues, ...pendingIssues.values()]) {
      if (parkedIssueNumbers.has(issue.number)) continue;
      if (completedIssueNumbers.has(issue.number)) {
        // REST-список может кратко вернуть уже закрытую issue. Прямой GET
        // отличает этот stale-ответ от настоящего повторного открытия.
        if (actions.issueState(repository, issue.number) !== 'OPEN') {
          continue;
        }
        completedIssueNumbers.delete(issue.number);
        completedInRun.delete(issue.number);
        // Переоткрытую задачу возвращаем в очередь: без этого она живёт одну
        // итерацию и теряется на первом же пустом ответе GitHub.
        pendingIssues.set(issue.number, issue);
      }
      issuesByNumber.set(issue.number, issue);
    }
    const recoveryIssue = stateStore?.issue;
    if (recoveryIssue && isRalphInfrastructureIssue(recoveryIssue)) {
      if (unpublishedIssueHead(recoveryIssue) || actions.workingTreeStatus() !== '') {
        fail(
          `Сохранённая служебная issue #${recoveryIssue.number} имеет локальные изменения. ` +
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
      if (actions.issueState(repository, recoveryIssue.number) === 'OPEN' || hasAcceptedLisaIssueRepair(stateStore?.state)) {
        issuesByNumber.set(recoveryIssue.number, {
          number: recoveryIssue.number,
          title: recoveryIssue.title,
          url: recoveryIssue.url,
          body: recoveryIssue.body ?? '',
          authorLogin: recoveryIssue.authorLogin ?? null,
          authorAssociation: recoveryIssue.authorAssociation ?? null,
        });
      } else {
        if (unpublishedIssueHead(recoveryIssue)) {
          fail(`Issue #${recoveryIssue.number} закрыта. Неопубликованный коммит сохранён в ветке задачи.`);
        }
        if (actions.workingTreeStatus() !== '') {
          fail(
            `Сохранённая issue #${recoveryIssue.number} закрыта, но её рабочее дерево ` +
              'содержит изменения. Ralph не будет переносить их в следующую issue.',
          );
        }
        repairStepSucceeded('close', stateStore.state);
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
    reportQueueProgress(issues.length);
    if (issues.length === 0) {
      if (config.stopAfterFirstIssue) {
        console.log('Открытых issues нет. Для push и создания PR снимите stopAfterFirstIssue.');
        stateStore?.finish();
        return { mode: 'run', completed: 0 };
      }
      reportActivity('pull-request', 'Подготовка pull request фазы');
      const pullRequest = await observedRepairStep('pull-request', () => actions.createPullRequest(config, repository));
      // Телеметрия роли `milestone-review` снимается только внутри активной
      // записи, а между задачами её нет: без отдельной записи самая дорогая
      // сессия прогона не попадает в журнал вовсе. Запись без номера issue —
      // приписать её последней задаче milestone значило бы завысить именно ту
      // задачу, которой не повезло закрыться последней.
      actions.beginIssueMetrics?.(issueMetricsContext(config, null, iteration));
      let review;
      try {
        reportActivity('milestone-review', `Ревью фазы: PR #${pullRequest.number}`);
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
        reportActivity('queue', 'Проверка новых задач после ревью фазы');
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
        reportActivity('pull-request', `Проверка PR #${pullRequest.number} после ревью`);
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
          if (!config.supervisor?.enabled) stateStore?.finish();
          return {
            mode: 'run',
            verdict: 'parked',
            iterations: iteration,
            pullRequest,
            parkedIssues: [...parkedIssueNumbers],
          };
        }
        reportActivity('milestone-close', 'Закрытие завершённой фазы в GitHub');
        actions.closeMilestone(repository, milestone);
        return { verdict: 'pass', iterations: iteration, pullRequest };
      }

      reportActivity('review-results', `Создание задач по замечаниям к PR #${pullRequest.number}`);
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
        completedInRun.delete(refreshedReviewIssue.number);
        pendingIssues.set(refreshedReviewIssue.number, refreshedReviewIssue);
      }
      console.log(
        `Milestone review создал или переоткрыл ${reviewIssues.length} issues. Ralph продолжает цикл исправлений.`,
      );
      continue;
    }

    if (config.stopAfterFirstIssue && singleIssueNumber !== null &&
        !issues.some((issue) => issue.number === singleIssueNumber)) {
      console.log(`Issue #${singleIssueNumber} покинула очередь. Следующую задачу не берём.`);
      return { mode: 'run', completed: 0, issueNoLongerOpen: true };
    }
    let currentIssue = config.stopAfterFirstIssue && singleIssueNumber !== null
      ? issues.find((issue) => issue.number === singleIssueNumber)
      : issues[0];
    if (config.stopAfterFirstIssue) singleIssueNumber ??= currentIssue.number;
    reportActivity('issue-preparation', `Подготовка задачи #${currentIssue.number}`);
    const refreshedIssue = acceptedIssue ?? actions.refreshIssue(repository, currentIssue.number, currentIssue);
    const leftMilestone = !acceptedIssue && refreshedIssue.milestone !== undefined && refreshedIssue.milestone !== milestone.number;
    if (leftMilestone ||
        (refreshedIssue.state !== 'OPEN' && !hasAcceptedLisaIssueRepair(stateStore?.state, currentIssue))) {
      if (stateStore?.issue?.number === currentIssue.number) {
        if (unpublishedIssueHead(stateStore.issue)) {
          fail(`Issue #${currentIssue.number} покинула очередь. Неопубликованный коммит сохранён в ветке задачи.`);
        }
        if (actions.workingTreeStatus() !== '') {
          fail(
            `Issue #${currentIssue.number} покинула очередь во время работы, но локальный diff не пуст. ` +
              'Ralph остановлен, чтобы не смешать изменения со следующей задачей.',
          );
        }
        if (refreshedIssue.state === 'CLOSED') {
          repairStepSucceeded('close', stateStore.state);
          actions.clearIssueCompletionState(repository, currentIssue);
        }
        stateStore.clearIssue();
      }
      pendingIssues.delete(currentIssue.number);
      completedIssueNumbers.add(currentIssue.number);
      continue;
    }
    if (!acceptedIssue) approveConfiguredIssue(config, refreshedIssue, repository, stateStore);
    currentIssue = refreshedIssue;
    if (localRepository) currentIssue.acceptedRepository = localRepository;
    const storedPhase =
      stateStore?.issue?.number === currentIssue.number ? stateStore.issue.phase : null;
    const linkedCommit = storedPhase ? null : actions.linkedCommitForIssue?.(currentIssue);
    if (linkedCommit) currentIssue.linkedCommit = linkedCommit;
    if (storedPhase === 'review-failed' && hasAcceptedLisaIssueRepair(stateStore?.state, currentIssue)) {
      return { mode: 'run', verdict: 'parked', parkedIssues: [currentIssue.number] };
    }
    const needsDevelopmentIteration =
      !shouldCommitAcceptedRepair(stateStore?.state, currentIssue) &&
      !committedRecoveryPhases.includes(storedPhase) &&
      storedPhase !== 'validation-diagnostic' && !linkedCommit;

    if (needsDevelopmentIteration && iteration >= config.maxIterations) {
      // Запись до остановки: иначе прогон обрывается молча, и в журнале
      // расхода нет строки о том, на какой задаче кончился бюджет.
      actions.beginIssueMetrics?.(issueMetricsContext(config, currentIssue, iteration));
      actions.reportIssueMetrics?.({
        outcome: 'iteration-limit',
        reason: `бюджет ${config.maxIterations} итераций исчерпан до начала задачи`,
      });
      const error = new Error(
        `Достигнут лимит ${config.maxIterations} итераций; ` +
          `осталось открытых issues: ${issues.length}. PR цикл здесь не создаёт и не трогает: ` +
          'он открывается только когда открытых issues не остаётся. Состояние сохранено — ' +
          'увеличьте maxIterations, и следующий --run продолжит с него.',
      );
      error.code = 'RALPH_ITERATION_LIMIT';
      throw error;
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
      reportActivity('issue', `Работа над задачей #${currentIssue.number}`);
      result = await actions.runAgentOnIssue(config, repository, currentIssue, rules);
    } catch (error) {
      if (['push', 'close'].includes(error.ralphFailureStep) &&
          publicationUnavailable(error) &&
          !hasAcceptedLisaIssueRepair(stateStore?.state, currentIssue)) {
        const head = stateStore?.issue?.recoveryHead;
        const step = error.ralphFailureStep;
        const reason = `Issue #${currentIssue.number}: коммит ${head} сохранён локально. ` +
          `Ожидается ${step}: ${error.message}`;
        stateStore?.updateIssue(recordedFailure(error));
        console.error(reason);
        actions.reportIssueMetrics?.({ outcome: 'publication-pending', reason });
        return { mode: 'run', verdict: 'publication-pending', issueNumber: currentIssue.number, head, step };
      }
      actions.reportIssueMetrics?.({
        outcome: error.code ?? 'aborted',
        reason: error.message?.slice(0, 200) ?? null,
      });
      if (
        needsDevelopmentIteration &&
        ['RALPH_AGENT_AUTH', 'RALPH_AGENT_WRITE_ACCESS', 'RALPH_UNTRUSTED_ISSUE', 'RALPH_PROCESS_CONFIG'].includes(
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
    if (result?.parked && (result.publicationBlocked || config.supervisor?.enabled)) {
      return { mode: 'run', verdict: 'parked', parkedIssues: [currentIssue.number] };
    }
    if (result?.parked) {
      parkedIssueNumbers.add(currentIssue.number);
      pendingIssues.delete(currentIssue.number);
    } else if (result?.completed === false) {
      pendingIssues.set(currentIssue.number, currentIssue);
    } else {
      pendingIssues.delete(currentIssue.number);
      completedIssueNumbers.add(currentIssue.number);
      completedInRun.add(currentIssue.number);
    }
    reportQueueProgress(issues.length - (result?.completed === false && !result?.parked ? 0 : 1));
    if (config.stopAfterFirstIssue) {
      if (result?.completed === false) {
        const { reason, runOutcome } = incompleteIssueOutcome(result);
        if (result.parked) {
          console.log(`Issue #${currentIssue.number} отложена: ${reason}. Другую задачу не берём.`);
          return { mode: 'run', completed: 0, ...runOutcome };
        }
        console.log(`Issue #${currentIssue.number} осталась открытой: ${reason}. Продолжаем ту же задачу.`);
        continue;
      }
      stateStore?.finish();
      console.log(`Issue #${currentIssue.number} завершена. Следующую задачу не берём.`);
      return { mode: 'run', completed: 1 };
    }
  }
}

export async function executeMode(context, actions) {
  const { mode: selectedMode, config, repository, milestone, repositoryState } = context;

  if (selectedMode === '--check') {
    let queueError = context.queueError;
    let issues = null;
    if (!queueError) {
      try {
        issues = actions.openIssues(repository, milestone);
      } catch (error) {
        queueError = error.message;
      }
    }
    const budget = iterationBudget(config, context.stateStore);
    actions.printCheck(config, repository, milestone, repositoryState, issues, budget, {
      queueError, publicationStatus: context.publicationStatus, baseError: context.baseError,
    });
    return { mode: 'check', issues: issues?.length ?? null, iterationBudget: budget };
  }

  const deferredPreflight = !context.preflightCompleted && repositoryState?.clean &&
    Boolean(pendingIssuePublication(config, context.stateStore ?? activeStateStore()));
  if (!context.preflightCompleted && !deferredPreflight) actions.runPreflight(config);

  return runContinuousLoop({ ...context, deferredPreflight }, actions);
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
    resumeAcceptedIssue,
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
    if (Number.isInteger(currentConfig.maxIterations)) {
      currentConfig.maxIterations += effectiveLisaIterationReserve(config, stateStore);
    }
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
    reportActivity('phase-transition', `Переход к фазе ${phaseIndex + 2}/${config.phases.length}: ${nextConfig.milestone}`);
    stateStore?.advancePhase(nextConfig);
    console.log(
      `Фаза ${phaseIndex + 1} завершена. Следующая: ${nextConfig.milestone} (${nextConfig.branch}).`,
    );
    phaseIndex = nextConfig.phaseIndex;
  }
}

function publishPhaseConfig(config) {
  const { maxIterations, maxTestFixAttempts, maxReviewFixAttempts } = config;
  publishLiveStatus({
    type: 'phase-config',
    phaseConfig: { maxIterations, maxTestFixAttempts, maxReviewFixAttempts,
      supervisorEnabled: config.supervisor?.enabled ?? false,
      maxSupervisorCalls: config.supervisor?.maxInterventions },
  });
  publishLiveStatus({ type: 'queue-progress', queueProgress: null });
}

async function main(lifecycle = null) {
  const ui = parseUiOption(mode, process.argv.slice(mode === '--accept-manual-commit' ? 4 : 3));
  // Проверяем, что передан поддерживаемый режим запуска.
  if (!supportedModes.has(mode)) {
    fail(`Неизвестный режим ${mode}. Используйте --check, --run или --accept-manual-commit <SHA>.`);
  }

  const config = loadConfig();
  if (lifecycle?.accepted) {
    if (lisaRepairTreeHash({ controlFiles: lifecycle.accepted.controlPlane.trustedControlFileHashes.keys() }) !== lifecycle.accepted.acceptedTreeHash ||
        lisaRepairIndexHash() !== lifecycle.accepted.acceptedIndexHash) {
      fail('Lisa: дерево изменилось перед запуском исправленного Ralph.');
    }
    Object.assign(config, lifecycle.accepted.controlPlane);
    assertTrustedControlFilesUnchanged(config);
  }
  // Диагностика нужна до включения цикла. Изменяющие режимы остаются выключены.
  if (!config.active && mode !== '--check') {
    console.log('Ralph Loop выключен: active=false.');
    return;
  }

  const firstPhaseIndex = initialPhaseIndex(config);
  const firstPhaseConfig = configForPhase(config, firstPhaseIndex);
  resetLiveStatus();
  publishPhaseConfig(firstPhaseConfig);
  const startedMs = Date.now();
  const terminal = !lifecycle && ui === 'split' ? await createTerminalHost({
    snapshot: () => {
      const store = activeStateStore();
      const state = store?.state;
      const issue = store?.issue;
      const metrics = currentIssueMetrics();
      // Экрану не нужны тела issues, одобрения, prompts и телеметрия сессий.
      return {
        store: store ? { phaseIndex: store.phaseIndex, phaseCount: store.phaseCount,
          state: state ? { phaseIndex: state.phaseIndex, milestone: state.milestone, iterationsUsed: state.iterationsUsed,
            supervisorCalls: store.supervisorCalls } : null,
          issue: issue ? { number: issue.number, title: issue.title, phase: issue.phase,
            validationFixAttempts: issue.validationFixAttempts, reviewFixAttempts: issue.reviewFixAttempts } : null } : null,
        metrics: metrics ? { issue: metrics.issue, issueTitle: metrics.issueTitle, startedMs: metrics.startedMs } : null,
        startedMs, live: readLiveStatus(),
      };
    },
  }) : null;
  const unsubscribeTerminal = terminal ? subscribeLiveStatus(() => terminal.refresh()) : () => {};
  const unsubscribeLifecycle = lifecycle ? subscribeLiveStatus((snapshot) => {
    sendRalphWorkerMessage(lifecycle, 'live', { snapshot });
  }) : () => {};
  let restoreConsole;
  let releaseLock;
  let runResult;
  let runError;
  try {
    if (!lifecycle) restoreConsole = initializePersistentLog(runtimeLogPath, {
      mode,
      branch: firstPhaseConfig.branch,
      milestone: firstPhaseConfig.milestone,
      phase: `${firstPhaseIndex + 1}/${config.phases.length}`,
    }, terminal);
    if (!lifecycle) releaseLock = acquireRunLock(runtimeLockPath, {
      mode,
      projectRoot,
      branch: firstPhaseConfig.branch,
    });
    setActiveStateStore(createStateStore(firstPhaseConfig, mode === '--accept-manual-commit' ? '--check' : mode));
    Object.assign(config.approvedIssueSnapshots, activeStateStore().approvedIssueSnapshots);
    reportActivity('startup', 'Проверка инструментов и настроек запуска');
    if (mode === '--accept-manual-commit') {
      const { accepted } = prepareRecovery(firstPhaseConfig, activeStateStore(), mode, {
        hostWorkingTreeHash, manualCommit: process.argv[3] ?? '',
      });
      console.log('Ручной коммит принят. Следующий --run заново выполнит проверки и ревью; задача ещё не завершена.');
      return { mode, accepted };
    }
    const rules = loadRalphRules(config);
    verifyTools(config);
    verifyAgentSkills();
    if (mode === '--run') {
      verifyAgentAuthentication(config);
    }
    for (const phase of config.phases) {
      run('git', ['check-ref-format', '--branch', phase.branch]);
      run('git', ['check-ref-format', '--branch', phase.baseBranch]);
    }
    let githubScope;
    const resolveQueue = (phaseConfig, expectedRepository) => {
      if (!githubScope) {
        reportActivity('startup', 'Проверка доступа к GitHub и фаз проекта');
        run('gh', ['--version']);
        verifyGitHubAuthentication(config);
        const repository = repositoryName();
        let publicationStatus;
        let localRepository;
        if (mode === '--run') {
          localRepository = localGitHubRepository(phaseConfig);
          if (localRepository && localRepository !== repository.toLowerCase()) {
            fail('Локальный origin не соответствует репозиторию GitHub CLI.');
          }
          verifyRepositoryWriteAccess(repository);
        } else {
          try {
            publicationStatus = repositoryPermissions(repository)?.push === true ? 'право записи есть' : 'нет права записи';
          } catch (error) {
            publicationStatus = `право записи не подтверждено (${error.message})`;
          }
        }
        const milestones = verifyMilestones(repository, config.phases.map((phase) => phase.milestone));
        githubScope = { repository, milestones, publicationStatus, localRepository };
      }
      const { repository, milestones, publicationStatus, localRepository } = githubScope;
      if (expectedRepository && repository.toLowerCase() !== expectedRepository.toLowerCase()) {
        fail('Репозиторий очереди GitHub не совпадает с репозиторием принятой задачи.');
      }
      return { repository, milestone: milestones[phaseConfig.phaseIndex], publicationStatus, localRepository };
    };
    const actions = defaultActions();
    const runPhase = async (phaseConfig) => {
      publishPhaseConfig(phaseConfig);
      reportActivity('phase-preparation', `Подготовка ветки фазы: ${phaseConfig.branch}`);
      const { repositoryState } = prepareRecovery(phaseConfig, activeStateStore(), mode, { hostWorkingTreeHash });
      const accepted = mode === '--run' ? resumeAcceptedIssue(phaseConfig, activeStateStore()) : null;
      let online;
      let queueError;
      let baseError;
      if (mode === '--check') {
        try { verifyBaseHistory(phaseConfig, { fetch: false }); } catch (error) { baseError = error.message; }
        try { online = resolveQueue(phaseConfig); } catch (error) { queueError = error.message; }
      } else if (!accepted) {
        online = resolveQueue(phaseConfig);
      }
      // Слияние базы идёт до слепка control plane и после переключения ветки:
      // база может принести правки `.agents/**` или `scripts/ralph/**`, и
      // слепок, снятый до неё, объявил бы их подделкой доверенных файлов.
      const previousHead = run('git', ['rev-parse', 'HEAD']).stdout;
      const syncBase = mode === '--run' && !activeStateStore()?.issue && phaseConfig.syncBaseBranch;
      const mergedBase = syncBase && syncPhaseBranchWithBase(phaseConfig, { fetch: !repositoryState.baseFetched });
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
      if (lifecycle) sendRalphWorkerMessage(lifecycle, 'prepared', { config: phaseConfig, stateRunId: activeStateStore()?.state?.runId });
      if (mergedBase) {
        // HEAD сдвинулся слиянием, а не работой агента: сохранённая база issue
        // обязана переехать вместе с ним, иначе продолжение потребует HEAD,
        // который остался позади.
        applyRecoveryPlan(analyzeRecovery(phaseConfig, activeStateStore()?.issue, { hostWorkingTreeHash }), activeStateStore());
        verifyMergedBase(phaseConfig, previousHead);
      }
      if (mode === '--run') {
        reconcileStateAfterCrash(phaseConfig, activeStateStore());
      }
      if (mode === '--run' && !accepted) verifyBaseHistory(phaseConfig, { fetch: !syncBase && !repositoryState.baseFetched });
      return executeMode(
        {
          mode,
          config: phaseConfig,
          repository: accepted?.acceptedRepository ?? online?.repository,
          milestone: online?.milestone ?? { title: phaseConfig.milestone },
          localRepository: online?.localRepository,
          publicationStatus: online?.publicationStatus ?? (queueError ? 'доступ не подтверждён' : undefined),
          queueError,
          baseError,
          resolveQueue: mode === '--run' ? (expected) => resolveQueue(phaseConfig, expected) : undefined,
          preflightCompleted: Boolean(mergedBase),
          repositoryState,
          rules,
          stateStore: activeStateStore(),
        },
        actions,
      );
    };

    const result = mode === '--run' && !lifecycle
      ? await runWithSupervisor(config, activeStateStore(),
        (effectiveConfig) => runPhasePlan(effectiveConfig, activeStateStore(), runPhase))
      : mode === '--run' ? await runPhasePlan(config, activeStateStore(), runPhase)
        : await runPhase(firstPhaseConfig);
    runResult = result;
    if (result?.verdict === 'needs-human') {
      const error = new Error(`Нужен человек: ${result.reason}`);
      error.code = 'RALPH_NEEDS_HUMAN';
      throw error;
    }
    reportActivity('finished', 'Прогон завершён');
    return result;
  } catch (error) {
    runError = error;
    reportActivity('failed', 'Прогон остановлен с ошибкой');
    console.error(`AFK pipeline error: ${error.message}`);
    throw error;
  } finally {
    try {
      releaseLock?.();
    } finally {
      try {
        restoreConsole?.();
      } finally {
        unsubscribeTerminal();
        unsubscribeLifecycle();
        await terminal?.close();
        if (mode === '--run') {
          console.log(renderRunSummary({ result: runResult, error: runError, startedMs,
            endedMs: Date.now(), phaseCount: config.phases.length, logPath: runtimeLogPath }));
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Точка входа: выполняется только при прямом запуске файла через node
// -----------------------------------------------------------------------------

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

export async function runCli() {
  let lifecycle;
  try {
    lifecycle = await receiveRalphWorkerStart({ lockPath: runtimeLockPath });
    const result = mode === '--run' && !lifecycle ? await runRalphLifecycleCli() : await main(lifecycle);
    if (lifecycle) sendRalphWorkerMessage(lifecycle, 'outcome', { outcome: ralphRunOutcome(result) });
  } catch (error) {
    if (lifecycle) sendRalphWorkerMessage(lifecycle, 'outcome', { outcome: ralphRunOutcome(null, error) });
    console.error(`\nRalph Loop остановлен: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (lifecycle) lifecycle.finished = true;
    if (process.send && process.connected) process.disconnect();
  }
}

if (isMainModule) {
  await runCli();
}
