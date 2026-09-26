import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { configPath, prepareConfig } from './ralph-config.mjs';
import { runPhasePlan } from './ralph-loop.mjs';
import { fieldGroups } from './ralph-gui-fields.mjs';
import { readLiveStatus, resetLiveStatus } from './ralph-live-status.mjs';
import { assertLisaWorkspaceUnchanged, effectiveLisaIterationReserve, runWithSupervisor,
  supervisorAgentConfig, supervisorPhaseConfig, supervisorPrompt } from './ralph-supervisor.mjs';

function fixture(overrides = {}) {
  const state = { calls: 0, extraIterations: 0, issue: { number: 12, phase: 'working-tree' } };
  const store = {
    get issue() { return state.issue; },
    get supervisorCalls() { return state.calls; },
    get supervisorExtraIterations() { return state.extraIterations; },
    reserveSupervisorCall() { state.calls += 1; return state.calls; },
    finishSupervisorCall() {},
    grantSupervisorIteration() { state.extraIterations += 1; },
    updateIssue(patch) { Object.assign(state.issue, patch); },
  };
  return {
    config: { maxIterations: 2, supervisor: { enabled: true, maxInterventions: 3,
      maxAdditionalIterations: 2 }, ...overrides },
    state, store,
  };
}

test('Lisa resumes Ralph with a bounded, persistent iteration reserve', async () => {
  const { config, state, store } = fixture();
  const limits = [];
  const result = await runWithSupervisor(config, store, async (effective) => {
    limits.push(effective.maxIterations + effectiveLisaIterationReserve(effective, store));
    if (limits.length === 1) throw Object.assign(new Error('limit'), { code: 'RALPH_ITERATION_LIMIT' });
    return { verdict: 'pass' };
  }, async () => ({ verdict: 'resume', reason: 'fixed' }));
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(limits, [2, 3]);
  assert.equal(state.calls, 1);
  assert.equal(state.extraIterations, 1);
});

test('Lisa publishes and closes her own live progress stage', async () => {
  resetLiveStatus();
  const { config, store } = fixture();
  let runs = 0;
  await runWithSupervisor(config, store, async () => {
    if (runs++ === 0) throw new Error('blocked');
    return { verdict: 'pass' };
  }, async () => {
    const activity = readLiveStatus().activity;
    assert.equal(activity.kind, 'supervisor');
    assert.equal(activity.active, true);
    assert.match(activity.label, /Lisa: вызов 1\/3/);
    return { verdict: 'resume', reason: 'fixed' };
  });
  assert.equal(readLiveStatus().activity.active, false);
});

test('Lisa can stop for a human without resuming Ralph', async () => {
  const { config, state, store } = fixture();
  let attempts = 0;
  const result = await runWithSupervisor(config, store, async () => {
    attempts += 1;
    throw new Error('blocked');
  }, async () => ({ verdict: 'human', reason: 'Access requires owner approval' }));
  assert.equal(result.verdict, 'needs-human');
  assert.equal(result.reason, 'Access requires owner approval');
  assert.equal(attempts, 1);
  assert.equal(state.calls, 1);
});

test('parked review keeps issue context and restarts with a fresh review allowance', async () => {
  const { config, state, store } = fixture();
  state.issue.phase = 'review-failed';
  state.issue.reviewFixAttempts = 3;
  let attempts = 0;
  await runWithSupervisor(config, store, async () => {
    attempts += 1;
    if (attempts === 1) return { verdict: 'parked', parkedIssues: [12] };
    assert.equal(state.issue.phase, 'working-tree');
    assert.equal(state.issue.reviewFixAttempts, 0);
    return { verdict: 'pass' };
  }, async () => ({ verdict: 'resume', reason: 'review findings addressed' }));
  assert.equal(attempts, 2);
});

test('exhausted interventions and authorization errors never invoke Lisa', async () => {
  const { config, state, store } = fixture();
  state.calls = 3;
  let calls = 0;
  await assert.rejects(runWithSupervisor(config, store, async () => { throw new Error('blocked'); },
    async () => { calls += 1; }), /blocked/);
  state.calls = 0;
  await assert.rejects(runWithSupervisor(config, store, async () => {
    throw Object.assign(new Error('auth'), { code: 'RALPH_AGENT_AUTH' });
  }, async () => { calls += 1; }), /auth/);
  await assert.rejects(runWithSupervisor(config, store, async () => {
    throw Object.assign(new Error('trusted files changed'), { code: 'RALPH_CONTROL_PLANE_CHANGED' });
  }, async () => { calls += 1; }), /trusted files changed/);
  assert.equal(calls, 0);
});

test('manual recovery stop leaves Lisa budget for a fix she can perform', async () => {
  const { config, state, store } = fixture();
  let calls = 0;
  await assert.rejects(runWithSupervisor(config, store, async () => {
    throw Object.assign(new Error('Укажите ручной коммит'), { code: 'RALPH_RECOVERY_BLOCKED' });
  }, async () => { calls += 1; }), /ручной коммит/);
  assert.equal(calls, 0);
  assert.equal(state.calls, 0);
});

test('an intentional one-issue stop does not call Lisa', async () => {
  const { config, store } = fixture();
  let calls = 0;
  const result = await runWithSupervisor(config, store,
    async () => ({ verdict: 'stopped', phases: [{ completed: 1 }] }),
    async () => { calls += 1; });
  assert.equal(result.verdict, 'stopped');
  assert.equal(calls, 0);
});

