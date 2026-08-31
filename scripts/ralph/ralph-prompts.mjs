/**
 * Prompt для реализации issue и для обоих ревьюеров.
 */

function renderTemplate(template, replacements) {
  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value);
  }

  return result;
}

export function renderPrompt(config, issue, rules) {
  const replacements = {
    '{milestone}': config.milestone,
    '{branch}': config.branch,
    '{issue_number}': String(issue.number),
    '{issue_title}': issue.title,
    '{issue_url}': issue.url,
    '{max_turns}': String(config.maxTurns),
    '{max_test_fix_attempts}': String(config.maxTestFixAttempts),
  };

  const prompt = renderTemplate(config.prompt, replacements);
  const renderedRules = renderTemplate(rules, replacements);
  const issueBody = issue.body?.trim() || '(Описание issue пустое.)';

  return `${prompt}\n\n## Текущая issue\n\n- Number: #${issue.number}\n- Title: ${issue.title}\n- URL: ${issue.url}\n\n### Body и критерии готовности\n\n${issueBody}\n\n---\n\n${renderedRules}`;
}

// Both review prompts need these blocks verbatim, so they live here once: a
// second copy would leave one reviewer on an older contract after an edit.
//
// Подсказка про чтение зависит от того, какой CLI ведёт ревью, и это не
// косметика. Codex-ревьюер работает в read-only песочнице с полноценной
// оболочкой, а Claude-ревьюер запускается с `--tools Read,Glob,Grep` и Bash не
// имеет вовсе: инструкция про `rg -n` и `-LiteralPath` для него неисполнима.
// Важнее второе: в shell-подсказке защиту от того, что путь со скобками
// прочитают как шаблон, даёт флаг PowerShell, а Claude-ревьюеру он недоступен —
// его Glob и `--glob` у Grep трактуют скобки как класс символов, поэтому ту же
// защиту несёт вторая подсказка.
const powershellReviewGuidance =
  'Read efficiently on this Windows/PowerShell host: locate code with `rg -n` before opening a file, read bounded ranges rather than whole files, and pass every discovered path to file cmdlets with `-LiteralPath` so a path segment containing square brackets is not treated as a wildcard pattern. Do not dump full logs, lockfiles, or generated files.';
const posixShellReviewGuidance =
  'Read efficiently: locate code with `grep -rn` before opening a file, read bounded ranges rather than whole files, and quote every discovered path so a segment containing square brackets is not expanded by the shell. Do not dump full logs, lockfiles, or generated files.';
const toolReviewGuidance =
  'Read efficiently with the only tools you have — Grep, Glob and Read: locate code with Grep before opening a file, and read bounded ranges with Read rather than whole files. Glob patterns and Grep `--glob` filters treat square brackets as a character class, so a path segment written in brackets never matches literally: reach it with a wildcard segment, then pass the exact path to Read. Do not dump full logs, lockfiles, or generated files.';

/**
 * Оболочка ревьюера — это оболочка машины оператора, а не контейнера проверок,
 * поэтому подсказка выбирается по платформе, а не только по CLI. Роль Claude
 * оболочки не получает вовсе, и её подсказка от платформы не зависит.
 */
export function reviewShellGuidance(config, platform = process.platform) {
  if (config?.agentCli === 'claude') return toolReviewGuidance;

  return platform === 'win32' ? powershellReviewGuidance : posixShellReviewGuidance;
}
// Тот же принцип, что и у подсказки про чтение: способ найти документ обязан
// быть исполнимым тем набором инструментов, который получила роль.
const documentationDiscoveryTail =
  'Never guess conventional paths such as `docs/README.md`: read only the documents discovery actually returned.';
const shellDocumentationDiscovery = `Discover documentation paths before reading them: use \`rg --files docs\` and repository file listings, then read only paths confirmed to exist. ${documentationDiscoveryTail}`;
const toolDocumentationDiscovery = `Discover documentation paths before reading them: list them with Glob patterns such as \`docs/**/*.md\`, then read only paths confirmed to exist. ${documentationDiscoveryTail}`;

function reviewDocumentationDiscovery(config) {
  return config?.agentCli === 'claude' ? toolDocumentationDiscovery : shellDocumentationDiscovery;
}
const reviewVerdictContract =
  'Use verdict "fail" when at least one actionable finding exists; otherwise use "pass" with an empty findings array.';

