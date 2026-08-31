import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonFile, removeFileIfExists, writeJsonAtomic } from './ralph-runtime.mjs';
import { fail } from './ralph-scope.mjs';

/**
 * Состояние AFK-запуска: переживает перезапуск Node и не попадает в Git.
 */

// Пути выводятся здесь заново, как в `ralph-process-runner.mjs`.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const runtimeStatePath = path.join(projectRoot, '.git', 'ralph-loop', 'state.json');

// Активный state store читается как значение параметра по умолчанию, то есть в
// момент вызова. Функция сохраняет этот момент: импортированную переменную
// нельзя было бы присвоить.
let currentStateStore = null;

export function setActiveStateStore(store) {
  currentStateStore = store;
  return store;
}

export function activeStateStore() {
  return currentStateStore;
}

export function createStateStore(config, selectedMode, statePath = runtimeStatePath) {
  let state = readJsonFile(statePath, null);
  const configuredPhaseIndex = config.phaseIndex ?? 0;
  const configuredPhaseCount = config.phaseCount ?? 1;
  const configuredPlanId = config.phasePlanId;
  if (state) {
    const identityMismatch =
      state.version !== 2 ||
      state.phaseIndex !== configuredPhaseIndex ||
      state.phaseCount !== configuredPhaseCount ||
      state.phasePlanId !== configuredPlanId ||
      state.branch !== config.branch ||
      state.baseBranch !== config.baseBranch ||
      state.milestone !== config.milestone;
    if (identityMismatch) {
      if (state.issue === null && state.iterationsUsed === 0) {
        removeFileIfExists(statePath);
        state = null;
      } else {
        fail(
          `Сохранённое состояние ${statePath} относится к другой ветке, базе или milestone. ` +
            'Завершите предыдущий AFK-запуск или удалите state вручную после проверки.',
        );
      }
    }
  }
  if (!state && selectedMode !== '--check') {
    state = {
      version: 2,
      runId: randomUUID(),
      status: 'active',
      phaseIndex: configuredPhaseIndex,
      phaseCount: configuredPhaseCount,
      phasePlanId: configuredPlanId,
      branch: config.branch,
      baseBranch: config.baseBranch,
      milestone: config.milestone,
      iterationsUsed: 0,
      approvedIssueSnapshots: {},
      issue: null,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(statePath, state);
  }

  const persist = () => {
    if (!state) return;
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(statePath, state);
  };

  return {
    get state() {
      return state;
    },
    get issue() {
      return state?.issue ?? null;
    },
    get phaseIndex() {
      return state?.phaseIndex ?? configuredPhaseIndex;
    },
    get phaseCount() {
      return state?.phaseCount ?? configuredPhaseCount;
    },
    get approvedIssueSnapshots() {
      return state?.approvedIssueSnapshots ?? {};
    },
    approveIssueSnapshot(issueNumber, snapshot, replace = false) {
      if (!state) return snapshot;
      state.approvedIssueSnapshots ??= {};
      const key = String(issueNumber);
      const existing = state.approvedIssueSnapshots[key];
      if (existing && !replace) return existing;
      state.approvedIssueSnapshots[key] = snapshot;
      persist();
      return snapshot;
    },
    // `foreignPaths` — то, что уже лежало в рабочем дереве, когда issue
    // началась. Записывается один раз, при заведении записи: на продолжении
    // дерево грязное собственной работой агента, и пересчёт объявил бы её
    // чужой.
    beginIssue(issue, startingCommit, foreignPaths = []) {
      if (!state) return;
      if (state.issue && state.issue.number !== issue.number) {
        fail(`State ожидает issue #${state.issue.number}, но очередь выбрала #${issue.number}.`);
      }
      state.issue ??= {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        body: issue.body ?? '',
        authorLogin: issue.authorLogin ?? null,
        authorAssociation: issue.authorAssociation ?? null,
        startingCommit,
        foreignPaths: [...foreignPaths],
        phase: 'agent-running',
        validationFixAttempts: 0,
        lastFailure: null,
        lastFailureSummary: null,
        commit: null,
        pushedHead: null,
        expectedTree: null,
        commitMessage: null,
      };
      state.issue.phase = 'agent-running';
      persist();
      return state.issue;
    },
    updateIssue(values) {
      if (!state?.issue) return;
      Object.assign(state.issue, values);
      persist();
    },
    clearIssue() {
      if (!state) return;
      state.issue = null;
      persist();
    },
    get iterationsUsed() {
      return state?.iterationsUsed ?? 0;
    },
    reserveIteration() {
      if (!state) return null;
      state.iterationsUsed += 1;
      persist();
      return state.iterationsUsed;
    },
    releaseIteration() {
      if (!state) return null;
      state.iterationsUsed = Math.max(0, state.iterationsUsed - 1);
      persist();
      return state.iterationsUsed;
    },
    allowsDirtyRecovery(currentBranch, currentHead) {
      return Boolean(
        state?.issue &&
        currentBranch === state.branch &&
        currentHead === state.issue.startingCommit &&
        ['agent-running', 'working-tree', 'validating', 'validation-mutated', 'staging'].includes(
          state.issue.phase,
        ),
      );
    },
    advancePhase(nextConfig) {
      if (!state) return false;
      if (state.issue !== null) {
        fail(`Нельзя перейти к следующей фазе: состояние issue #${state.issue.number} не очищено.`);
      }
      const expectedIndex = state.phaseIndex + 1;
      if (nextConfig.phaseIndex !== expectedIndex || nextConfig.phasePlanId !== state.phasePlanId) {
        fail('Следующая фаза не соответствует сохранённому плану Ralph Loop.');
      }
      state.phaseIndex = nextConfig.phaseIndex;
      state.branch = nextConfig.branch;
      state.baseBranch = nextConfig.baseBranch;
      state.milestone = nextConfig.milestone;
      state.iterationsUsed = 0;
      persist();
      return true;
    },
    finish() {
      state = null;
      removeFileIfExists(statePath);
    },
  };
}
