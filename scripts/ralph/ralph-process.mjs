// Подтверждённые переходы процесса. Эти данные не участвуют в принятии решений.
const phaseStages = {
  'agent-running': 'implementation', 'working-tree': 'implementation',
  validating: 'validation', 'validation-mutated': 'validation', 'validation-diagnostic': 'validation',
  staging: 'publishing', committing: 'publishing', committed: 'publishing', pushed: 'publishing',
  reviewing: 'review', 'review-failed': 'fixing', closing: 'publishing',
};

export function createIssueProcess({ partial = false } = {}) {
  return { version: 1, current: null, completed: [], failed: null, correctionSource: null,
    reviewRound: partial ? null : 0, reviews: [], partial, activeReview: false };
}

export function updateIssueProcess(previous, event) {
  const process = previous?.version === 1 ? structuredClone(previous) : createIssueProcess({ partial: true });
  const complete = (stage) => {
    if (!process.completed.includes(stage)) process.completed.push(stage);
  };
  switch (event.type) {
    case 'stage-start':
      process.current = event.stage === 'implementation' && process.correctionSource
        ? 'fixing' : event.stage;
      process.completed = process.completed.filter(stage => {
        if (event.stage === 'implementation') return false;
        if (event.stage === 'validation') return stage === 'implementation';
        return stage !== event.stage && stage !== 'done';
      });
      if (process.failed === event.stage) process.failed = null;
      break;
    case 'stage-complete':
      complete(event.stage);
      if (event.stage === 'validation' && process.correctionSource === 'validation') process.correctionSource = null;
      if (event.stage === 'done') {
        process.current = 'done';
        process.failed = null;
        process.correctionSource = null;
      }
      if (process.failed === event.stage) process.failed = null;
      break;
    case 'stage-error':
      process.failed = event.stage;
      process.current = event.stage;
      break;
    case 'stage-fail':
      process.failed = event.stage;
      if (event.stage === 'validation' && process.correctionSource !== 'review') process.correctionSource = 'validation';
      process.completed = process.completed.filter(stage => stage !== event.stage);
      process.current = event.stage === 'validation' ? 'fixing' : event.stage;
      break;
    case 'review-start':
      // Незавершённый круг продолжается после технического отказа или рестарта.
      if (!process.activeReview && process.reviewRound !== null) process.reviewRound += 1;
      process.activeReview = true;
      process.current = 'review';
      process.failed = null;
      process.completed = process.completed.filter(stage => stage !== 'review' && stage !== 'done');
      break;
    case 'review-result':
      process.reviews.push({ round: process.reviewRound, verdict: event.verdict,
        findings: Number.isInteger(event.findings) && event.findings >= 0 ? event.findings : null });
      process.activeReview = false;
      process.failed = event.verdict === 'pass' ? null : 'review';
      process.correctionSource = event.verdict === 'pass' ? null : 'review';
      process.current = event.verdict === 'pass' ? 'publishing' : 'fixing';
      if (event.verdict === 'pass') complete('review');
      break;
    case 'review-error':
      process.current = 'review';
      process.failed = 'review';
      break;
    default:
      throw new Error(`Unknown process event: ${event.type}`);
  }
  return process;
}

export function issueProcessSnapshot(issue, { reviewEnabled = true } = {}) {
  if (!issue) return null;
  const process = issue.process?.version === 1 ? issue.process : null;
  return {
    current: process?.current ?? phaseStages[issue.phase] ?? null,
    completed: [...(process?.completed ?? [])],
    failed: process?.failed ?? null,
    correctionSource: process?.correctionSource ?? null,
    reviewRound: process?.reviewRound > 0 ? process.reviewRound : null,
    reviews: (process?.reviews ?? []).map(review => ({ ...review })),
    partial: process?.partial ?? true,
    reviewEnabled,
  };
}

export function phaseProcessSnapshot(state, options = {}) {
  if (!state) return null;
  return { ...issueProcessSnapshot({ process: state.phaseProcess }, options), scope: 'phase' };
}