test('prompt includes saved context and forbids changing task boundaries', () => {
  const prompt = supervisorPrompt({ branch: 'feature/a', milestone: 'Phase 1' },
    { issue: { number: 12, phase: 'working-tree', lastFailureSummary: 'tests fail' } },
    new Error('stopped'), 1);
  assert.match(prompt, /#12/);
  assert.match(prompt, /tests fail/);
  assert.match(prompt, /не меняй.*критерии/i);
});

test('Lisa uses Codex Astra low even when Ralph uses Claude', () => {
  const config = supervisorAgentConfig({ agentCli: 'claude', developmentModel: 'claude-opus-5',
    developmentEffort: 'medium', supervisor: { model: 'gpt-6-astra', effort: 'low' } });
  assert.equal(config.agentCli, 'codex');
  assert.equal(config.developmentModel, 'gpt-6-astra');
  assert.equal(config.developmentEffort, 'low');
});

test('Lisa can use Claude independently of Ralph with its own model and effort', () => {
  const sample = JSON.parse(readFileSync(configPath, 'utf8'));
  const config = prepareConfig({ ...sample, agentCli: 'codex',
    supervisor: { agentCli: 'claude', model: 'claude-opus-5-5', effort: 'high' } });
  const lisa = supervisorAgentConfig(config);
  assert.equal(lisa.agentCli, 'claude');
  assert.equal(lisa.developmentModel, 'claude-opus-5-5');
  assert.equal(lisa.developmentEffort, 'high');
  assert.throws(() => prepareConfig({ ...sample,
    supervisor: { agentCli: 'unknown' } }), /supervisor.agentCli/);
  assert.throws(() => prepareConfig({ ...sample,
    supervisor: { agentCli: 'claude', effort: 'minimal' } }), /supervisor.effort/);
});

test('Lisa model and effort choices follow her CLI in the control panel', () => {
  const fields = fieldGroups.flatMap((group) => group.fields);
  const byPath = (path) => fields.find((field) => field.path === path);
  assert.deepEqual(byPath('supervisor.agentCli').options, ['codex', 'claude']);
  assert.equal(byPath('supervisor.model').optionsDependOn, 'supervisor.agentCli');
  assert.ok(byPath('supervisor.model').options.claude.includes('claude-opus-5-5'));
  assert.ok(byPath('supervisor.model').options.claude.includes('claude-fable-5-1'));
  assert.ok(byPath('supervisor.model').options.codex.includes('gpt-6-astra'));
  assert.ok(byPath('supervisor.model').options.codex.includes('gpt-6-sol'));
  assert.ok(byPath('supervisor.model').options.codex.includes('gpt-6-luna'));
  assert.equal(byPath('supervisor.effort').optionsDependOn, 'supervisor.agentCli');
  assert.ok(byPath('supervisor.effort').options.claude.includes('max'));
});

test('Lisa receives the current saved phase and cannot move HEAD', () => {
  const config = supervisorPhaseConfig({ branch: 'phase-one', milestone: 'One' },
    { state: { branch: 'phase-two', milestone: 'Two' } });
  assert.equal(config.branch, 'phase-two');
  assert.equal(config.milestone, 'Two');
  assert.doesNotThrow(() => assertLisaWorkspaceUnchanged(
    { branch: 'phase-two', head: 'abc' }, { branch: 'phase-two', head: 'abc' }));
  assert.throws(() => assertLisaWorkspaceUnchanged(
    { branch: 'phase-two', head: 'abc' }, { branch: 'phase-two', head: 'def' }), /HEAD/);
});

test('supervisor settings reject unknown fields and nonpositive limits', () => {
  const sample = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.throws(() => prepareConfig({ ...sample, supervisor: { enabled: true, mystery: 1 } }),
    /Неизвестные поля в "supervisor"/);
  assert.throws(() => prepareConfig({ ...sample, supervisor: {
    enabled: true, maxInterventions: 0,
  } }), /supervisor.maxInterventions/);
});

test('disabled or reduced supervisor budget cannot reuse old extra iterations', () => {
  const { config, state, store } = fixture();
  state.extraIterations = 5;
  assert.equal(effectiveLisaIterationReserve(config, store), 2);
  assert.equal(effectiveLisaIterationReserve({ ...config, supervisor: { ...config.supervisor,
    enabled: false } }, store), 0);
});

test('Lisa iteration reserve resets before the next phase starts', async () => {
  const config = { maxIterations: 2, supervisor: { enabled: true,
    maxAdditionalIterations: 3 }, phases: [
    { milestone: 'One', branch: 'one', baseBranch: 'main' },
    { milestone: 'Two', branch: 'two', baseBranch: 'main' },
  ] };
  let phaseIndex = 0;
  let extra = 1;
  const store = {
    get phaseIndex() { return phaseIndex; },
    get supervisorExtraIterations() { return extra; },
    advancePhase(nextConfig) { phaseIndex = nextConfig.phaseIndex; extra = 0; },
    finish() {},
  };
  const limits = [];
  await runPhasePlan(config, store, async (phase) => {
    limits.push(phase.maxIterations);
    return { verdict: 'pass' };
  });
  assert.deepEqual(limits, [3, 2]);
});
