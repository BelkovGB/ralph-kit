import { run } from './ralph-process-runner.mjs';
import { isRalphInfrastructurePath } from './ralph-scope.mjs';
import { clearedFailure } from './ralph-failure-summary.mjs';
import { filesChangedBetween, isAncestorCommit, validateRecoveredCommit, verifyRepository, workingTreePaths } from './ralph-git.mjs';

export const committedRecoveryPhases = ['committed', 'pushed', 'reviewing', 'closing'];
const workingPhases = new Set(['agent-running', 'working-tree', 'validating', 'validation-mutated']);

function blocked(message) {
  throw Object.assign(new Error(message), { code: 'RALPH_RECOVERY_BLOCKED' });
}

/** Read-only decision shared by check, run and explicit operator acceptance. */
export function analyzeRecovery(config, issue, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const git = (...args) => execute('git', args).stdout;
  const head = git('rev-parse', 'HEAD');
  const branch = git('branch', '--show-current');
  const status = git('status', '--porcelain');
  const ready = { kind: 'ready', head };
  const manualCommit = dependencies.manualCommit;
  if (!issue) {
    if (manualCommit !== undefined) blocked('Нет сохранённой задачи для принятия ручного коммита.');
    return ready;
  }
  if (branch !== config.branch) {
    blocked(`Issue #${issue.number}: текущая ветка ${branch}, ожидается ${config.branch}. Перейдите на ветку задачи.`);
  }
  if (manualCommit !== undefined) {
    if (!['agent-running', 'working-tree', 'validating', 'review-failed', ...committedRecoveryPhases].includes(issue.phase)) {
      blocked(`Issue #${issue.number}: ручное принятие недоступно на этапе ${issue.phase}; восстановите исходное состояние.`);
    }
    if (status !== '') blocked('Для принятия ручного коммита требуется чистое рабочее дерево.');
    if (!/^[a-f0-9]{40}$/.test(manualCommit)) blocked('Укажите полный SHA ручного коммита: 40 строчных шестнадцатеричных символов.');
    if (!isAncestorCommit(issue.startingCommit, manualCommit, execute) ||
        !isAncestorCommit(manualCommit, head, execute)) {
      blocked(`Issue #${issue.number}: ручной коммит не продолжает сохранённую историю HEAD.`);
    }
    if (git('show', '-s', '--format=%(trailers:key=Ralph-Issue,valueonly)', manualCommit) !== `#${issue.number}`) {
      blocked(`Ручной коммит должен содержать точный trailer Ralph-Issue: #${issue.number}.`);
    }
    if (manualCommit === issue.startingCommit &&
        (workingPhases.has(issue.phase) || issue.phase === 'review-failed')) {
      blocked('Ручной коммит не содержит продолжения сохранённой задачи.');
    }
    if (issue.phase === 'review-failed') {
      const changed = git('diff', '--name-only', '--no-renames', issue.startingCommit, manualCommit)
        .split(/\r?\n/).filter(Boolean);
      if (!changed.some((file) => !isRalphInfrastructurePath(file))) {
        blocked('Ручной коммит не содержит исправления после отклонённого ревью.');
      }
    }
    // Inspect every commit, not just the net diff: a change and its revert
    // must not hide unrelated product work. Ralph-only updates may follow a fix.
    const commits = git('rev-list', `${issue.startingCommit}..${head}`).split(/\r?\n/).filter(Boolean);
    for (const commit of commits) {
      const parents = git('show', '-s', '--format=%P', commit).split(' ');
      if (parents.length !== 1) blocked('Ручное принятие не поддерживает слияния; требуется разбор истории.');
      const paths = git('diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', commit).split(/\r?\n/).filter(Boolean);
      if (paths.every(isRalphInfrastructurePath)) continue;
      const trailer = git('show', '-s', '--format=%(trailers:key=Ralph-Issue,valueonly)', commit);
      if (trailer !== `#${issue.number}` || !isAncestorCommit(commit, manualCommit, execute)) {
        blocked(`После сохранённой базы найден посторонний продуктовый коммит ${commit}.`);
      }
    }
    return {
      kind: 'accept-manual', head,
      patch: {
        phase: 'committed', commit: manualCommit, recoveryHead: head,
        reviewedCommit: null, pushedHead: null, expectedTree: null, commitMessage: null,
        validationExpectedTreeHash: null, validationFailureFingerprint: null, ...clearedFailure,
      },
    };
  }
  if (issue.phase === 'validation-mutated') {
    if (!issue.validationExpectedTreeHash || dependencies.hostWorkingTreeHash?.() !== issue.validationExpectedTreeHash) {
      blocked(`Issue #${issue.number}: восстановите точное дерево до изменения host-проверкой.`);
    }
  }
  if (committedRecoveryPhases.includes(issue.phase)) {
    if (status !== '') blocked(`Issue #${issue.number}: committed recovery требует чистое рабочее дерево.`);
    const expected = issue.recoveryHead ?? issue.pushedHead ?? issue.commit;
    if (!issue.commit || head !== expected || !isAncestorCommit(issue.commit, head, execute)) {
      blocked(`Issue #${issue.number}: HEAD изменился после сохранённого коммита или ревью; требуется явное принятие и новая проверка.`);
    }
    return ready;
  }
  if (issue.phase === 'staging' && issue.expectedTree && head !== issue.startingCommit) {
    if (status !== '') blocked('После staging найдены новый HEAD и незакоммиченные изменения.');
    validateRecoveredCommit(issue, head, execute);
    return { kind: 'staging', head };
  }
  const phase = issue.phase === 'staging' && !issue.expectedTree ? 'working-tree' : issue.phase;
  if (head === issue.startingCommit) {
    if (status !== '' && !workingPhases.has(phase) && phase !== 'staging') blocked('Рабочее дерево не соответствует этапу восстановления.');
    return ready;
  }
  if (isAncestorCommit(issue.startingCommit, head, execute)) {
    if (phase === 'review-failed' && status === '') {
      return { kind: 'advance', head, patch: { startingCommit: head } };
    }
    if (workingPhases.has(phase) && status !== '') {
      const dirty = new Set(workingTreePaths(status));
      const moved = filesChangedBetween(issue.startingCommit, head, execute);
      if (moved !== null && moved.every((file) => !dirty.has(file))) {
        return { kind: 'advance', head, patch: { startingCommit: head } };
      }
    }
  }
  blocked(`Issue #${issue.number}: recovery ожидал HEAD ${issue.startingCommit}, найден ${head}. ` +
    'После ручного исправления используйте node scripts/ralph/ralph-loop.mjs --accept-manual-commit <полный SHA коммита задачи>.');
}

