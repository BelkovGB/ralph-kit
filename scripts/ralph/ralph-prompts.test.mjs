import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './ralph-config.mjs';
import { formatReviewComment } from './ralph-issue-contract.mjs';
import { milestonePassReviewIsClean } from './ralph-milestone-review.mjs';
import {
  buildIndependentReviewPrompt,
  buildMilestoneReviewPrompt,
  renderPrompt,
  reviewShellGuidance,
} from './ralph-prompts.mjs';
import {
  isRalphInfrastructureIssue,
  isRalphInfrastructurePath,
  applySeverityFloor,
  findingBlocks,
  scopeMilestoneReviewToProduct,
  scopeReviewToProduct,
} from './ralph-scope.mjs';

test('implementation prompt delegates full validation to the outer orchestrator', () => {
  const rules = readFileSync(new URL('../../.agents/ralph-rules.md', import.meta.url), 'utf8');
  const prompt = renderPrompt(
    {
      milestone: 'Efficiency',
      branch: 'feature/efficiency',
      prompt: 'Implement issue #{issue_number} in {milestone}.',
      maxTurns: 50,
      maxTestFixAttempts: 5,
    },
    {
      number: 7,
      title: 'Avoid duplicate validation',
      body: 'Run focused tests.',
      url: 'https://example.test/issues/7',
    },
    rules,
  );

  // Проверяется контракт, а не конкретная формулировка: полный набор делегирован
  // наружу, и повторный прогон с увеличенным таймаутом запрещён.
  assert.match(prompt, /Полный набор проверок/);
  assert.match(prompt, /снаружи\s+sandbox/);
  assert.match(prompt, /не дублируй/i);
  assert.match(prompt, /не повторяй[\s\S]{0,80}таймаутом/i);
});

test('issue review prompt requires one exhaustive in-scope audit', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'claude' },
    {
      number: 62,
      title: 'Rate-limit authentication',
      body: 'Document and test the public contract.',
    },
    'a'.repeat(40),
  );

  assert.match(prompt, /Do not stop after the first problem/);
  assert.match(prompt, /Do not delegate it to subagents/);
  assert.match(prompt, /Return every distinct, actionable finding/);
  assert.match(prompt, /Discover documentation paths/i);
  // Роль запущена с `--tools Read,Glob,Grep`, поэтому поиск описан через Glob:
  // `rg` этому ревьюеру недоступен так же, как и PowerShell.
  assert.match(prompt, /docs\/\*\*\/\*\.md/);
  assert.doesNotMatch(prompt, /rg --files/);
  assert.match(prompt, /guess conventional paths such as `docs\/README\.md`/i);
  assert.match(prompt, /Ignore unrelated pre-existing debt/);
});