/**
 * Блок изменений: то, что оркестратор уже знает, и то, что ревьюер иначе
 * добывает сам. Claude-ревьюер запускается без оболочки и `git` вызвать не
 * может: без этого блока «изменения для issue» для него — догадка по тексту.
 */
function reviewChangeInventory(heading, changes) {
  if (!changes) return '';
  const truncationNote = changes.truncated
    ? '\n\nThe diff above is truncated. Read the remaining changed files from the list yourself.'
    : '';

  return `

${heading}

${changes.stat}

${changes.nameStatus}

\`\`\`diff
${changes.diff}
\`\`\`${truncationNote}`;
}

function issueChangeHeading(changes) {
  // Со второй итерации у issue больше одного commit, и назвать только
  // последний значило бы выдать доработку за всю реализацию.
  const commits = changes.commits ?? [changes.commit];
  const range =
    commits.length > 1
      ? `across the ${commits.length} commits of this issue (${commits.join(', ')})`
      : `in commit ${changes.commit}`;

  return `Changes ${range}. This is the complete set of changes made for this issue.`;
}

// Ревьюер, которому не сказали, что проверки уже прошли, тратит шаги на их
// повторение или выдаёт «нужно прогнать тесты» за замечание. Ни то, ни другое
// не является дефектом реализации.
function reviewValidationEvidence(config) {
  const scripts = config?.validationScripts ?? [];
  if (scripts.length === 0) return '';

  return `

The Ralph orchestrator already ran ${scripts.join(', ')} in an isolated container against this exact tree, and all of them passed. Do not rerun them, and do not report a finding whose only content is that a check should be run.`;
}

function reviewPreviousFindings(previousFindings) {
  if (!previousFindings) return '';

  return `

The previous review of this issue reported the findings below. Check each one before anything else: state in your summary whether it is resolved at HEAD, and report it again only if it is not.

${previousFindings}`;
}

/**
 * Что уже проверено прошлым ревью.
 *
 * Без этого блока каждое повторное ревью проходит полный аудит заново и
 * перепроверяет то, что прошлое уже признало чистым. Глубина не снижается —
 * сужается область, а неизменившийся код объявляется проверенным ровно в том
 * объёме, в каком он и был проверен.
 */
function reviewAlreadyAudited(previousReview) {
  if (!previousReview?.commit) return '';
  const added = previousReview.newCommits ?? [];
  const scope =
    added.length > 0
      ? `Since then this issue added ${added.length === 1 ? 'commit' : 'commits'} ${added.join(', ')}.`
      : 'Nothing has been added to this issue since.';

  return `

The previous review audited commit ${previousReview.commit} in full. ${scope} Audit those changes in full, verify at HEAD that every finding listed above is resolved, and make one bounded pass over how the new changes interact with the rest of the issue. Do not re-audit unchanged code that the previous review already cleared.`;
}

// Область аудита задаёт сам набор изменённых файлов. Предвычисленный список
// направлений пришлось бы вести под каждый проект отдельно, и любая тема, не
// попавшая в него, молча выпадала бы из ревью.
const auditInstruction =
  'Audit every changed file and every requirement and definition-of-done item from the issue body: correctness, edge cases, regressions, security, test coverage, and the interactions between the changed files rather than only the most obvious one.';

export function buildIndependentReviewPrompt(config, issue, commit, context = {}) {
  const issueBody = issue.body?.trim() || '(empty)';

  return `Review the current branch state at HEAD as the implementation of GitHub issue #${issue.number}: ${issue.title}. Commit ${commit} is the claimed implementation commit; verify that the current HEAD still satisfies the issue and has not regressed it.

Issue body:
${issueBody}${reviewPreviousFindings(context.previousFindings)}${context.changes ? reviewChangeInventory(issueChangeHeading(context.changes), context.changes) : ''}${reviewAlreadyAudited(context.previousReview)}${reviewValidationEvidence(config)}

Complete the entire audit before deciding the verdict. Do not stop after the first problem. Return every distinct, actionable finding you can substantiate in this single response, without duplicates and without inventing findings to fill a quota.

${auditInstruction}

${reviewShellGuidance(config)}

${reviewDocumentationDiscovery(config)}

Only report findings caused by the claimed implementation, regressions at current HEAD, or work required by the issue. Ignore unrelated pre-existing debt. ${reviewVerdictContract} Do not edit files.`;
}