export function applyRecoveryPlan(plan, stateStore) {
  if (plan.patch) stateStore.updateIssue(plan.patch);
}

/** Prepare one phase through the same entry path used by check, run and manual acceptance. */
export function prepareRecovery(config, stateStore, mode, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const verify = dependencies.verifyRepository ?? verifyRepository;
  let repositoryState;
  // A saved issue belongs to its phase branch. A clean --run may return there
  // before recovery reads HEAD; check and manual acceptance stay read-only.
  if (mode === '--run' && stateStore?.issue &&
      execute('git', ['branch', '--show-current']).stdout !== config.branch) {
    repositoryState = verify(config, true);
  }
  const recovery = analyzeRecovery(config, stateStore?.issue, dependencies);
  if (mode === '--run') applyRecoveryPlan(recovery, stateStore);
  repositoryState ??= verify(config, mode === '--run');
  if (mode === '--accept-manual-commit') {
    const confirmed = analyzeRecovery(config, stateStore?.issue, dependencies);
    if (confirmed.head !== recovery.head) blocked('HEAD изменился во время принятия ручного коммита.');
    applyRecoveryPlan(confirmed, stateStore);
    return { recovery, repositoryState, accepted: confirmed.patch.commit };
  }
  return { recovery, repositoryState };
}