test('issue review prompt carries the change set the reviewer cannot obtain itself', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'claude', validationScripts: ['npm run lint', 'npm run build', 'npm test'] },
    { number: 57, title: 'End the browser session', body: 'Outcome text.' },
    'b'.repeat(40),
    {
      changes: {
        commit: 'b'.repeat(40),
        stat: ' src/app/login/page.ts | 12 ++++--',
        nameStatus: 'M\tsrc/app/login/page.ts',
        diff: '--- a/src/app/login/page.ts\n+++ b/src/app/login/page.ts',
        truncated: false,
      },
      previousFindings: '- **P2 — Missing guard** (src/use-items.ts:36)',
    },
  );

  assert.match(prompt, /M\tsrc\/app\/login\/page\.ts/);
  assert.match(prompt, /```diff/);
  assert.match(prompt, /complete set of changes made for this issue/);
  assert.match(prompt, /Do not rebuild it with Git commands/);
  assert.match(prompt, /already ran npm run lint, npm run build, npm test/);
  assert.match(prompt, /Do not rerun them/);
  // Замечания прошлого ревью обязаны быть подписаны: внутри тела issue они
  // неотличимы от критериев готовности, и требовать их проверки бессмысленно.
  assert.match(prompt, /previous review of this issue reported the findings below/);
  assert.match(prompt, /P2 — Missing guard/);
  assert.doesNotMatch(prompt, /truncated/);
});

test('a truncated change set says so instead of looking complete', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'claude' },
    { number: 58, title: 'Large change', body: 'Outcome text.' },
    'c'.repeat(40),
    {
      changes: {
        commit: 'c'.repeat(40),
        stat: ' 40 files changed',
        nameStatus: 'M\tone.ts',
        diff: '--- a/one.ts',
        truncated: true,
      },
    },
  );

  assert.match(prompt, /The diff above is truncated/);
  // Набор validationScripts не задан: утверждать, что проверки прошли, нечем.
  assert.doesNotMatch(prompt, /already ran/);
  assert.doesNotMatch(prompt, /previous review/);
});

test('a repeat review is told what the previous one already cleared', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'claude' },
    { number: 57, title: 'Second pass', body: 'Outcome text.' },
    'd'.repeat(40),
    {
      changes: {
        commit: 'd'.repeat(40),
        commits: ['d'.repeat(40), 'e'.repeat(40)],
        paths: ['e2e/example.spec.ts'],
        stat: ' 1 file changed',
        nameStatus: 'M\te2e/example.spec.ts',
        diff: '--- a/e2e/example.spec.ts',
        truncated: false,
      },
      previousReview: { commit: 'e'.repeat(40), newCommits: ['d'.repeat(40)] },
    },
  );

  assert.match(prompt, new RegExp(`previous review audited commit ${'e'.repeat(40)} in full`));
  assert.match(prompt, new RegExp(`added commit ${'d'.repeat(40)}`));
  assert.match(prompt, /Do not re-audit unchanged code that the previous review already cleared/);
});

test('a first review is not told anything was already cleared', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'claude' },
    { number: 60, title: 'First pass', body: 'Outcome text.' },
    'f'.repeat(40),
    { changes: { commit: 'f'.repeat(40), paths: ['a.ts'], stat: '', nameStatus: '', diff: '' } },
  );

  assert.doesNotMatch(prompt, /already cleared/);
  assert.doesNotMatch(prompt, /audited commit/);
});

test('a second iteration names every commit of the issue, not just the last', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'claude' },
    { number: 57, title: 'Second pass', body: 'Outcome text.' },
    'e'.repeat(40),
    {
      changes: {
        commit: 'e'.repeat(40),
        commits: ['e'.repeat(40), 'f'.repeat(40)],
        stat: ' two.ts | 2 +-',
        nameStatus: 'M\ttwo.ts',
        diff: '--- a/two.ts',
        truncated: false,
      },
    },
  );

  assert.match(prompt, /across the 2 commits of this issue/);
  assert.match(prompt, /complete set of changes made for this issue/);
  assert.doesNotMatch(prompt, /exactly one commit/);
});

test('without a change set the prompt carries no diff section', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'codex' },
    { number: 59, title: 'No inventory', body: 'Outcome text.' },
    'd'.repeat(40),
  );

  assert.doesNotMatch(prompt, /```diff/);
  assert.match(prompt, /Do not stop after the first problem/);
});

test('milestone review stays within milestone scope and trusts completed validations', () => {
  const prompt = buildMilestoneReviewPrompt(
    { baseBranch: 'master' },
    {
      title: 'Phase 1: Core Profile API',
      description: 'Authenticated users can read and update a safe profile.',
    },
    { number: 61, url: 'https://example.test/pull/61' },
  );

  assert.match(prompt, /may be cumulative and contain work from other milestones/);
  assert.match(prompt, /Scope the review exclusively to the requirements/);
  assert.match(prompt, /diff against master as evidence, not as the definition of scope/);
  assert.match(prompt, /Do not rerun builds, linters, type checks, tests/);
  assert.match(prompt, /every configured preflight and validation script successfully/);
  // Запрет читать, а не только сообщать: control plane занимает бо́льшую часть
  // диффа ветки, и открытый файл оплачивается независимо от того, что ревьюер
  // потом отбросит. AGENTS.md при этом читать нужно — там конвенции продукта.
  assert.match(prompt, /Do not open \.agents\/\*\* or scripts\/ralph\/\*\*, and never report/);
  assert.match(prompt, /Do read AGENTS\.md/);
  // Без инвентаря prompt обходится без секции diff: ревью milestone может идти
  // по ветке, базу которой git не разрешил, и тогда инвентаря просто нет.
  assert.doesNotMatch(prompt, /```diff/);
  assert.match(prompt, /Discover documentation paths/i);
  assert.match(prompt, /rg --files docs/);
  assert.match(prompt, /guess conventional paths such as `docs\/README\.md`/i);
});

test('the milestone reviewer is shown the branch diff without the control plane', () => {
  const prompt = buildMilestoneReviewPrompt(
    { agentCli: 'claude', baseBranch: 'master' },
    { title: 'Phase 8', description: 'Password change screen.' },
    { number: 61, url: 'https://example.test/pull/61', headRefOid: 'a'.repeat(40) },
    {
      changes: {
        range: 'origin/master...' + 'a'.repeat(40),
        commits: 'abc1234 feat: end the browser session',
        stat: ' src/items.service.ts | 8 ++++',
        nameStatus: 'M\tsrc/items.service.ts',
        diff: '--- a/src/items.service.ts',
        truncated: false,
      },
    },
  );

  // Диапазон с тремя точками: сравнение идёт с точкой расхождения, иначе в diff
  // попадёт всё, что уехало в базовую ветку после ответвления.
  assert.match(prompt, /origin\/master\.\.\.a{40}/);
  assert.match(prompt, /abc1234 feat: end the browser session/);
  assert.match(prompt, /```diff/);
  assert.match(prompt, /control plane excluded/);
  assert.match(prompt, /Do not delegate it to subagents/);
  assert.match(prompt, /Do not rebuild it with Git commands/);
});

