import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as supervisor from './ralph-supervisor.mjs';
import { createStateStore } from './ralph-state-store.mjs';

test('Lisa receives repair feedback and a bounded local environment repair policy', () => {
  const feedback = [{ stage: 'validation', reason: 'fixture late GET remains broken' }];
  const prompt = supervisor.supervisorPrompt({ branch: 'phase', milestone: 'One' },
    { issue: { number: 12, phase: 'review-failed', reviewFindings: 'Preserve the draft' } },
    new Error('parked'), 1, { proposalOnly: true, repairFeedback: feedback });
  assert.match(prompt, /manifest.*lock/u);
  assert.match(prompt, /явн.*пут/u);
  assert.match(prompt, /alias/u);
  assert.match(prompt, /объявленн.*зависимост/u);
  assert.match(prompt, /изолированн.*окружен/u);
  assert.match(prompt, /необязательн.*обновлен/u);
  assert.match(prompt, /recommendations/u);
  assert.ok(prompt.includes(JSON.stringify(feedback)));
  assert.match(prompt, /данные.*не.*инструкц/u);
  assert.doesNotMatch(prompt, /Не запускай даже для диагностики команды, которые устанавливают/u);
});

test('Lisa answer recommendations preserve a valid proposal and reject malformed optional data', () => {
  const answer = { verdict: 'resume', reason: 'The required checks pass',
    recommendations: [' Update the optional runtime later ', 'Update the optional runtime later'] };
  assert.deepEqual(supervisor.parseLisaAnswer(JSON.stringify(answer)), {
    verdict: 'resume', reason: answer.reason, recommendations: ['Update the optional runtime later'],
  });
  assert.equal(supervisor.parseLisaAnswer(JSON.stringify({ verdict: 'resume', reason: 'Existing answer' })).verdict, 'resume');
  for (const recommendations of ['not-an-array', [null], [''], ['secret\ncommand'],
    ['x'.repeat(1001)], Array.from({ length: 11 }, () => 'Too many')]) {
    const invalid = supervisor.parseLisaAnswer(JSON.stringify({ ...answer, recommendations }));
    assert.equal(invalid.verdict, 'human');
    assert.match(invalid.reason, /recommendations/u);
  }
});

test('accepted Lisa recommendations survive restart and phase advancement with their original issue', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-lisa-recommendations-'));
  const statePath = path.join(directory, 'state.json');
  const config = { branch: 'one', baseBranch: 'main', milestone: 'One',
    phaseIndex: 0, phaseCount: 2, phasePlanId: 'plan' };
  try {
    const first = createStateStore(config, '--run', statePath);
    first.beginIssue({ number: 12, body: 'Requirements' }, 'a'.repeat(40));
    first.addLisaRecommendations(['Optional runtime update']);
    first.addLisaRecommendations(['Optional runtime update']);
    assert.deepEqual(first.lisaRecommendations, [{ phaseIndex: 0, issueNumber: 12, reason: 'Optional runtime update' }]);
    const copy = first.lisaRecommendations;
    copy[0].reason = 'External mutation';
    assert.equal(first.lisaRecommendations[0].reason, 'Optional runtime update');
    const resumed = createStateStore(config, '--run', statePath);
    assert.deepEqual(resumed.lisaRecommendations, first.lisaRecommendations);
    resumed.clearIssue();
    const nextConfig = { ...config, phaseIndex: 1, branch: 'two', milestone: 'Two' };
    resumed.advancePhase(nextConfig);
    const second = createStateStore(nextConfig, '--run', statePath);
    assert.deepEqual(second.lisaRecommendations, first.lisaRecommendations);
    second.beginIssue({ number: 13 }, 'b'.repeat(40));
    second.addLisaRecommendations(['Optional runtime update']);
    assert.deepEqual(second.lisaRecommendations.map(({ phaseIndex, issueNumber }) => [phaseIndex, issueNumber]), [[0, 12], [1, 13]]);
    const before = second.lisaRecommendations;
    assert.throws(() => second.addLisaRecommendations(['']), /recommendations/u);
    assert.deepEqual(second.lisaRecommendations, before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('embedded supervisor retains recommendations only from its accepted compatibility repair', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-lisa-embedded-recommendations-'));
  const statePath = path.join(directory, 'state.json');
  const config = { branch: 'one', baseBranch: 'main', milestone: 'One',
    supervisor: { enabled: true, maxInterventions: 3, maxAdditionalIterations: 2 } };
  try {
    const store = createStateStore(config, '--run', statePath);
    store.beginIssue({ number: 12 }, 'a'.repeat(40));
    let attempts = 0;
    const result = await supervisor.runWithSupervisor(config, store, async () => {
      if (attempts++ === 0) throw new Error('fixture repair needed');
      return { verdict: 'pass' };
    }, async () => ({ verdict: 'resume', reason: 'Compatibility caller accepted the repair',
      recommendations: ['Optional update after the successful gate'] }));
    assert.equal(result.verdict, 'pass');
    const restarted = createStateStore(config, '--run', statePath);
    assert.deepEqual(restarted.lisaRecommendations,
      [{ phaseIndex: 0, issueNumber: 12, reason: 'Optional update after the successful gate' }]);
    const before = restarted.lisaRecommendations;
    const stopped = await supervisor.runWithSupervisor(config, restarted,
      async () => { throw new Error('external permission needed'); },
      async () => ({ verdict: 'human', reason: 'External permission needed', recommendations: ['Unaccepted recommendation'] }));
    assert.equal(stopped.verdict, 'needs-human');
    assert.deepEqual(createStateStore(config, '--run', statePath).lisaRecommendations, before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
