import { runDevelopmentSession, verifyAgentAuthentication } from './ralph-agent-backends.mjs';
import { publishLiveStatus, reportActivity } from './ralph-live-status.mjs';
import { assertTrustedControlFilesUnchanged } from './ralph-validation-runner.mjs';
import { run } from './ralph-process-runner.mjs';
import { analyzeRecovery, committedRecoveryPhases } from './ralph-recovery.mjs';
import { isAncestorCommit } from './ralph-git.mjs';
import { beginIssueMetrics, currentIssueMetrics, finishIssueMetrics,
  formatIssueMetrics, startStage } from './ralph-run-metrics.mjs';

const humanOnlyCodes = new Set([
  'RALPH_AGENT_AUTH',
  'RALPH_AGENT_WRITE_ACCESS',
  'RALPH_UNTRUSTED_ISSUE',
  'RALPH_CONTROL_PLANE_CHANGED',
  'RALPH_RECOVERY_BLOCKED',
]);

export function supervisorPrompt(config, state, error, call) {
  const issue = state?.issue;
  const failure = error?.message ?? 'Задача отложена после повторных отказов ревью.';
  return [
    'Ты Lisa, супервизор Ralph Loop. Разбери остановку и помоги Ralph продолжить текущую задачу.',
    `Вызов ${call}. Ветка: ${config.branch}. Milestone: ${config.milestone}.`,
    `Issue: ${issue ? `#${issue.number} «${issue.title ?? ''}», этап ${issue.phase}` : 'нет сохранённой issue'}.`,
    `Причина остановки: ${failure}`,
    `Последняя ошибка issue: ${issue?.lastFailureSummary
      ? JSON.stringify(issue.lastFailureSummary)
      : issue?.lastFailure ?? 'нет'}`,
    issue?.reviewFindings ? `Замечания ревью: ${issue.reviewFindings}` : '',
    `Правила Ralph: ${config.rulesFile ?? '.agents/ralph-rules.md'}. Прочитай их и AGENTS.md.`,
    issue?.body ? `Сохранённый текст задачи:\n${issue.body}` : '',
    'Проверь git status, сохранённое состояние и журнал Ralph. Исправь причину остановки в пределах текущей задачи.',
    'Перед resume проверь итоговый diff, выполни релевантные проверки и убедись, что ветка и HEAD прежние, чужая работа сохранена, а изменения относятся к текущей задаче. Не объявляй готовность только по факту правки файла.',
    'Разрешено найти уже установленные инструменты, использовать их абсолютные пути или добавить их каталог в PATH только своего проверочного процесса и повторить диагностику. Изменение PATH дочерней команды не переносится в будущие проверки Ralph: проверь их штатное окружение; если для него требуется изменение конфигурации, запроси оператора.',
    'Установка ПО, постоянное изменение окружения и исправления вне текущей задачи требуют отдельного разрешения оператора. Не меняй системную защиту или доступы.',
    'Не редактируй state.json и локи. После resume оркестратор сам проверит восстановление и согласует этап с рабочим деревом, отменит устаревшие результаты проверок и ревью. При небезопасном состоянии он сохранит работу и запросит человека.',
    'Не меняй цель задачи и критерии приёмки, не отключай проверки и не меняй лимиты, настройки Ralph или доверенные инструкции.',
    'Не удаляй незавершённую работу, не создавай commit и не переключай ветку. Не запускай второй Ralph Loop: оболочка продолжит его после твоего ответа.',
    'Если нужен доступ, согласование, решение за пределами задачи или безопасное исправление невозможно, запроси человека.',
    'Последним сообщением верни только JSON: {"verdict":"resume"|"human","reason":"краткая причина"}.',
  ].filter(Boolean).join('\n\n');
}

export function supervisorAgentConfig(config) {
  return {
    ...config,
    agentCli: config.supervisor.agentCli ?? 'codex',
    developmentModel: config.supervisor.model,
    developmentEffort: config.supervisor.effort,
  };
}

export function supervisorPhaseConfig(config, store) {
  return {
    ...config,
    branch: store?.state?.branch ?? config.branch,
    baseBranch: store?.state?.baseBranch ?? config.baseBranch,
    milestone: store?.state?.milestone ?? config.milestone,
  };
}

export function effectiveLisaIterationReserve(config, store) {
  if (!config.supervisor?.enabled) return 0;
  return Math.min(store?.supervisorExtraIterations ?? 0,
    config.supervisor.maxAdditionalIterations);
}

function workspaceIdentity(execute = run) {
  return {
    branch: execute('git', ['branch', '--show-current']).stdout,
    head: execute('git', ['rev-parse', 'HEAD']).stdout,
  };
}

/** Validate the next recovery before persisting a supervisor's uncommitted fix. */
export function prepareLisaResume(config, store, before, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const after = workspaceIdentity(execute);
  assertLisaWorkspaceUnchanged(before, after);
  const status = execute('git', ['status', '--porcelain']).stdout;
  const issue = store.issue;
  if (!status) return analyzeRecovery(config, issue, { run: execute });
  const allowed = new Set(['review-failed', 'committed', 'pushed', 'reviewing',
    'closing', 'agent-running', 'working-tree', 'validating']);
  if (!issue || !allowed.has(issue.phase)) {
    throw new Error('Lisa: рабочее дерево требует ручного восстановления исходного этапа.');
  }
  const committed = committedRecoveryPhases.includes(issue.phase);
  const expectedHead = committed
    ? issue.recoveryHead ?? issue.pushedHead ?? issue.commit : issue.startingCommit;
  if (after.head !== expectedHead || (committed &&
      (!issue.commit || !isAncestorCommit(issue.commit, after.head, execute)))) {
    throw new Error('Lisa: HEAD не соответствует сохранённой задаче; нужен оператор.');
  }
  const patch = {
    phase: 'working-tree', startingCommit: after.head,
    commit: null, recoveryHead: null, pushedHead: null, reviewedCommit: null,
    expectedTree: null, commitMessage: null,
    validationExpectedTreeHash: null, validationFailureFingerprint: null,
    ...(issue.phase === 'review-failed' ? { reviewFixAttempts: 0 } : {}),
  };
  const plan = analyzeRecovery(config, { ...issue, ...patch }, { run: execute });
  store.updateIssue(patch);
  return plan;
}