function branchChangeHeading(changes) {
  return (
    `Changes on this branch (${changes.range}), with Ralph's control plane excluded. ` +
    `Commits:\n${changes.commits || '(none listed)'}`
  );
}

/**
 * Блок предыдущего milestone-ревью: со второго круга полный аудит не
 * повторяется. Прежнее ревью передаётся дословно — оно уже опубликовано в PR и
 * является ровно тем результатом, закрытие которого требуется проверить.
 *
 * Формулировка «up to head» точна и для цепочки: первый круг был полным, каждый
 * следующий целиком покрывал свой срез, поэтому к прежнему head весь код
 * проверен ровно по одному разу. Цитата оборачивается в blockquote: голые
 * `### Findings` и маркеры из прежнего текста, переехав в summary нового ревью,
 * ломали бы распознавание чистого PASS.
 */
function milestonePreviousReviewSection(previousReview) {
  if (!previousReview) return '';
  const scopeSentences = previousReview.hasNewCommits
    ? 'The change inventory above covers only the commits added since that head. Verify at the current head that every finding of the previous review below is resolved and report it again only if it is not. Audit the new changes in full within the milestone scope, and make one bounded pass over how they interact with the already-reviewed implementation. Do not re-audit unchanged code that earlier reviews already cleared.'
    : 'No commits were added since that head, so there is no new change inventory. Verify at the current head that every finding of the previous review below is resolved, and report it again only if it is not; there are no new changes to audit.';
  const quotedReview = previousReview.body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  return `

Earlier milestone reviews already audited this pull request up to head ${previousReview.head}. ${scopeSentences} Findings listed under "Below the severity floor" are handled outside this review — do not re-verify or re-report them.

The previous milestone review, quoted:

${quotedReview}`;
}

export function buildMilestoneReviewPrompt(config, milestone, pullRequest, context = {}) {
  const milestoneDescription = milestone.description?.trim() || '(Milestone description is empty.)';
  const evidenceSentence = context.previousReview
    ? context.changes
      ? 'Use the change inventory above as evidence, not as the definition of scope.'
      : 'There is no new change inventory; use the previous review quoted below and targeted file reads as evidence.'
    : `Use the branch diff against ${config.baseBranch} as evidence, not as the definition of scope.`;
  const reviewBreadth = context.previousReview
    ? context.previousReview.hasNewCommits
      ? 'review the changes since the previously reviewed head and the resolution of every prior finding'
      : 'verify the resolution of every finding of the previous review'
    : 'review the complete current implementation rather than only the latest commit';

  return `Perform a read-only architectural review of pull request #${pullRequest.number} (${pullRequest.url}) for milestone "${milestone.title}".

Milestone description:
${milestoneDescription}${context.changes ? reviewChangeInventory(branchChangeHeading(context.changes), context.changes) : ''}

The branch and pull request may be cumulative and contain work from other milestones. Scope the review exclusively to the requirements in the milestone title and description, plus integrations strictly required for those requirements. ${evidenceSentence} Do not report defects in unrelated features, infrastructure, or files merely because they are present or changed in the pull request.${milestonePreviousReviewSection(context.previousReview)}

Ralph's control plane is maintained manually outside the product loop. Do not open .agents/** or scripts/ralph/**, and never report findings for those paths, for AGENTS.md, or for nested **/AGENTS.md files: they must never become milestone issues and must never be modified by an AFK implementation session. Do read AGENTS.md and the nested ones — they carry the conventions the product code is judged against.

${reviewShellGuidance(config)}

Within that milestone scope, ${reviewBreadth}. Read AGENTS.md, relevant PRD/plan documents, issue-related documentation, and tests. ${reviewDocumentationDiscovery(config)} Look for cross-issue integration problems, architectural inconsistencies, security vulnerabilities, performance or scalability risks, regressions, missing tests, and deviations from the milestone requirements.

The Ralph orchestrator has already completed every configured preflight and validation script successfully for the exact reviewed head. Do not rerun builds, linters, type checks, tests, dev servers, package manager commands, or any command that writes caches or artifacts. Use read-only file and git inspection only.

Report every distinct actionable finding in scope in this single response. ${reviewVerdictContract} Do not edit files, create comments, change GitHub state, or run destructive commands. The Ralph orchestrator will publish the structured result.`;
}
