import { failedTests } from './ralph-issue-recheck.mjs';
import { reviewFindingKeys } from './ralph-review-recurrence.mjs';

// Playwright reports the declaration location; a preceding edit can move it.
// Keep the original selector for command arguments and diagnostics.
function validationIdentity(name) {
  const match = /^(?:\[([^\]\r\n›]+)\] › )?((?:[A-Za-z]:[/\\])?[^:\r\n›]+[.]spec[.][cm]?[jt]sx?):[1-9]\d*:\d+ › (.+)$/u.exec(name);
  return match ? JSON.stringify([match[1] ?? '', match[2].replaceAll('\\', '/'), match[3]]) : JSON.stringify(name);
}

function matchingBlockers(previous, current) {
  if (!current || previous?.kind !== current.kind) return [];
  if (current.kind !== 'validation') return current.keys.filter(key => previous.keys.includes(key));
  const previousIds = new Set(previous.keys.map(validationIdentity));
  return current.keys.filter(key => previousIds.has(validationIdentity(key)));
}

// Capture the evidence the developer actually receives before beginIssue changes phase.
export function developmentFeedback(issue) {
  if (!issue) return null;
  const keys = issue.validationFailureFingerprint && failedTests(issue.lastFailureSummary);
  if (keys?.length) return { kind: 'validation', keys };
  if (['review-failed', 'agent-running'].includes(issue.phase) && issue.reviewReceipt?.head === issue.reviewedCommit) {
    const findings = reviewFindingKeys(issue.reviewReceipt?.result);
    if (findings.length) return { kind: 'review', keys: findings };
  }
  return null;
}

// The stop decision takes precedence over remaining budget. A previously spent
// attempt stays spent even if the issue was cleared, reopened, or changed HEAD.
export function developmentRetryDecision(config, store, blockers, hasFixBudget) {
  const effort = config.developmentEscalation?.effort;
  if (!effort || !blockers?.keys.length || !store?.issue || !store.reserveDevelopmentEscalation) return {};
  const spent = store.state.developmentEscalations?.[store.issue.number];
  if (spent) {
    const [key] = matchingBlockers(spent, blockers);
    return key ? { stop: true, key } : {};
  }
  const addressed = store.issue.addressedDevelopmentFeedback;
  if (!hasFixBudget || store.iterationsUsed >= config.maxIterations || addressed?.kind !== blockers.kind) return {};
  const keys = matchingBlockers(addressed, blockers);
  return keys.length ? { pending: { kind: blockers.kind, keys, effort } } : {};
}

export function developmentSessionConfig(config, store, feedback) {
  const pending = store?.issue?.pendingDevelopmentEscalation;
  if (!pending) return config;
  const budgetSpent = pending.kind === 'review'
    ? store.issue.reviewFixAttempts >= config.maxReviewFixAttempts
    : store.issue.validationFixAttempts >= config.maxTestFixAttempts;
  if (budgetSpent || !config.developmentEscalation || pending.effort !== config.developmentEscalation.effort ||
      !matchingBlockers(pending, feedback).length) {
    store.updateIssue({ pendingDevelopmentEscalation: null });
    return config;
  }
  if (!store.reserveDevelopmentEscalation()) return config;
  console.log(`Issue #${store.issue.number}: одна попытка разработчика с effort=${pending.effort} после повторного отказа (${pending.kind}).`);
  return { ...config, developmentEffort: pending.effort };
}