test('Ralph infrastructure is never treated as product work', () => {
  for (const file of [
    '.agents/ralph.config.json',
    'scripts/ralph/ralph-loop.mjs:975',
    'AGENTS.md',
    'packages/example/AGENTS.md',
    // Тот же файл инструкций для Claude Code: он задаёт поведение будущей
    // сессии наравне с `AGENTS.md`, поэтому и защищён наравне с ним.
    'CLAUDE.md',
    'packages/example/CLAUDE.md',
    // Claude Code читает `.claude/**`: положенный туда файл управляет будущей
    // сессией, поэтому каталог принадлежит оператору, как и `.agents/**`.
    '.claude/security-reviewer.md',
    '.claude/settings.json',
    '.claude/agents/reviewer.md',
  ]) {
    assert.equal(isRalphInfrastructurePath(file), true, file);
  }
  assert.equal(isRalphInfrastructurePath('src/main.ts:10'), false);
  assert.equal(
    isRalphInfrastructureIssue({
      body: '<!-- ralph-milestone-finding pr:61 id:x -->\n**Location:** `scripts/ralph/ralph-loop.mjs:975`',
    }),
    true,
  );
  assert.equal(
    isRalphInfrastructureIssue({ labels: [{ name: 'ralph-infrastructure' }], body: '' }),
    true,
  );
  assert.equal(
    isRalphInfrastructureIssue({
      body: '<!-- ralph-milestone-finding pr:61 id:y -->\n**Location:** `src/main.ts:10`',
    }),
    false,
  );
});

test('milestone review removes Ralph findings before product issues are created', () => {
  const scoped = scopeMilestoneReviewToProduct({
    verdict: 'fail',
    summary: 'Two findings.',
    findings: [
      {
        severity: 'P1',
        title: 'Control-plane defect',
        body: 'Fix Ralph.',
        file: 'scripts/ralph/ralph-loop.mjs',
        line: 10,
      },
      {
        severity: 'P2',
        title: 'Product defect',
        body: 'Fix API.',
        file: 'src/main.ts',
        line: 20,
      },
    ],
  });

  assert.equal(scoped.verdict, 'fail');
  assert.deepEqual(
    scoped.findings.map((finding) => finding.title),
    ['Product defect'],
  );
  assert.match(scoped.summary, /excluded from the product milestone/);

  const infrastructureOnly = scopeMilestoneReviewToProduct({
    verdict: 'fail',
    summary: 'One finding.',
    findings: [
      {
        severity: 'P1',
        title: 'Control-plane defect',
        body: 'Fix Ralph.',
        file: '.agents/RALPH.md',
      },
    ],
  });
  assert.equal(infrastructureOnly.verdict, 'pass');
  assert.deepEqual(infrastructureOnly.findings, []);
});

