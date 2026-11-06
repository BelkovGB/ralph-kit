import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile, removeFileIfExists, writeJsonAtomic, writeTextAtomic } from './ralph-runtime.mjs';
import { KIT_VERSION } from './ralph-version.mjs';

const reportDirectory = 'run-stop-reports';
const latestReportFile = 'run-stop-report.json';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const missing = 'нет данных';
const lisaStatuses = new Set(['repairing', 'checking', 'accepted', 'resuming', 'needs-human']);
const steps = new Set(['development', 'validation', 'push', 'review', 'close', 'pull-request', 'review-failed', 'phase']);
const stopReasons = new Map([
  ['repeat-without-progress', 'Повтор прежнего отказа без подтверждения восстановленного шага.'],
  ['lisa-unavailable', 'Lisa выключена, контекст недоступен или исчерпан лимит вызовов.'],
  ['lisa-iteration-reserve-exhausted', 'Исчерпан резерв дополнительных итераций Lisa.'],
  ['lisa-repair-declined', 'Lisa не предложила ремонт, который Ralph мог принять.'],
]);

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : missing;
const id = (value, pattern) => typeof value === 'string' && pattern.test(value) ? `\`${value}\`` : missing;
const known = (value, options) => options.has(value) ? `\`${value}\`` : missing;
const yesNo = (value) => typeof value === 'boolean' ? (value ? 'да' : 'нет') : missing;

export function parkedReviewPhase(workerOutcome) {
  const phases = workerOutcome?.result?.phases;
  if (workerOutcome?.failure?.code !== 'RALPH_PARKED' || !Array.isArray(phases)) return null;
  const phase = phases.at(-1);
  if (phase?.verdict !== 'parked' || !Number.isSafeInteger(phase.phaseIndex) || phase.phaseIndex < 0 ||
      !Array.isArray(phase.parkedIssues)) return null;
  const parkedIssues = phase.parkedIssues.filter((number) => Number.isSafeInteger(number) && number > 0);
  if (!parkedIssues.length) return null;
  return { phaseIndex: phase.phaseIndex, parkedIssues, iterations: phase.iterations,
    pullRequestNumber: phase.pullRequest?.number, pullRequestHead: phase.pullRequest?.headRefOid };
}

function issueHistory(workers, runId, phase) {
  const rows = [];
  let lastReview = null;
  let validationFailures = 0;
  for (const [index, worker] of workers.entries()) {
    const parked = worker.parked?.phaseIndex === phase.phaseIndex ? worker.parked.parkedIssues : [];
    const reviews = new Map();
    for (const event of worker.observations) {
      if (event.runId !== runId || event.phaseIndex !== phase.phaseIndex || !phase.parkedIssues.includes(event.issueNumber)) continue;
      if (event.kind === 'validation-fail') validationFailures += 1;
      if (event.kind !== 'review-fail' || count(event.findings) === missing) continue;
      lastReview = event;
      const findings = reviews.get(event.issueNumber) ?? [];
      findings.push(event.findings);
      reviews.set(event.issueNumber, findings);
    }
    for (const number of phase.parkedIssues) {
      const findings = reviews.get(number);
      if (!findings && !parked.includes(number)) continue;
      rows.push(`| ${index + 1} | ${phase.phaseIndex + 1} | #${number} | ${findings?.join(' → ') ?? missing} | ${yesNo(parked.includes(number))} |`);
    }
  }
  return { rows, lastReview, validationFailures: lastReview ? validationFailures : missing };
}

