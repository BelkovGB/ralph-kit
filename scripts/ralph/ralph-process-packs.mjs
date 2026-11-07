import { run } from './ralph-process-runner.mjs';
import { isAncestorCommit } from './ralph-git.mjs';

const packs = {
  bugfix: {
    development: 'Воспроизведи дефект до правки. Добавь проверку регрессии и подтверди, что она падает по той же причине, затем исправь дефект.',
    review: 'Check that the regression test reproduces the original defect and fails without the fix.',
  },
  feature: {
    development: 'Сопоставь критерии готовности с проверками нового поведения. Для нескольких зависимых изменений сначала наметь порядок в этой же сессии.',
    review: 'Match the acceptance criteria to tests for the new behavior and check its existing callers.',
  },
  'ui-change': {
    development: 'Определи, какой пользовательский сценарий меняется. Обнови его браузерную проверку. Ralph запустит браузерные команды проекта после обычных проверок.',
    review: 'Check that the browser assertions exercise the changed user flow and cover the issue criteria.',
  },
  research: {
    report: true,
    development: 'Ответь на вопрос в задаче. Укажи источники, сравни варианты по заданным критериям и отдели измерения от допущений.',
    review: 'Check that the report answers the question, cites its sources, and supports its conclusions.',
  },
  review: {
    report: true,
    development: 'Проверь изменение, указанное в задаче. Для каждого замечания укажи место, последствие и способ воспроизведения. Зафиксируй проверенный diff или SHA и итог.',
    review: 'Check the report against the requested diff. Verify its coverage and the evidence for each finding.',
  },
};

function baseValidationScripts(config, scope) {
  return config.validationProfiles?.[scope] ?? config.validationScripts ?? [];
}

function processConfigError(issueNumber, message) {
  throw Object.assign(new Error(`Issue #${issueNumber}: ${message}`), { code: 'RALPH_PROCESS_CONFIG' });
}

/** Execution reads the approved snapshot. Only --check supplies a body for preview. */
export function resolveIssueProcess(config, issueNumber, body = config.approvedIssueSnapshots?.[issueNumber]?.body) {
  const firstLine = (body ?? '').trimStart().split(/\r?\n/u, 1)[0].trimEnd();
  if (!/^<!--\s*ralph-process\b/u.test(firstLine)) return null;

  const kind = /^<!-- ralph-process: ([a-z-]+) -->$/u.exec(firstLine)?.[1];
  if (!Object.hasOwn(packs, kind)) {
    processConfigError(issueNumber, `ожидается первая строка <!-- ralph-process: РЕЖИМ -->. Режимы: ${Object.keys(packs).join(', ')}.`);
  }
  if (config.review?.enabled !== true) {
    processConfigError(issueNumber, `для ${kind} включите независимое ревью (review.enabled).`);
  }
  if ((kind === 'bugfix' || kind === 'feature') && baseValidationScripts(config, 'issue').length === 0) {
    processConfigError(issueNumber, `для ${kind} задайте команды проверки задачи в validationProfiles.issue или validationScripts.`);
  }
  if (kind === 'ui-change' && !config.browserValidationScripts?.length) {
    processConfigError(issueNumber, 'для ui-change задайте команды в browserValidationScripts.');
  }

  const { report, development, review } = packs[kind];
  if (!report) return { kind, development, review };
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    processConfigError(issueNumber, 'для отчёта нужен положительный номер задачи.');
  }
  return { kind, development, review, reportPath: `docs/ralph-reports/issue-${issueNumber}.md` };
}

export function validationScriptsFor(config, scope, issueNumber) {
  const scripts = baseValidationScripts(config, scope);
  const browserRequired = scope === 'phase' || (
    scope === 'issue' && resolveIssueProcess(config, issueNumber)?.kind === 'ui-change'
  );
  return browserRequired ? [...scripts, ...(config.browserValidationScripts ?? [])] : scripts;
}

function changedPaths(base, tree) {
  // The status comes first so trimming stdout cannot eat whitespace in a path.
  const { stdout } = run('git', [
    'diff', '--name-status', '-z', '--no-ext-diff', '--no-renames', '--ignore-submodules=none', base, tree, '--',
  ]);
  return stdout.split('\0').filter((_, index) => index % 2 === 1);
}

/** Check the exact Git paths and require a real report in the current tree. */
export function assertProcessReport(pack, base, tree, { head = tree, committed = false, repair = null } = {}) {
  const file = pack?.reportPath;
  if (!file) return;

  const allowedPaths = new Set([file, ...(repair?.paths ?? [])]);
  const paths = changedPaths(base, tree);
  // A revert can hide a product change from the net diff but not from the
  // history published by push. Report commits must also be linear.
  const reportHistory = committed
    ? run('git', ['rev-list', '--parents', `${base}..${tree}`]).stdout.split('\n').filter(Boolean)
    : [];
  const scopedHistory = reportHistory.every((line) => {
    const [commit, parent, otherParent] = line.trim().split(' ');
    return parent && !otherParent && changedPaths(parent, commit).every((path) => allowedPaths.has(path));
  });
  const reportEntry = (ref) => run('git', ['ls-tree', ref, '--', `:(top,literal)${file}`]).stdout;
  const entry = reportEntry(tree);
  const reportChanged = paths.includes(file);
  const priorCommit = repair?.priorCommit;
  const preservedReport = !reportChanged && priorCommit &&
    isAncestorCommit(priorCommit, base) && reportEntry(priorCommit) === entry;
  if (!scopedHistory || paths.some((path) => !allowedPaths.has(path)) ||
      (!reportChanged && !preservedReport) ||
      !/^100(?:644|755) blob [0-9a-f]+\t/u.test(entry) ||
      run('git', ['grep', '-I', '-q', '-e', '[^[:space:]]', tree, '--', `:(top,literal)${file}`],
        { allowFailure: true }).status !== 0 ||
      (head !== tree && reportEntry(head) !== entry)) {
    throw Object.assign(new Error(
      `${pack.kind}: измените только ${file}. В HEAD должен остаться проверяемый непустой текстовый отчёт.`,
    ), { code: 'RALPH_PROCESS_EVIDENCE' });
  }
}