test('cached milestone PASS is trusted only with an empty canonical findings section', () => {
  const marker = '<!-- ralph-milestone-review milestone:abc head:def model:gpt-5.6-sol -->';
  const cleanReview = `${marker}
## Ralph Loop: milestone review

- **Verdict:** **PASS**

Everything is ready.

### Findings

No actionable findings.

The pull request remains draft so a human can make the final merge decision.`;
  const malformedReview = `${marker}
## Ralph Loop: milestone review

- **Verdict:** **PASS**

### Findings

- **P2 — Cached defect** (file.ts:10)
  This finding must prevent cached PASS reuse.

The pull request remains draft so a human can make the final merge decision.`;
  const duplicateFindingsReview = `${marker}
## Ralph Loop: milestone review

- **Verdict:** **PASS**

### Findings

- **P2 — Hidden defect** (file.ts:10)
  A second empty section must not hide this finding.

### Findings

No actionable findings.

The pull request remains draft so a human can make the final merge decision.`;

  assert.equal(milestonePassReviewIsClean(cleanReview, marker), true);
  assert.equal(milestonePassReviewIsClean(malformedReview, marker), false);
  assert.equal(milestonePassReviewIsClean(duplicateFindingsReview, marker), false);
  assert.equal(milestonePassReviewIsClean(cleanReview, '<!-- another marker -->'), false);
});

const ralphRulesPath = fileURLToPath(new URL('../../.agents/ralph-rules.md', import.meta.url));

const ralphOperatorDocPath = fileURLToPath(new URL('../../.agents/RALPH.md', import.meta.url));