function renderReport({ runId, startedAt, stoppedAt, durationMs, phase, limits, workers, state,
  initialIterations, repair, lisaCallsThisRun, stopReason }) {
  const { rows, lastReview, validationFailures } = issueHistory(workers, runId, phase);
  const saved = state?.runId === runId ? state : null;
  const phaseState = saved?.phaseIndex === phase.phaseIndex ? saved : null;
  const issue = phase.parkedIssues.includes(phaseState?.issue?.number) ? phaseState.issue : null;
  const iterationsUsed = count(phaseState?.iterationsUsed ?? phase.iterations);
  const iterationsBefore = initialIterations?.phaseIndex < phase.phaseIndex ? 0 : count(initialIterations?.used);
  const iterationsThisRun = iterationsUsed === missing || iterationsBefore === missing
    ? missing : count(iterationsUsed - iterationsBefore);
  const lastStep = workers.at(-1)?.lastPassedStep;
  const step = lastStep?.runId === runId && lastStep.phaseIndex === phase.phaseIndex &&
    (lastStep.issueNumber === null || phase.parkedIssues.includes(lastStep.issueNumber)) ? lastStep.step : null;
  const lisa = repair?.runId === runId ? repair : null;
  const lisaPhase = lisa ? count(lisa.phaseIndex + 1) : missing;
  const lisaIssue = count(lisa?.issueNumber);
  const pullRequest = phase.pullRequestNumber;
  return `# Ralph Kit — отчёт об остановке

- ID прогона — ${id(runId, uuid)}
- Версия Ralph Kit — \`${KIT_VERSION}\`
- SHA набора — ${missing}
- Начало UTC — ${startedAt.toISOString()}
- Остановка UTC — ${stoppedAt.toISOString()}
- Длительность — ${durationMs} мс
- Фаза — ${phase.phaseIndex + 1} из ${count(limits.phaseCount)}
- Отложенные задачи — ${phase.parkedIssues.map((number) => `#${number}`).join(', ')}
- Итог \`--run\` — \`needs-human\`, код выхода \`1\`
- Причина — \`RALPH_PARKED\`. ${stopReasons.get(stopReason) ?? missing}
- Сохранённый \`state.status\` — ${saved?.status === 'active' ? '\`active\`' : missing}
- Этап сохранённой задачи — ${issue?.phase === 'review-failed' ? '\`review-failed\`' : missing}
- Итерации фазы за этот запуск — ${iterationsThisRun}. Из бюджета фазы — ${iterationsUsed}. Базовый лимит — ${count(limits.maxIterations)}
- Отказы тестов по отложенным задачам за запуск — ${validationFailures}. Лимит подряд на задачу — ${count(limits.maxTestFixAttempts)}
- Лимит отказов ревью подряд на задачу — ${count(limits.maxReviewFixAttempts)}
- Вызовы Lisa за этот запуск — ${count(lisaCallsThisRun)}. Из бюджета фазы — ${count(phaseState?.supervisorCalls)} из ${count(limits.supervisor?.maxInterventions)}
- Дополнительные итерации, выделенные Lisa в этой фазе — ${count(phaseState?.supervisorExtraIterations)} из ${count(limits.supervisor?.maxAdditionalIterations)}
- Сохранённый статус Lisa — ${known(saved?.lisaRepair?.status, lisaStatuses)}
- Последний ремонт Lisa — фаза ${lisaPhase}, задача ${lisaIssue === missing ? missing : `#${lisaIssue}`}
- Ремонт Lisa принят — ${yesNo(lisa?.accepted)}. Worker после ремонта запущен — ${yesNo(lisa?.restarted)}
- Шаг отказа — ${known(lisa?.failureStep, steps)}. Восстановление шага подтверждено — ${yesNo(lisa?.proved)}
- Последний выполненный шаг — ${known(step, steps)}. Выполненное ревью может вернуть FAIL.
- Проверенный коммит задачи — ${id(lastReview?.commit, sha)}
- Подтверждённый HEAD ветки при отправке коммита — ${id(lastReview?.pushedHead, sha)}
- Задачи оставлены открытыми при парковке.
- PR по данным фазы — ${count(pullRequest) === missing ? missing : `#${pullRequest}`}. HEAD PR — ${id(phase.pullRequestHead, sha)}
- Действие владельца — разобрать оставшиеся замечания в задачах и проверить сохранённое состояние перед повторным запуском.

## Отказы продуктового ревью по отложенным задачам

| Worker | Фаза | Задача | Замечаний при FAIL по попыткам | Парковка |
| --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

export function writeRunStopReport(runtime, details) {
  const name = `${randomUUID()}.md`;
  const directory = path.join(runtime, reportDirectory);
  mkdirSync(directory, { recursive: true });
  if (!lstatSync(directory).isDirectory()) throw new Error('Ralph requires a local report directory.');
  const filePath = path.join(directory, name);
  writeTextAtomic(filePath, renderReport(details));
  try {
    writeJsonAtomic(path.join(runtime, latestReportFile), { name });
    return { filePath, shownInGui: true };
  } catch {
    return { filePath, shownInGui: false };
  }
}

export function clearLatestRunStopReport(runtime) {
  removeFileIfExists(path.join(runtime, latestReportFile));
}

export function readLatestRunStopReportPath(runtime) {
  try {
    const name = readJsonFile(path.join(runtime, latestReportFile))?.name;
    if (typeof name !== 'string' || !name.endsWith('.md') || !uuid.test(name.slice(0, -3))) return null;
    const directory = path.join(runtime, reportDirectory);
    if (!lstatSync(directory).isDirectory()) return null;
    const filePath = path.join(directory, name);
    return lstatSync(filePath).isFile() ? filePath : null;
  } catch {
    return null;
  }
}