export function assertLisaWorkspaceUnchanged(before, after) {
  if (before.branch !== after.branch || before.head !== after.head) {
    throw new Error('Lisa изменила ветку или HEAD. Продолжение требует разбора человеком.');
  }
}

function parseLisaAnswer(message) {
  let answer;
  try {
    answer = JSON.parse(message);
  } catch {
    return { verdict: 'human', reason: 'Lisa не вернула решение в формате JSON.' };
  }
  if (!['resume', 'human'].includes(answer?.verdict) ||
      typeof answer.reason !== 'string' || answer.reason.trim() === '') {
    return { verdict: 'human', reason: 'Lisa вернула неполное решение.' };
  }
  return answer;
}

export async function requestLisa(config, store, error, call) {
  const lisaConfig = supervisorAgentConfig(config);
  const before = workspaceIdentity();
  if (currentIssueMetrics()) {
    finishIssueMetrics({ outcome: error.code ?? 'aborted', reason: error.message });
  }
  beginIssueMetrics({
    issue: store.issue?.number ?? null,
    issueTitle: store.issue?.title ?? null,
    milestone: config.milestone,
    branch: config.branch,
    iteration: null,
    agentCli: lisaConfig.agentCli,
  });
  const endStage = startStage('supervisor');
  let outcome = { outcome: 'supervisor-failed', reason: 'сессия не завершилась' };
  try {
    verifyAgentAuthentication(lisaConfig);
    const session = await runDevelopmentSession(lisaConfig, {
      input: supervisorPrompt(config, store.state, error, call),
      progressLabel: 'Lisa',
      maxTurns: config.supervisor.maxTurns,
      timeoutMs: config.supervisor.timeoutMs,
      label: `Lisa: помощь Ralph${store.issue ? ` с issue #${store.issue.number}` : ''}`,
    }, 'supervisor');
    assertTrustedControlFilesUnchanged(config);
    assertLisaWorkspaceUnchanged(before, workspaceIdentity());
    const answer = parseLisaAnswer(session.lastAgentMessage);
    if (answer.verdict === 'resume') {
      try {
        prepareLisaResume(config, store, before);
      } catch (cause) {
        answer.verdict = 'human';
        answer.reason = `Lisa: продолжение не подготовлено; работа сохранена. ${cause.message}`;
      }
    }
    outcome = { outcome: `supervisor-${answer.verdict}`, reason: answer.reason };
    return answer;
  } catch (cause) {
    outcome = { outcome: 'supervisor-failed', reason: cause.message };
    throw cause;
  } finally {
    endStage();
    const record = finishIssueMetrics(outcome);
    if (record) console.log(formatIssueMetrics(record));
  }
}

export async function runWithSupervisor(config, store, runPlan, request = requestLisa) {
  while (true) {
    let result;
    let failure;
    try {
      result = await runPlan(config);
      if (result?.verdict !== 'parked') return result;
      const parkedIssues = result.phases?.at(-1)?.parkedIssues ?? result.parkedIssues;
      failure = new Error(`Отложены issues: ${parkedIssues?.join(', ') ?? 'неизвестно'}`);
    } catch (error) {
      failure = error;
    }

    if (!config.supervisor?.enabled || !store || humanOnlyCodes.has(failure.code) ||
        store.supervisorCalls >= config.supervisor.maxInterventions) {
      throw failure;
    }
    if (store.supervisorExtraIterations >= config.supervisor.maxAdditionalIterations &&
        (failure.code === 'RALPH_ITERATION_LIMIT' || result?.verdict === 'parked')) {
      throw failure;
    }

    const call = store.reserveSupervisorCall();
    publishLiveStatus({ type: 'supervisor-call' });
    const label = `Lisa: вызов ${call}/${config.supervisor.maxInterventions}.` +
      (store.issue ? ` Issue #${store.issue.number}` : '');
    reportActivity('supervisor', label);
    let answer;
    try {
      answer = await request(supervisorPhaseConfig(config, store), store, failure, call);
    } catch (error) {
      return { verdict: 'needs-human', reason: `Lisa остановилась: ${error.message}` };
    } finally {
      console.log(`Lisa: вызов ${call} завершён.`);
      store.finishSupervisorCall();
      publishLiveStatus({ type: 'activity', kind: 'supervisor', label, active: false });
    }
    if (answer?.verdict !== 'resume') {
      return { verdict: 'needs-human', reason: answer?.reason ?? 'Lisa не разрешила продолжение.' };
    }
    if (result?.verdict === 'parked' && store.issue) {
      store.updateIssue({ phase: 'working-tree', reviewFixAttempts: 0 });
    }
    if (store.supervisorExtraIterations < config.supervisor.maxAdditionalIterations) {
      store.grantSupervisorIteration();
    }
    console.log(`Lisa: ${answer.reason}. Ralph продолжает работу.`);
  }
}