test('the implementation prompt carries the full contract without the operator manual', () => {
  const config = loadConfig();
  const rules = readFileSync(ralphRulesPath, 'utf8');
  const prompt = renderPrompt(
    { ...config, milestone: 'Phase 8', branch: 'features/profile-phase-8' },
    {
      number: 71,
      title: 'Deliver the password change screen',
      url: 'https://example/71',
      body: 'Body.',
    },
    rules,
  );

  // The contract is inlined, so reading the 268-line operator document would be
  // hundreds of lines of input tokens per issue for no requirement.
  //
  // Проверяется, что правила дошли до prompt целиком и что за операторской
  // документацией он не посылает, а не формулировки шаблона: текст шаблона
  // принадлежит проекту, и тест, приколоченный к нему, падал бы в проекте с
  // другим prompt вместо потери правил.
  assert.equal(/Прочитай \.agents\/RALPH\.md/.test(prompt), false);
  assert.match(prompt, /# Ralph Loop — правила автономной сессии/);
  // Проверяется, что запрет на control plane дошёл до prompt и называет все
  // защищённые каталоги, а не точная формулировка: правила переписываются, и
  // тест, приколоченный к фразе, ловил бы редактуру вместо потери правила.
  for (const guarded of ['`.agents/**`', '`.claude/**`', '`scripts/ralph/**`']) {
    assert.equal(prompt.includes(guarded), true, guarded);
  }
  assert.match(prompt, /COMMIT_MESSAGE/);
  assert.match(prompt, /ALREADY_FIXED/);
  // Placeholders are still substituted.
  assert.match(prompt, /Работай только над issue #71\./);
  assert.equal(prompt.includes('{issue_number}'), false);
});

test('the operator manual states that it is not the agent contract', () => {
  const operatorDoc = readFileSync(ralphOperatorDocPath, 'utf8');
  assert.match(operatorDoc, /операторская документация/);
  assert.match(operatorDoc, /\.agents\/ralph-rules\.md/);
});

test('every generated prompt protects bracketed path segments with the tools it actually has', () => {
  const rules = readFileSync(ralphRulesPath, 'utf8');
  const prompts = (config) => [
    [
      'issue review',
      buildIndependentReviewPrompt(
        config,
        { number: 71, title: 'Issue', body: 'Body.' },
        'a'.repeat(40),
      ),
    ],
    [
      'milestone review',
      buildMilestoneReviewPrompt(
        { ...config, baseBranch: 'master', branch: 'features/profile-phase-8' },
        { title: 'Phase 8', description: 'Description.' },
        { number: 61, url: 'https://example/61', headRefOid: 'b'.repeat(40) },
      ),
    ],
  ];

  // Сегмент обязан быть назван везде: это единственное место, где его вообще
  // объясняют. А вот способ его прочитать у ревьюеров разный, и подсказка
  // обязана совпадать с тем набором инструментов, который роль получила.
  assert.match(rules, /-LiteralPath/, 'rules must require -LiteralPath');
  assert.match(rules, /\[id\]/, 'rules must name the wildcard-prone segment');
  for (const [label, text] of prompts({ agentCli: 'codex' })) {
    // Подсказка про PowerShell уместна только на Windows: на других системах
    // роль получает нейтральный текст, но сегмент в скобках назван всегда.
    if (process.platform === 'win32') {
      assert.match(text, /-LiteralPath/, `${label} must require -LiteralPath`);
    } else {
      assert.doesNotMatch(text, /-LiteralPath/, `${label} must not prescribe PowerShell`);
    }
    assert.match(text, /square brackets/, `${label} must name the wildcard-prone segment`);
  }

  // Claude-ревьюер запускается с `--tools Read,Glob,Grep` и Bash не имеет:
  // инструкция про PowerShell была бы неисполнима, а защита от скобок —
  // отсутствующей.
  for (const [label, text] of prompts({ agentCli: 'claude' })) {
    assert.match(text, /square brackets/, `${label} must name the wildcard-prone segment`);
    assert.doesNotMatch(text, /-LiteralPath|rg -n/, `${label} must not prescribe a shell`);
    assert.match(text, /Grep, Glob and Read/, `${label} must name the available tools`);
    assert.match(text, /character class/, `${label} must explain the bracket hazard`);
  }

  assert.match(rules, /Get-ChildItem/);
  assert.match(rules, /Test-Path/);
  assert.match(rules, /FullName/);
});

test('a bracketed path segment is only readable through -LiteralPath on Windows', function (t) {
  if (process.platform !== 'win32') {
    t.skip('PowerShell wildcard behaviour is Windows-specific');
    return;
  }

  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-literal-path-'));
  try {
    const segment = path.join(directory, '[id]');
    mkdirSync(segment, { recursive: true });
    const file = path.join(segment, 'page.tsx');
    writeFileSync(file, 'export default function Page() {}\n', 'utf8');

    const readWithPath = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Get-Content -Path '${file}'`],
      { encoding: 'utf8' },
    );
    const readWithLiteralPath = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Get-Content -LiteralPath '${file}'`],
      { encoding: 'utf8' },
    );

    assert.match(
      readWithLiteralPath.stdout,
      /export default function Page/,
      '-LiteralPath must read the file',
    );
    assert.equal(
      /export default function Page/.test(readWithPath.stdout),
      false,
      '-Path treats [id] as a wildcard and finds nothing — this is the failure the rule prevents',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('замечания к control plane выбрасываются из ревью issue, а не только milestone', () => {
  // Агенту запрещено править .agents/**, scripts/ralph/** и AGENTS.md, поэтому
  // ревью, требующее этого, невыполнимо: следующая сессия вернёт тот же
  // результат, ревью — то же замечание.
  const scoped = scopeReviewToProduct(
    {
      verdict: 'fail',
      summary: 'Four findings.',
      findings: [
        {
          severity: 'P2',
          file: '.agents/ralph.config.json',
          line: 14,
          title: 'Budget not reverted',
        },
        { severity: 'P2', file: 'packages/example/AGENTS.md', line: 34, title: 'Rule not updated' },
        {
          severity: 'P3',
          file: 'e2e/baselines.ts',
          line: 37,
          title: 'Textual scan',
        },
      ],
    },
    'Review issue #84',
  );

  assert.deepEqual(
    scoped.findings.map((finding) => finding.file),
    ['e2e/baselines.ts'],
  );
  assert.equal(scoped.verdict, 'fail');

  // Когда продуктовых замечаний не осталось, отклонять нечего.
  const infrastructureOnly = scopeReviewToProduct(
    {
      verdict: 'fail',
      summary: 'One finding.',
      findings: [{ severity: 'P2', file: 'scripts/ralph/ralph-loop.mjs', line: 1, title: 'x' }],
    },
    'Review issue #84',
  );
  assert.equal(infrastructureOnly.verdict, 'pass');
  assert.deepEqual(infrastructureOnly.findings, []);
});

test('порог важности убирает право останавливать работу, но не сам отчёт', () => {
  const review = {
    verdict: 'fail',
    summary: 'Three findings.',
    findings: [
      { severity: 'P1', file: 'a.ts', line: 1, title: 'Real defect' },
      { severity: 'P3', file: 'b.ts', line: 2, title: 'Missing coverage' },
      { severity: 'P2', file: 'c.ts', line: 3, title: 'Hardcoded number' },
    ],
  };

  const blocking = applySeverityFloor(review, 'P1', 'Review issue #86');
  assert.deepEqual(
    blocking.findings.map((finding) => finding.severity),
    ['P1'],
  );
  assert.equal(blocking.verdict, 'fail');
  // Отброшенные не исчезают бесследно: сводка называет их число, а сами они
  // уходят в отдельное поле и печатаются в комментарии целиком.
  assert.match(blocking.summary, /2 finding\(s\) below the P1 severity floor/);
  assert.deepEqual(
    blocking.belowFloorFindings.map((finding) => finding.title),
    ['Missing coverage', 'Hardcoded number'],
  );
  const comment = formatReviewComment(blocking);
  assert.match(comment, /Below the severity floor \(not blocking\)/);
  assert.match(comment, /Missing coverage/);
  assert.match(comment, /Hardcoded number/);

  // Ничего выше порога — работать не над чем, и отклонять нечего: иначе цикл
  // крутится на замечаниях, из которых ни одно не важнее P3.
  const belowOnly = applySeverityFloor(
    { ...review, findings: review.findings.filter((finding) => finding.severity !== 'P1') },
    'P1',
  );
  assert.equal(belowOnly.verdict, 'pass');
  assert.deepEqual(belowOnly.findings, []);

  // Порог P3 пропускает все замечания.
  assert.equal(applySeverityFloor(review, 'P3').findings.length, 3);

  // Незнакомая важность считается блокирующей: молча пропустить опаснее.
  assert.equal(findingBlocks({ severity: 'critical' }, 'P1'), true);
});

test('повторное milestone-ревью сужается до новых коммитов и прежних findings', () => {
  const previousBody = '## Ralph Loop: milestone review\n\nПрежний текст ревью.';
  const prompt = buildMilestoneReviewPrompt(
    { agentCli: 'claude', baseBranch: 'master' },
    { title: 'Phase 6', description: 'Uploader identity.' },
    { number: 89, url: 'https://example.test/pull/89', headRefOid: 'b'.repeat(40) },
    {
      changes: {
        range: 'a'.repeat(40) + '...' + 'b'.repeat(40),
        commits: 'abc1234 fix: bound the variant',
        stat: ' file | 1 +',
        nameStatus: 'M\tfile',
        diff: '--- a/file',
        truncated: false,
      },
      previousReview: { head: 'a'.repeat(40), body: previousBody, hasNewCommits: true },
    },
  );

  assert.match(prompt, /already audited this pull request up to head a{40}/);
  assert.match(prompt, /covers only the commits added since that head/);
  // Прежнее ревью цитируется blockquote: голый `### Findings` из него, переехав
  // в summary нового ревью, ломал бы распознавание чистого PASS.
  assert.match(prompt, /> Прежний текст ревью\./);
  assert.match(prompt, /review the changes since the previously reviewed head/);
  assert.doesNotMatch(prompt, /review the complete current implementation/);
  assert.match(prompt, /Use the change inventory above as evidence/);
  assert.doesNotMatch(prompt, /branch diff against master as evidence/);
  assert.match(prompt, /handled outside this review/);
});

test('повторное milestone-ревью того же head обходится без инвентаря', () => {
  const prompt = buildMilestoneReviewPrompt(
    { agentCli: 'claude', baseBranch: 'master' },
    { title: 'Phase 6', description: 'Uploader identity.' },
    { number: 89, url: 'https://example.test/pull/89', headRefOid: 'b'.repeat(40) },
    {
      changes: null,
      previousReview: { head: 'b'.repeat(40), body: 'Тот же head.', hasNewCommits: false },
    },
  );

  assert.match(prompt, /No commits were added since that head/);
  assert.doesNotMatch(prompt, /```diff/);
  // Без новых коммитов prompt не имеет права ссылаться на инвентарь, которого
  // нет, и требовать аудита несуществующих изменений.
  assert.doesNotMatch(prompt, /Use the change inventory above/);
  assert.doesNotMatch(prompt, /Audit the new changes in full/);
  assert.match(prompt, /verify the resolution of every finding of the previous review/);
});

test('shell-подсказка ревью не обещает PowerShell на чужой платформе', () => {
  // Подсказка выбиралась только по CLI агента, а ревьюер запускается на машине
  // оператора. На Linux и macOS Codex получал утверждение про Windows-хост и
  // флаг, которого в его оболочке нет.
  const codex = { agentCli: 'codex' };

  assert.match(reviewShellGuidance(codex, 'win32'), /-LiteralPath/u);
  const posix = reviewShellGuidance(codex, 'linux');
  assert.doesNotMatch(posix, /PowerShell|-LiteralPath/u);
  assert.match(posix, /square brackets/u);

  // У роли Claude оболочки нет вовсе: её подсказка от платформы не зависит.
  const claude = { agentCli: 'claude' };
  assert.equal(reviewShellGuidance(claude, 'linux'), reviewShellGuidance(claude, 'win32'));
});
