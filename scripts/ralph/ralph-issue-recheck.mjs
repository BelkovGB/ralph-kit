import { summarizeCommandFailure } from './ralph-failure-summary.mjs';
import { runConfiguredScripts } from './ralph-validation-runner.mjs';

// Test names come from command output. Only trusted, configured commands may
// run them, as JSON data. A successful diagnostic never satisfies validation.
function failedTests(summary) {
  if (summary?.code !== 'RALPH_VALIDATION_FAILED' || !Array.isArray(summary.failedTests)) return [];
  const tests = summary.failedTests;
  if (!tests.length || tests.length > 10 || !tests.every(test => typeof test === 'string' && test.trim()) ||
      JSON.stringify(tests).length > 8192) return [];
  return tests;
}

export function validateIssueAttempt(config, options, savedIssue, fingerprint, validate, runScripts = runConfiguredScripts) {
  const previousInput = savedIssue?.validationFailureFingerprint;
  const previousTests = failedTests(savedIssue?.lastFailureSummary);
  try {
    if (previousInput && previousTests.length && config.validationProfiles?.issueRecheck) {
      runScripts(config, config.validationProfiles.issueRecheck, 'Issue recheck', {
        ...options, skipPreflight: true, failedTests: previousTests,
      });
    }
    return validate();
  } catch (error) {
    if (error.code !== 'RALPH_VALIDATION_FAILED') throw error;
    const currentTests = failedTests(summarizeCommandFailure(error));
    if (!currentTests.length) throw error;
    const input = fingerprint();
    error.validationFailureFingerprint = input;
    const repeatedTest = currentTests.find(test => previousTests.includes(test));
    if (input && input === previousInput && repeatedTest) {
      const stopped = new Error(
        `Issue #${options.issueNumber}: проверка «${repeatedTest}» повторно упала на том же состоянии. ` +
        'Работа сохранена. Для продолжения исправьте причину или проверьте тестовую среду.',
        { cause: error },
      );
      stopped.code = 'RALPH_NEEDS_HUMAN';
      throw stopped;
    }
    throw error;
  }
}
