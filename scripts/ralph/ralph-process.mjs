// Подтверждённые переходы процесса. Эти данные не участвуют в принятии решений.
const phaseStages = {
  'agent-running': 'implementation', 'working-tree': 'implementation',
  validating: 'validation', 'validation-mutated': 'validation', 'validation-diagnostic': 'validation',
  staging: 'publishing', committing: 'publishing', committed: 'publishing', pushed: 'publishing',
  reviewing: 'review', 'review-failed': 'fixing', closing: 'publishing',
};

const timedStages = ['implementation', 'validation', 'review', 'fixing', 'publishing'];
const unknownStageMs = () => Object.fromEntries(timedStages.map(stage => [stage, null]));

export function createIssueProcess({ partial = false } = {}) {
  return { version: 1, current: null, completed: [], failed: null, errorStage: null, correctionSource: null,
    reviewRound: partial ? null : 0, reviews: [], partial, activeReview: false,
    stageMs: unknownStageMs(), timingPartial: partial, activeTiming: null };
}

export function addStageTimes(left, right) {
  return Object.fromEntries(timedStages.map(stage => {
    const a = left?.[stage];
    const b = right?.[stage];
    const times = [a, b].filter(Number.isFinite);
    return [stage, times.length ? times.reduce((sum, value) => sum + value, 0) : null];
  }));
}

export function updateIssueProcess(previous, event) {
  const process = previous?.version === 1 ? structuredClone(previous) : createIssueProcess({ partial: true });
  process.timingPartial ??= !process.stageMs;
  process.stageMs ??= unknownStageMs();
  if (process.activeTiming) {
    const { stage, startedMs } = process.activeTiming;
    if (Number.isFinite(event.atMs) && event.atMs >= startedMs) {
      process.stageMs[stage] = (process.stageMs[stage] ?? 0) + event.atMs - startedMs;
    } else process.timingPartial = true;
    process.activeTiming = null;
  }
  if (event.identity) process.timingIdentity = { ...event.identity };
  const complete = (stage) => {
    if (!process.completed.includes(stage)) process.completed.push(stage);
  };
  switch (event.type) {
    case 'stage-start':
      process.current = event.stage === 'implementation' && process.correctionSource
        ? 'fixing' : event.stage;
      if (event.scope === 'phase' && event.stage === 'validation') {
        process.failed = null;
        process.errorStage = null;
        process.correctionSource = null;
      }
      process.completed = process.completed.filter(stage => {
        if (event.scope === 'phase' && event.stage === 'validation') {
          return !['validation', 'publishing', 'review', 'done'].includes(stage);
        }
        if (event.stage === 'implementation') return false;
        if (event.stage === 'validation') return stage === 'implementation' || stage === 'fixing';
        return stage !== event.stage && stage !== 'done';
      });
      if (process.failed === event.stage) process.failed = null;
      if (process.errorStage === event.stage) process.errorStage = null;
      break;
    case 'stage-complete':
      if (event.stage === 'implementation' && process.current === 'fixing') complete('fixing');
      complete(event.stage);
      if (event.stage === 'validation' && process.correctionSource === 'validation') process.correctionSource = null;
      if (event.stage === 'done') {
        process.current = 'done';
        process.failed = null;
        process.correctionSource = null;
      }
      if (process.failed === event.stage) process.failed = null;
      if (process.errorStage === event.stage || event.stage === 'done') process.errorStage = null;
      break;
    case 'stage-error':
      process.errorStage = event.stage;
      process.failed = event.stage;
      process.current = event.stage;
      break;
    case 'stage-fail':
      process.failed = event.stage;
      if (event.stage === 'validation' && process.correctionSource !== 'review') process.correctionSource = 'validation';
      process.completed = process.completed.filter(stage => stage !== event.stage &&
        (event.stage !== 'validation' || stage !== 'fixing'));
      process.current = event.stage === 'validation' ? 'fixing' : event.stage;
      break;
    case 'review-start':
      if (process.errorStage === 'review') process.errorStage = null;
      // Незавершённый круг продолжается после технического отказа или рестарта.
      if (!process.activeReview && process.reviewRound !== null) process.reviewRound += 1;
      process.activeReview = true;
      process.current = 'review';
      process.failed = null;
      process.completed = process.completed.filter(stage => stage !== 'review' && stage !== 'done');
      break;
    case 'review-result':
      process.errorStage = null;
      process.reviews.push({ round: process.reviewRound, verdict: event.verdict,
        findings: Number.isInteger(event.findings) && event.findings >= 0 ? event.findings : null });
      process.activeReview = false;
      process.failed = event.verdict === 'pass' ? null : 'review';
      process.correctionSource = event.verdict === 'pass' ? null : 'review';
      process.current = event.verdict === 'pass' ? 'publishing' : 'fixing';
      if (event.verdict === 'pass') complete('review');
      else process.completed = process.completed.filter(stage => stage !== 'fixing');
      break;
    case 'review-error':
      process.errorStage = 'review';
      process.current = 'review';
      process.failed = 'review';
      break;
    default:
      throw new Error(`Unknown process event: ${event.type}`);
  }
  const startedStage = event.type === 'review-start' ? 'review'
    : event.type === 'stage-start' ? process.current : null;
  if (timedStages.includes(startedStage) && Number.isFinite(event.atMs)) {
    process.activeTiming = { stage: startedStage, startedMs: event.atMs };
  }
  return process;
}

export function issueProcessSnapshot(issue, { reviewEnabled = true, timing = null, now = Date.now(),
  scope = 'issue', identity = null } = {}) {
  if (!issue) return null;
  const process = issue.process?.version === 1 ? issue.process : null;
  const stageMs = { ...unknownStageMs(), ...process?.stageMs };
  const expected = identity ?? process?.timingIdentity;
  const sameOwner = timing && expected && expected.scope === scope && expected.issueNumber === (issue.number ?? null)
    && ['scope', 'runId', 'phaseIndex', 'issueNumber', 'ownerId'].every(key => timing[key] === expected[key]);
  const active = process?.activeTiming;
  const currentTiming = sameOwner && active && active.stage === timing.stage && active.startedMs === timing.startedMs
    && Number.isFinite(now) && now >= active.startedMs;
  if (currentTiming) stageMs[active.stage] = (stageMs[active.stage] ?? 0) + now - active.startedMs;
  return {
    current: process?.current ?? phaseStages[issue.phase] ?? null,
    completed: [...(process?.completed ?? [])],
    failed: process?.failed ?? null,
    errorStage: process?.errorStage ?? null,
    operation: issue.phase ?? null,
    correctionSource: process?.correctionSource ?? null,
    reviewRound: process?.reviewRound > 0 ? process.reviewRound : null,
    reviews: (process?.reviews ?? []).map(review => ({ ...review })),
    partial: process?.partial ?? true,
    reviewEnabled,
    stageMs,
    timingPartial: (process?.timingPartial ?? !process?.stageMs) || Boolean(active && !currentTiming),
  };
}

export function phaseProcessSnapshot(state, options = {}) {
  if (!state) return null;
  const identity = state.phaseProcess?.timingIdentity;
  const timing = identity?.runId === state.runId && identity?.phaseIndex === state.phaseIndex ? options.timing : null;
  const process = issueProcessSnapshot({ process: state.phaseProcess, phase: options.operation ?? null },
    { ...options, timing, scope: 'phase', identity });
  return { ...process, scope: 'phase',
    stageMs: addStageTimes(state.phaseTaskStageMs, process.stageMs),
    timingPartial: process.timingPartial || Boolean(state.phaseTaskTimingPartial) };
}
