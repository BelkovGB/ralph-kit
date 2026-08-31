import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { reasoningEffortsFor } from './ralph-agent-backends.mjs';
import { fieldGroups } from './ralph-gui-fields.mjs';
import { developmentCodexArguments } from './ralph-codex-session.mjs';
import {
  agentInstructionFiles,
  agentSkillFiles,
  loadConfig,
  parseSkillFrontmatter,
  verifyAgentSkills,
} from './ralph-config.mjs';
import {
  failingScriptOutput,
  formatFailureSummary,
  recoveryPrompt,
  summarizeCommandFailure,
  uniqueFailedTests,
} from './ralph-failure-summary.mjs';
import {
  baseForNextSession,
  committedRecoveryPhases,
  recoverHostValidationMutation,
} from './ralph-loop.mjs';
import {
  alreadyFixedCommitFromAgent,
  filesChangedBetween,
  isAncestorCommit,
  issueChangeInventory,
  linkedCommitForIssue,
  pushBranchAndVerify,
  syncPhaseBranchWithBase,
  verifyConfiguredGitHubOrigin,
  workingTreeEntries,
  workingTreePaths,
} from './ralph-git.mjs';
import {
  issueBodyWithReviewContext,
  issueBodyWithoutRalphMetadata,
  issueCompletionState,
  normalizeReviewResult,
  reviewContextFromIssueBody,
} from './ralph-issue-contract.mjs';
import {
  createOrReopenReviewIssues,
  deferredFindingFingerprint,
  deferredFindingMarker,
  groupFindingsIntoBatches,
  lastPublishedMilestoneReview,
  limitMilestoneReviewFindings,
  milestonePartialCoverageMarker,
  milestonePassReviewIsClean,
  milestoneReviewMarker,
  recordDeferredFindings,
  reviewFindingFingerprint,
  reviewFindingMarker,
} from './ralph-milestone-review.mjs';
import { reopenIssueWithComment, verifyRepositoryWriteAccess } from './ralph-github-client.mjs';
import { ralphConfigPath, withPatchedRalphConfig } from './ralph-test-support.mjs';

test('finding fingerprint is stable for Unicode titles and changes with location', () => {
  const pullRequest = { number: 61 };
  const finding = {
    severity: 'P1',
    title: 'Обработать ошибку reconciliation',
    file: 'src/service.ts',
  };

  const first = reviewFindingFingerprint(pullRequest, finding);
  const equivalent = reviewFindingFingerprint(pullRequest, {
    ...finding,
    title: 'ОБРАБОТАТЬ   ОШИБКУ — reconciliation!',
  });
  const anotherFile = reviewFindingFingerprint(pullRequest, {
    ...finding,
    file: 'src/other.ts',
  });

  assert.equal(first, equivalent);
  assert.notEqual(first, anotherFile);
});

test('review findings create, reuse, and reopen milestone issues without duplicates', () => {
  const config = { milestone: 'Test milestone' };
  const milestone = { number: 7, title: 'Test milestone' };
  const pullRequest = { number: 61, headRefOid: 'head-1' };
  const findings = [
    { severity: 'P1', title: 'Open finding', body: 'open', file: 'open.ts', line: 1 },
    { severity: 'P2', title: 'Closed finding', body: 'closed', file: 'closed.ts', line: 2 },
    { severity: 'P2', title: 'New finding', body: 'new', file: 'new.ts', line: 3 },
  ];
  const existing = [
    {
      number: 1,
      state: 'OPEN',
      body: reviewFindingMarker(pullRequest, findings[0]),
    },
    {
      number: 2,
      state: 'CLOSED',
      body: reviewFindingMarker(pullRequest, findings[1]),
    },
  ];
  const created = [];
  const updated = [];
  const reopened = [];

  const queued = createOrReopenReviewIssues(
    config,
    'owner/repository',
    milestone,
    pullRequest,
    { verdict: 'fail', findings: [...findings, findings[0]] },
    {
      milestoneIssues: () => existing,
      // Дублёр получает группу замечаний, а не одно: тело задачи несёт по
      // маркеру на каждое, иначе дедупликация следующего раунда их не найдёт.
      createReviewFindingIssue: (_config, _repository, _milestone, _pr, batch) => {
        const issue = {
          number: 3,
          state: 'OPEN',
          body: batch.map((finding) => reviewFindingMarker(pullRequest, finding)).join('\n'),
        };
        created.push(issue.number);
        return issue;
      },
      updateReviewFindingIssue: (_config, _repository, issue) => updated.push(issue.number),
      reopenReviewFindingIssue: (_repository, issue) => reopened.push(issue.number),
    },
  );

  assert.deepEqual(
    queued.map((issue) => issue.number),
    [1, 2, 3],
  );
  assert.deepEqual(created, [3]);
  // Повторно пришедшее замечание попадает в свою же группу, а не обрабатывается
  // вторым проходом: иначе та же задача обновляется дважды подряд.
  assert.deepEqual(updated, [1, 2]);
  assert.deepEqual(reopened, [2]);
});

test('findings are batched by file and severity band, not one issue each', () => {
  const findings = [
    { severity: 'P1', title: 'Focus jumps', file: 'form.tsx', line: 106, body: 'a' },
    { severity: 'P2', title: 'Empty password', file: 'form.tsx', line: 32, body: 'b' },
    { severity: 'P3', title: 'Not announced', file: 'form.tsx', line: 241, body: 'c' },
    { severity: 'P3', title: 'Baselines committed', file: 'spec.ts', line: 621, body: 'd' },
  ];

  const batches = groupFindingsIntoBatches(findings);

  // Три задачи вместо четырёх: P2 и P3 одного файла чинятся за один заход.
  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches.map((batch) => batch.map((finding) => finding.title)),
    [['Focus jumps'], ['Empty password', 'Not announced'], ['Baselines committed']],
  );

  // Полоса важности разделяет намеренно: задача закрывается целиком, и P3, не
  // прошедший ревью, держал бы открытым уже исправленный P1.
  assert.equal(batches[0][0].severity, 'P1');

  // Размер ограничен, иначе задача перестаёт быть обозримой на ревью.
  const many = Array.from({ length: 7 }, (_, index) => ({
    severity: 'P3',
    title: `finding ${index}`,
    file: 'form.tsx',
    line: index,
    body: 'x',
  }));
  assert.deepEqual(
    groupFindingsIntoBatches(many).map((batch) => batch.length),
    [5, 2],
  );
});

test('issue review context is replaced instead of growing on every retry', () => {
  const first = issueBodyWithReviewContext(
    { body: 'Original requirements' },
    {
      summary: 'First review',
      findings: [
        { severity: 'P1', title: 'First finding', file: 'first.ts', line: 1, body: 'Fix first' },
      ],
    },
  );
  const second = issueBodyWithReviewContext(
    { body: first },
    {
      summary: 'Second review',
      findings: [
        { severity: 'P2', title: 'Second finding', file: 'second.ts', line: 2, body: 'Fix second' },
      ],
    },
  );

  assert.match(second, /^Original requirements/);
  assert.doesNotMatch(second, /First review|First finding/);
  assert.match(second, /Second review/);
  assert.equal(second.match(/ralph-issue-review-context:start/g)?.length, 1);
});

test('after a rejected review the retry is told the work is already committed', () => {
  const commit = 'a'.repeat(40);
  const prompt = recoveryPrompt({
    phase: 'review-failed',
    commit,
    startingCommit: commit,
    lastFailure: null,
  });

  assert.match(prompt, new RegExp(`HEAD уже содержит commit ${commit}`));
  assert.match(prompt, /не переделывай реализацию заново/);
  // Сбоя не было: обычная формулировка восстановления здесь врала бы.
  assert.doesNotMatch(prompt, /исправь последний сбой/);
  assert.doesNotMatch(prompt, /процесс завершился до фиксации результата/);

  // Замечания в prompt не копируются: их несёт тело issue, которое и так
  // подставляется целиком.
  assert.doesNotMatch(prompt, /Location:/);
});

test('the failure excerpt comes from the script that failed, not the one before it', () => {
  const output = [
    'RALPH_VALIDATION_SCRIPT=npm run lint',
    'PASS test/example.e2e-spec.ts',
    'Tests:       158 passed, 158 total',
    'RALPH_VALIDATION_SCRIPT=npm test',
    'Error: expect(page).toHaveURL(expected) failed',
    '  1) [desktop-chromium] › e2e/profile.spec.ts:849:5 › resumed page returns to sign-in',
  ].join('\n');

  const scoped = failingScriptOutput(output, 'npm test');
  assert.match(scoped, /toHaveURL/);
  // Хвост предыдущей, успешной команды в отчёт попадать не должен: иначе про
  // упавшую команду показываются строки PASS от предыдущей.
  assert.doesNotMatch(scoped, /158 passed/);
  assert.doesNotMatch(scoped, /RALPH_VALIDATION_SCRIPT/);

  // Маркеры разошлись с атрибуцией ошибки — показываем всё, а не чужой кусок.
  assert.equal(failingScriptOutput(output, 'lint'), stripAnsiForTest(output));
  assert.equal(failingScriptOutput('без маркеров', 'lint'), 'без маркеров');
});

function stripAnsiForTest(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

test('a branch that moved on is judged by ancestry, not by an exact HEAD match', () => {
  const calls = [];
  const run = (_name, args) => {
    calls.push(args.join(' '));
    return { status: args.includes('--is-ancestor') && args[2] === 'old' ? 0 : 1 };
  };

  // Коммит Ralph остался предком: ветка просто ушла вперёд, и продолжать можно.
  assert.equal(isAncestorCommit('old', 'new', run), true);
  assert.equal(calls.at(-1), 'merge-base --is-ancestor old new');

  // Чужая история — не продолжение: здесь отказ остаётся правильным ответом.
  assert.equal(isAncestorCommit('other', 'new', run), false);
  // Отсутствующий commit не должен превращаться в вызов git с undefined.
  assert.equal(isAncestorCommit(null, 'new', run), false);
  assert.equal(isAncestorCommit('old', undefined, run), false);
  assert.equal(calls.length, 2);
});

test('the moved-branch check tells apart untouched files from contested ones', () => {
  const run = (_name, args) => {
    if (args[0] === 'diff' && args[1] === '--name-only') {
      return { status: 0, stdout: 'scripts/ralph/ralph-loop.mjs\nAGENTS.md' };
    }
    return { status: 1, stdout: '' };
  };

  // Оператор правил control plane, агент правит спеку: пересечения нет.
  assert.deepEqual(filesChangedBetween('old', 'new', run), [
    'scripts/ralph/ralph-loop.mjs',
    'AGENTS.md',
  ]);
  // Недостижимая база — не список из одного пустого элемента, а null: вызвавший
  // обязан отличить «ничего не изменилось» от «сравнить не удалось».
  assert.equal(
    filesChangedBetween('old', 'new', () => ({ status: 128, stdout: '' })),
    null,
  );
});

test('a rejected review never resumes without a new agent session', () => {
  // На фазе review-failed commit существует, и попадание её в этот список
  // означало бы бесконечный повтор того же ревью над тем же деревом.
  assert.equal(committedRecoveryPhases.includes('review-failed'), false);
  assert.deepEqual(committedRecoveryPhases, ['committed', 'pushed', 'reviewing', 'closing']);
  // `closing` наступает после PASS: прогон, упавший на закрытии issue, обязан
  // продолжиться без новой сессии агента, иначе работа делается заново.
  assert.equal(committedRecoveryPhases.includes('closing'), true);
});

test('review context is separable from the issue body so the next review can be asked about it', () => {
  const body = issueBodyWithReviewContext(
    { body: 'Original requirements' },
    {
      summary: 'Review summary',
      findings: [
        { severity: 'P2', title: 'Missing guard', file: 'guard.ts', line: 7, body: 'Add it' },
      ],
    },
  );

  const findings = reviewContextFromIssueBody({ body });
  assert.match(findings, /Missing guard/);
  assert.doesNotMatch(findings, /ralph-issue-review-context/);
  // Тело без метаданных не должно повторять тот же блок: иначе замечания
  // приезжают в prompt дважды и оба раза без подписи.
  assert.equal(issueBodyWithoutRalphMetadata({ body }), 'Original requirements');
  assert.equal(reviewContextFromIssueBody({ body: 'Original requirements' }), null);
});

function inventoryRunner(commits) {
  const calls = [];
  const run = (_name, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'log') return { status: 0, stdout: commits.join('\n') };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'd'.repeat(40) };
    if (args.includes('--name-status')) return { stdout: 'M\tsrc/items.ts' };
    if (args.includes('--stat')) return { stdout: ' src/items.ts | 4 +++-' };
    return { stdout: 'x'.repeat(70_000) };
  };

  return { calls, run };
}

test('the change inventory reads one commit through show and marks an oversized diff', () => {
  const commit = 'a'.repeat(40);
  const { calls, run } = inventoryRunner([commit]);

  const inventory = issueChangeInventory({ number: 57 }, commit, {
    run,
    excludedPaths: ['dependencies.lock'],
  });

  assert.equal(inventory.truncated, true);
  assert.equal(inventory.diff.length, 60_000);
  assert.match(inventory.nameStatus, /src\/items\.ts/);
  assert.deepEqual(inventory.commits, [commit]);
  // У `git show` нет особого случая для корневого commit, в отличие от
  // `commit^..commit`, поэтому одиночный commit читается именно так.
  assert.equal(calls.filter((call) => call.startsWith('show --format=')).length, 3);
  assert.ok(!calls.some((call) => call.startsWith('rev-parse')));
  // Исключённый путь убирается только из построчного diff и остаётся в списке файлов.
  assert.ok(calls.some((call) => call.includes(':(exclude)dependencies.lock')));
});

test('a second iteration shows the issue commits only, not the range between them', () => {
  const newest = 'b'.repeat(40);
  const oldest = 'c'.repeat(40);
  const { calls, run } = inventoryRunner([newest, oldest]);

  const inventory = issueChangeInventory({ number: 57 }, newest, { run });

  assert.deepEqual(inventory.commits, [newest, oldest]);
  // Диапазон `oldest^..newest` втянул бы всё, что легло в ветку между ними,
  // включая чужие правки control plane.
  assert.ok(!calls.some((call) => call.startsWith('rev-parse')));
  assert.ok(!calls.some((call) => call.startsWith('diff ')));
  // Оба commit перечислены в хронологическом порядке в одном вызове.
  assert.equal(
    calls.filter((call) => call.includes(`${oldest} ${newest}`)).length,
    3,
    'ожидались три вызова show с обоими commit',
  );
});

test('a completion marker left by an older Ralph is read and then stripped', () => {
  const commit = 'a'.repeat(40);
  // Литерал, а не вызов форматтера: этот маркер Ralph не пишет, а тест обязан
  // проверять именно тот текст, который лежит в issue от прежних прогонов.
  const staleBody = `Original requirements\n\n<!-- ralph-issue-completion status:pending-review commit:${commit} -->`;

  assert.deepEqual(issueCompletionState({ body: staleBody }), {
    status: 'pending-review',
    commit,
  });

  const retryBody = issueBodyWithReviewContext(
    { body: staleBody },
    {
      summary: 'Needs another fix',
      findings: [{ severity: 'P1', title: 'Finding', file: 'file.ts', line: 1, body: 'Fix it' }],
    },
  );
  assert.equal(issueCompletionState({ body: retryBody }), null);
  assert.doesNotMatch(retryBody, /ralph-issue-completion/);
  assert.match(retryBody, /^Original requirements/);
});

test('already-fixed marker accepts a commit SHA only on its own final line', () => {
  assert.equal(
    alreadyFixedCommitFromAgent(`Checks passed.\n\nALREADY_FIXED: ${'c'.repeat(40)}`),
    'c'.repeat(40),
  );
  assert.equal(alreadyFixedCommitFromAgent('ALREADY_FIXED: not-a-sha'), null);
  assert.equal(alreadyFixedCommitFromAgent(`ALREADY_FIXED: ${'d'.repeat(40)}\nMore text`), null);
  assert.equal(alreadyFixedCommitFromAgent(undefined), null);
});

test('fresh Ralph-Issue trailer links an existing commit without another Terra run', () => {
  const commit = 'a'.repeat(40);
  const commands = [];
  const execute = (_command, args) => {
    commands.push(args);
    if (args[0] === 'log') {
      return { status: 0, stdout: `${commit}\t2026-08-14T12:39:45+03:00` };
    }
    return { status: 0, stdout: '#64' };
  };

  assert.equal(
    linkedCommitForIssue({ number: 64, updatedAt: '2026-08-14T09:31:03Z' }, execute),
    commit,
  );
  assert.deepEqual(commands[0].slice(-3), ['--grep', 'Ralph-Issue: #64', 'HEAD']);
});

test('Ralph-Issue trailer older than the latest issue update is not reused', () => {
  const execute = (_command, args) => ({
    status: 0,
    stdout: args[0] === 'log' ? `${'b'.repeat(40)}\t2026-08-14T09:00:00Z` : '#64',
  });

  assert.equal(
    linkedCommitForIssue({ number: 64, updatedAt: '2026-08-14T09:31:03Z' }, execute),
    null,
  );
  assert.equal(linkedCommitForIssue({ number: 64 }, execute), null);
});

test('review result invariants reject empty FAIL and convert PASS with findings', () => {
  assert.throws(
    () => normalizeReviewResult({ verdict: 'fail', summary: 'broken', findings: [] }),
    /FAIL without actionable findings/,
  );

  const normalized = normalizeReviewResult({
    verdict: 'pass',
    summary: 'inconsistent',
    findings: [{ severity: 'P1', title: 'Bug', body: 'Fix it', file: 'file.ts', line: 1 }],
  });
  assert.equal(normalized.verdict, 'fail');
  assert.equal(normalized.findings.length, 1);
  assert.match(normalized.summary, /treated the result as FAIL/);
});

test('milestone findings are deduplicated, prioritized, and bounded', () => {
  const pullRequest = { number: 61 };
  const findings = Array.from({ length: 12 }, (_, index) => ({
    severity: index === 11 ? 'P0' : index >= 8 ? 'P1' : 'P2',
    title: `Finding ${index}`,
    body: `Body ${index}`,
    file: `file-${index}.ts`,
    line: index + 1,
  }));
  findings.push({ ...findings[11] });

  const limited = limitMilestoneReviewFindings(
    { verdict: 'fail', summary: 'Review summary.', findings },
    pullRequest,
    10,
  );

  assert.equal(limited.findings.length, 10);
  assert.equal(limited.findings[0].severity, 'P0');
  assert.deepEqual(
    limited.findings.slice(1, 4).map((finding) => finding.severity),
    ['P1', 'P1', 'P1'],
  );
  assert.equal(limited.findings.filter((finding) => finding.title === 'Finding 11').length, 1);
  assert.match(limited.summary, /2 findings were deferred/);
});

test('skill frontmatter parser accepts valid YAML and reports tab-separated fields', () => {
  const valid = parseSkillFrontmatter(
    '---\r\nname: read\r\ndescription: Читай файл эффективно\r\n---\r\n# Read File\r\n',
  );
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.fields.get('name'), 'read');
  assert.equal(valid.fields.get('description'), 'Читай файл эффективно');

  const tabSeparated = parseSkillFrontmatter('---\nname\tread\ndescription\tЧитай\n---\n# Read\n');
  assert.equal(tabSeparated.errors.length, 2);
  assert.match(tabSeparated.errors[0], /строка 2: поле "name" отделено табуляцией/);
  assert.match(tabSeparated.errors[1], /строка 3: поле "description" отделено табуляцией/);
});

test('skill frontmatter parser rejects missing, empty, and unterminated frontmatter', () => {
  assert.deepEqual(parseSkillFrontmatter('# Read File\n').errors, [
    'файл должен начинаться со строки `---`',
  ]);
  assert.deepEqual(parseSkillFrontmatter('---\nname: read\n').errors, [
    'frontmatter не закрыт строкой `---`',
  ]);
  assert.deepEqual(parseSkillFrontmatter('---\nname: read\ndescription:\n---\n').errors, [
    'поле "description" пустое',
  ]);
  assert.deepEqual(parseSkillFrontmatter('---\nname: read\n---\n').errors, [
    'отсутствует обязательное поле "description"',
  ]);
});

test('skill frontmatter parser keeps multi-line values and quoted descriptions valid', () => {
  const folded = parseSkillFrontmatter(
    '---\nname: ui-ux-pro-max\ndescription: >-\n  UI/UX design intelligence\n  for web and mobile.\n---\n',
  );
  assert.deepEqual(folded.errors, []);
  // Собирается именно текст, а не индикатор: пара скиллов сверяется по
  // значению поля, и два разных `>-` сошлись бы как одинаковые.
  assert.equal(folded.fields.get('description'), 'UI/UX design intelligence for web and mobile.');

  const literal = parseSkillFrontmatter(
    '---\nname: read\ndescription: |\n  Первая\n  Вторая\n---\n',
  );
  assert.deepEqual(literal.errors, []);
  assert.equal(literal.fields.get('description'), 'Первая\nВторая');

  const indicatorOnly = parseSkillFrontmatter('---\nname: read\ndescription: >-\n---\n');
  assert.deepEqual(indicatorOnly.errors, ['поле "description" пустое']);

  const quoted = parseSkillFrontmatter(
    '---\nname: prd\ndescription: "Создаю PRD: документ"\n---\n',
  );
  assert.deepEqual(quoted.errors, []);
  assert.equal(quoted.fields.get('description'), '"Создаю PRD: документ"');
});

test('every project-local SKILL.md exposes loadable frontmatter', () => {
  // Installed skills are gitignored, so a clean checkout legitimately has fewer.
  // The assertion is "whatever is present must load", not "skills must exist".
  const files = agentSkillFiles();
  for (const file of files) {
    const { errors } = parseSkillFrontmatter(readFileSync(file, 'utf8'));
    assert.deepEqual(errors, [], `${file}: ${errors.join('; ')}`);
  }
  assert.doesNotThrow(() => verifyAgentSkills());
});

test('a skill body in .agents is mirrored by a link in .claude', () => {
  // Claude Code loads skills from `.claude/skills`, Codex from
  // `.agents/skills`. A skill that lives only in `.claude` is legitimate: it
  // may need what Codex has not. A body with no link is not: the command
  // disappears from Claude Code, and nothing reports it. Frontmatter decides
  // whether the model raises the skill, so the pair must read identically.
  const skillsByDirectory = (root) =>
    new Map(
      agentSkillFiles()
        .filter((file) => file.split(path.sep).includes(root))
        .map((file) => [path.basename(path.dirname(file)), file]),
    );
  const bodies = skillsByDirectory('.agents');
  const links = skillsByDirectory('.claude');
  // Without this the loop below would pass on an empty checkout.
  assert.notEqual(bodies.size, 0, '.agents/skills holds no SKILL.md');

  for (const [skill, body] of bodies) {
    const link = links.get(skill);
    assert.ok(link, `${skill}: body in .agents/skills has no link in .claude/skills`);
    const bodyFields = parseSkillFrontmatter(readFileSync(body, 'utf8')).fields;
    const linkFields = parseSkillFrontmatter(readFileSync(link, 'utf8')).fields;
    for (const field of ['name', 'description']) {
      assert.equal(linkFields.get(field), bodyFields.get(field), `${skill}: ${field} differs`);
    }
  }
});

// Пульт ставится не в каждую копию набора: без его модуля справочник команд
// сверять не с чем.
const guiPagePath = fileURLToPath(new URL('./ralph-gui-page.mjs', import.meta.url));
const reviewersPath = fileURLToPath(new URL('../../.claude/agents', import.meta.url));
const reviewSkillPath = fileURLToPath(
  new URL('../../.agents/skills/review-all/SKILL.md', import.meta.url),
);

test(
  'the console command guide names a real skill',
  { skip: !existsSync(guiPagePath) },
  async () => {
    // Справочник пульта — константа модуля, скиллы — каталоги на диске.
    // Переименование каталога оставляет на пульте команду, которой больше нет,
    // и ни одна другая проверка её не открывает.
    const { commandGuide } = await import('./ralph-gui-page.mjs');
    const listed = commandGuide
      .flatMap((group) => group.items)
      .map((item) => /^\/([\w-]+)/.exec(item.command)?.[1])
      .filter(Boolean);
    const bodies = agentSkillFiles()
      .filter((file) => file.split(path.sep).includes('.agents'))
      .map((file) => path.basename(path.dirname(file)));

    assert.deepEqual(listed.sort(), bodies.sort());
  },
);

test(
  'every reviewer is named by its file and reachable from the skill',
  { skip: !existsSync(reviewersPath) || !existsSync(reviewSkillPath) },
  () => {
    // Субагента запускают по полю `name`, а скилл называет его файлом. Пока имя
    // файла и поле совпадают, обе ссылки ведут в одно место; разойдутся —
    // запуск по имени агента не найдёт, и в логе останется одна строка.
    const files = readdirSync(reviewersPath).filter((name) => name.endsWith('.md'));
    assert.notEqual(files.length, 0, '.claude/agents holds no reviewer');

    for (const file of files) {
      const { fields, errors } = parseSkillFrontmatter(
        readFileSync(path.join(reviewersPath, file), 'utf8'),
      );
      assert.deepEqual(errors, [], `${file}: ${errors.join('; ')}`);
      assert.equal(fields.get('name'), path.basename(file, '.md'), `${file}: name differs`);
    }

    const skill = readFileSync(reviewSkillPath, 'utf8');
    const mentioned = [...skill.matchAll(/\.claude\/agents\/([\w-]+)\.md/g)].map((hit) => hit[1]);
    assert.notEqual(mentioned.length, 0, 'review-all names no reviewer file');
    for (const name of mentioned) {
      assert.ok(files.includes(`${name}.md`), `${name}: review-all points at a missing file`);
      assert.ok(skill.includes(`\`${name}\``), `${name}: review-all never names the subagent`);
    }
  },
);

test('skills of both CLI conventions are discovered, not just one', () => {
  // Codex reads `.agents/skills`, Claude Code reads `.claude/skills`. Checking
  // only one leaves the other's broken frontmatter to be discovered at runtime,
  // where a skill that fails to load is only a line in the log.
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-skills-'));
  try {
    for (const [root, skill] of [
      ['.agents', 'codex-side'],
      ['.claude', 'claude-side'],
    ]) {
      mkdirSync(path.join(directory, root, 'skills', skill), { recursive: true });
      writeFileSync(
        path.join(directory, root, 'skills', skill, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: d\n---\n`,
        'utf8',
      );
    }

    const found = agentSkillFiles([
      path.join(directory, '.agents', 'skills'),
      path.join(directory, '.claude', 'skills'),
    ]).map((file) => path.relative(directory, file).split(path.sep).join('/'));

    assert.deepEqual(found, [
      '.agents/skills/codex-side/SKILL.md',
      '.claude/skills/claude-side/SKILL.md',
    ]);
    // Отсутствующий каталог — норма, а не ошибка: у проекта может не быть
    // скиллов одного из CLI.
    assert.deepEqual(agentSkillFiles([path.join(directory, 'nowhere')]), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('skill preflight fails with every invalid skill listed at once', () => {
  const contents = new Map([
    [path.join('a', 'SKILL.md'), '---\nname\ta\ndescription\tbroken\n---\n'],
    [path.join('b', 'SKILL.md'), '---\nname: b\ndescription: fine\n---\n'],
    [path.join('c', 'SKILL.md'), '# no frontmatter\n'],
  ]);
  assert.throws(
    () =>
      verifyAgentSkills({
        files: [...contents.keys()],
        readFile: (file) => contents.get(file),
      }),
    (error) => {
      assert.match(error.message, /Невалидный frontmatter project-local skills/);
      assert.match(error.message, /отделено табуляцией/);
      assert.match(error.message, /должен начинаться со строки/);
      assert.equal(/SKILL\.md:/g.test(error.message), true);
      assert.equal(error.message.includes(path.join('b', 'SKILL.md')), false);
      return true;
    },
  );
});

test('development codex arguments carry an explicit reasoning effort', () => {
  const args = developmentCodexArguments({
    developmentModel: 'gpt-5.6-terra',
    developmentEffort: 'medium',
  });
  const effortIndex = args.indexOf('-c');
  assert.notEqual(effortIndex, -1);
  assert.equal(args[effortIndex + 1], 'model_reasoning_effort="medium"');
  assert.ok(effortIndex > args.indexOf('--model'));
  assert.equal(args.at(-1), '-');
});

test('the committed configuration sets an explicit effort valid for its agentCli', () => {
  // Проверяется свойство, а не конкретные значения: усилие задано явно и
  // допустимо для выбранного CLI, поэтому смена CLI или модели оператором не
  // роняет ворота валидации продукта.
  const config = loadConfig();
  const allowed = reasoningEffortsFor(config.agentCli);
  assert.equal(allowed.length > 0, true, config.agentCli);
  for (const [role, effort] of [
    ['developmentEffort', config.developmentEffort],
    ['review.effort', config.review.effort],
    ['milestoneReview.effort', config.milestoneReview.effort],
  ]) {
    assert.equal(allowed.includes(effort), true, `${role}=${effort}`);
  }
});

test('GitHub account is configurable and exposed in the GUI', () => {
  const config = loadConfig();
  const githubAccountField = fieldGroups
    .flatMap((group) => group.fields)
    .find((field) => field.path === 'githubAccount');

  assert.equal(config.githubAccount, null);
  assert.equal(githubAccountField?.type, 'text');
  assert.equal(githubAccountField?.emptyAsNull, true);
  withPatchedRalphConfig({ githubAccount: 'owner-bot' }, (configuredAccount) => {
    assert.equal(configuredAccount.githubAccount, 'owner-bot');
  });
  assert.throws(
    () =>
      withPatchedRalphConfig({ githubAccount: 'login with spaces' }, () => {
        throw new Error('loadConfig should have failed');
      }),
    /githubAccount.*GitHub login/u,
  );
  withPatchedRalphConfig({ githubAccount: undefined }, (withoutAccount) => {
    assert.equal(withoutAccount.githubAccount, null);
  });
  withPatchedRalphConfig({ githubAccount: '' }, (emptyAccount) => {
    assert.equal(emptyAccount.githubAccount, null);
  });
});

test('configured GitHub account requires an HTTPS GitHub origin', () => {
  const config = { githubAccount: 'codex-ai-Goo' };
  const executeWith = (origin) => () => ({ stdout: origin });

  const pinned = verifyConfiguredGitHubOrigin(config, {
    run: executeWith('https://github.com/BelkovGB/letofest.git'),
  });
  assert.equal(pinned, 'https://github.com/BelkovGB/letofest.git');
  assert.equal(config.githubRemoteUrl, pinned);
  for (const origin of [
    'git@github.com:BelkovGB/letofest.git',
    'https://example.test/BelkovGB/letofest.git',
    'https://token@github.com/BelkovGB/letofest.git',
  ]) {
    assert.throws(() => verifyConfiguredGitHubOrigin(config, { run: executeWith(origin) }), (error) => {
      assert.match(error.message, /origin должен быть HTTPS-адресом GitHub/u);
      assert.equal(error.message.includes(origin), false);
      assert.equal(error.message.includes('token@'), false);
      return true;
    });
  }
  assert.equal(
    verifyConfiguredGitHubOrigin(
      { githubAccount: null },
      { run: () => assert.fail('origin не нужен без выбранного аккаунта') },
    ),
    null,
  );
});

test('authenticated push disables repository hooks', () => {
  const calls = [];
  const verified = [];
  const head = 'a'.repeat(40);
  const result = pushBranchAndVerify(
    {
      branch: 'ralph/phase-1',
      githubAccount: 'codex-ai-Goo',
      githubRemoteUrl: 'https://github.com/owner/repository.git',
    },
    {
      run: () => ({ stdout: head }),
      runNetwork: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: '' };
      },
      verifyPushedHead: (_config, expectedHead) => {
        verified.push(expectedHead);
        return expectedHead;
      },
    },
  );

  assert.deepEqual(calls[0].args, [
    'push',
    '--no-verify',
    'https://github.com/owner/repository.git',
    'HEAD:refs/heads/ralph/phase-1',
  ]);
  assert.equal(calls[0].options.echoOutput, true);
  assert.deepEqual(verified, [head]);
  assert.equal(result, head);
});

test('push keeps repository hooks without a configured GitHub account', () => {
  const calls = [];
  const head = 'b'.repeat(40);

  pushBranchAndVerify(
    { branch: 'ralph/phase-1', githubAccount: null },
    {
      run: () => ({ stdout: head }),
      runNetwork: (_command, args) => {
        calls.push(args);
        return { status: 0, stdout: '' };
      },
      verifyPushedHead: () => head,
    },
  );

  assert.deepEqual(calls[0], [
    'push',
    '--set-upstream',
    'origin',
    'ralph/phase-1',
  ]);
});

test('reasoning effort falls back to medium/medium/high when the config omits it', () => {
  const original = JSON.parse(readFileSync(ralphConfigPath, 'utf8'));
  const { effort: _review, ...review } = original.review;
  const { effort: _milestone, ...milestoneReview } = original.milestoneReview;

  // Значения по умолчанию записаны здесь потому, что проверяются именно они:
  // все три поля из конфигурации убраны, и она до результата не дотягивается.
  //
  // Поле верхнего уровня убирается значением `undefined`, а не копией конфига
  // без него: правка накладывается на файл проекта, и ключ, которого в правке
  // нет, остаётся из файла. Копия без ключа поэтому проверяла бы не умолчание, а
  // настройку проекта — в проекте с `developmentEffort: "high"` тест падал.
  withPatchedRalphConfig({ developmentEffort: undefined, review, milestoneReview }, (config) => {
    assert.equal(config.developmentEffort, 'medium');
    assert.equal(config.review.effort, 'medium');
    assert.equal(config.milestoneReview.effort, 'high');
  });
});

test('preflight stops when the active GitHub account cannot write to the repository', () => {
  // `gh auth status` завершается нулём при любом залогиненном аккаунте, поэтому
  // без этой проверки отказ приходит на push — после работы агента и создания
  // commit.
  const calls = [];
  const runNetwork = (command, args, options) => {
    calls.push(args.join(' '));
    if (args.includes('user')) return { status: 0, stdout: 'read-only-bot' };
    void options;
    return { status: 0, stdout: '{"admin":false,"pull":true,"push":false}' };
  };

  assert.throws(
    () => verifyRepositoryWriteAccess('owner/repository', { runNetwork }),
    (error) => {
      assert.match(error.message, /read-only-bot/);
      assert.match(error.message, /не имеет права записи в owner\/repository/);
      return true;
    },
  );
  assert.equal(calls[0], 'api repos/owner/repository --jq .permissions');

  const writable = verifyRepositoryWriteAccess('owner/repository', {
    runNetwork: () => ({ status: 0, stdout: '{"push":true}' }),
  });
  assert.equal(writable.push, true);
});

test('a runtime field the code does not read is rejected, not ignored', () => {
  // Без этой проверки неизвестное поле правилось бы без всякого эффекта: ключ
  // codexTimeoutMs выглядит настройкой таймаута сессии, а код читает
  // agentTimeoutMs.
  const original = JSON.parse(readFileSync(ralphConfigPath, 'utf8'));
  assert.throws(
    () =>
      withPatchedRalphConfig(
        { runtime: { ...original.runtime, codexTimeoutMs: 5_400_000 } },
        () => {
          throw new Error('loadConfig should have failed');
        },
      ),
    /Неизвестные поля в "runtime": codexTimeoutMs/,
  );
});

test('a top-level field the code does not read is rejected, not ignored', () => {
  // Поставляемый конфиг обязан пройти проверку: список допустимых ключей собран
  // по коду, и разойтись с файлом он не должен.
  assert.equal(typeof loadConfig().prompt, 'string');

  // Опечатка в имени ключа иначе проходит молча: настройка берёт значение по
  // умолчанию, а человек считает, что задал своё.
  assert.throws(
    () =>
      withPatchedRalphConfig({ maxIteration: 5 }, () => {
        throw new Error('loadConfig should have failed');
      }),
    /Неизвестные поля верхнего уровня: maxIteration/,
  );
});

// Сумму журнала печатают сообщения об остановке, когда эталона нет или он не
// совпал. Тест считает её от журнала этой копии набора: журнал у каждого проекта
// свой, а константа здесь повторяла бы значение из `.agents/ralph.config.json`
// и разошлась бы с ним у любого, кто внёс в журнал запись.
function currentLedgerHash() {
  const ledgerPath = loadConfig().approvedIssueSnapshotsPath;
  return createHash('sha256').update(readFileSync(ledgerPath)).digest('hex');
}

test('the approved ledger checksum is taken from the operator config, not from the code', () => {
  // Эталон лежит в конфиге, потому что обновление набора перезаписывает
  // `scripts/ralph/**` целиком, а конфиг не трогает. Поэтому тест меняет журнал
  // и эталон вместе: сумма из конфига обязана разрешить прогон на содержимом,
  // которого код набора не знает.
  const ledgerPath = loadConfig().approvedIssueSnapshotsPath;
  const originalLedger = readFileSync(ledgerPath, 'utf8');
  const approved = { 7: { title: 'Approved', body: 'Approved body.' } };
  const ledger = `${JSON.stringify(approved, null, 2)}\n`;

  try {
    writeFileSync(ledgerPath, ledger, 'utf8');
    const hash = createHash('sha256').update(readFileSync(ledgerPath)).digest('hex');
    withPatchedRalphConfig({ approvedIssueSnapshotsHash: hash }, (config) => {
      assert.equal(config.approvedIssueSnapshotsHash, hash);
      assert.deepEqual(config.approvedIssueSnapshots, approved);
    });
  } finally {
    writeFileSync(ledgerPath, originalLedger, 'utf8');
  }
});

test('a checksum that does not match the ledger stops the load', () => {
  // Журнал здесь целый, а эталон чужой: подделкой может быть и он, поэтому
  // расхождение останавливает прогон с любой стороны.
  const ledgerHash = currentLedgerHash();
  assert.throws(
    () =>
      withPatchedRalphConfig({ approvedIssueSnapshotsHash: '0'.repeat(64) }, () => {
        throw new Error('loadConfig should have failed');
      }),
    (error) => {
      assert.match(error.message, /не совпадает с защищённым контрольным SHA-256/u);
      // Сумму печатает сообщение: оператор вписывает её, не считая руками.
      assert.match(error.message, new RegExp(ledgerHash, 'u'));
      assert.match(error.message, /approved-issues\.json/u);
      return true;
    },
  );
});

test('a missing checksum key stops the load and says what to write', () => {
  // Ключа нет — Ralph не сверит журнал ни с чем, и молчаливое умолчание здесь
  // означало бы, что автономная сессия одобряет себе задачи сама.
  const ledgerHash = currentLedgerHash();
  assert.throws(
    () =>
      withPatchedRalphConfig({ approvedIssueSnapshotsHash: undefined }, () => {
        throw new Error('loadConfig should have failed');
      }),
    (error) => {
      assert.match(error.message, /Заполните поле "approvedIssueSnapshotsHash"/u);
      assert.match(error.message, new RegExp(ledgerHash, 'u'));
      return true;
    },
  );
});

test('a checksum in the wrong shape stops the load before it is compared', () => {
  // Обрезанная или набранная заглавными сумма никогда не совпадёт с посчитанной,
  // и «не совпадает» увело бы оператора проверять журнал вместо своей опечатки.
  for (const value of ['ABC', currentLedgerHash().toUpperCase(), 42]) {
    assert.throws(
      () =>
        withPatchedRalphConfig({ approvedIssueSnapshotsHash: value }, () => {
          throw new Error('loadConfig should have failed');
        }),
      /должно содержать SHA-256: 64 знака шестнадцатеричной записи в нижнем регистре/u,
    );
  }
});

test('a checksum pasted with spaces around it still matches the ledger', () => {
  // Сумму копируют из сообщения об остановке, и терминал приносит её вместе с
  // переводом строки. Без обрезки человек получил бы претензию к форме значения
  // вместо расхождения, которого нет.
  const hash = currentLedgerHash();
  withPatchedRalphConfig({ approvedIssueSnapshotsHash: `  ${hash}\n` }, (config) => {
    assert.equal(config.approvedIssueSnapshotsHash, hash);
  });
});

test('the console marks the fields the config cannot do without', () => {
  // Поле без умолчания форма рисует пустой строкой ввода. Без пометки оператор
  // не отличит обязательное поле от вычисляемого и узнает о нём на остановке
  // прогона, а не на вкладке настроек.
  const marked = new Set();
  for (const group of fieldGroups) {
    for (const field of group.fields) {
      if (field.required === true) marked.add(field.path);
    }
  }
  assert.deepEqual(marked, new Set(['prompt', 'phases', 'approvedIssueSnapshotsHash']));
});

test('the validation image is derived per field when the config omits it', () => {
  const original = JSON.parse(readFileSync(ralphConfigPath, 'utf8'));
  const validationContainer = {
    dockerfile: 'scripts/ralph/Dockerfile.validation',
    writableVolumes: [],
  };

  // Умолчание на всём объекте означало бы, что удаление одного ключа
  // останавливает прогон. Имя образа выводится из имени каталога репозитория,
  // поэтому проверяется форма имени, а не конкретная строка.
  withPatchedRalphConfig(
    { ...original, validationMode: 'container', validationContainer },
    (config) => {
      assert.equal(config.validationContainer.image.endsWith('-ralph-validation:latest'), true);
      assert.equal(config.validationContainer.dockerfile, validationContainer.dockerfile);
    },
  );
});

test('validation writable volumes accept unique absolute POSIX paths only', () => {
  withPatchedRalphConfig(
    {
      validationMode: 'container',
      validationContainer: {
        dockerfile: 'scripts/ralph/Dockerfile.validation',
        writableVolumes: ['/opt/pnpm-store'],
      },
    },
    (config) => {
      assert.deepEqual(config.validationContainer.writableVolumes, ['/opt/pnpm-store']);
    },
  );
  for (const writableVolumes of [
    ['relative/path'],
    ['/opt/pnpm-store', '/opt/pnpm-store'],
    ['/opt/pnpm store'],
    ['/source/cache'],
  ]) {
    assert.throws(
      () =>
        withPatchedRalphConfig(
          {
            validationMode: 'container',
            validationContainer: {
              dockerfile: 'scripts/ralph/Dockerfile.validation',
              writableVolumes,
            },
          },
          () => {
            throw new Error('loadConfig should have failed');
          },
        ),
      /writableVolumes.*POSIX/u,
    );
  }
});

test('host validation does not require Docker settings', () => {
  withPatchedRalphConfig(
    {
      validationMode: 'host',
      validationContainer: undefined,
      validationDependencyPaths: undefined,
      validationEnvironment: ['DATABASE_URL=postgres://validation'],
    },
    (config) => {
      assert.equal(config.validationMode, 'host');
      assert.equal(config.validationContainer, undefined);
      assert.deepEqual(config.validationDependencyPaths, []);
    },
  );
});

test('a host validation mutation blocks recovery until the original diff is restored', () => {
  const storedIssue = {
    number: 17,
    phase: 'validation-mutated',
    validationExpectedTreeHash: 'before',
  };
  const updates = [];
  const stateStore = { updateIssue: (values) => updates.push(values) };

  assert.throws(
    () =>
      recoverHostValidationMutation(storedIssue, stateStore, {
        hostWorkingTreeHash: () => 'after',
      }),
    /Удалите созданные проверкой изменения/u,
  );
  assert.equal(updates.length, 0);

  assert.equal(
    recoverHostValidationMutation(storedIssue, stateStore, {
      hostWorkingTreeHash: () => 'before',
    }),
    true,
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].phase, 'working-tree');
  assert.equal(updates[0].validationExpectedTreeHash, null);
});

test('validation environment accepts unique NAME=value entries only', () => {
  assert.throws(
    () =>
      withPatchedRalphConfig({ validationEnvironment: ['DATABASE_URL'] }, () => {
        throw new Error('loadConfig should have failed');
      }),
    /NAME=value/u,
  );
  assert.throws(
    () =>
      withPatchedRalphConfig(
        { validationEnvironment: ['CI=true', 'CI=false'] },
        () => {
          throw new Error('loadConfig should have failed');
        },
      ),
    /не должно повторять/u,
  );
});

test('host validation rejects shell command chains', () => {
  for (const command of ['pnpm lint; pnpm test', 'pnpm lint && pnpm test', 'pnpm lint | tee log']) {
    assert.throws(
      () =>
        withPatchedRalphConfig(
          { validationMode: 'host', validationScripts: [command] },
          () => {
            throw new Error('loadConfig should have failed');
          },
        ),
      /одну команду на элемент/u,
    );
  }
});

test('the instruction boundary takes .agents/skills and skips dependency directories', () => {
  // Скиллы из `.agents/skills` загружает Codex, и они меняют поведение будущей
  // сессии наравне с AGENTS.md. Остальной `.agents` в границу не входит: отчёты
  // ревью Ralph пишет туда сам во время прогона.
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-instruction-boundary-'));
  try {
    mkdirSync(path.join(directory, '.agents', 'skills', 'deploy'), { recursive: true });
    mkdirSync(path.join(directory, 'target'), { recursive: true });
    mkdirSync(path.join(directory, '.venv'), { recursive: true });
    writeFileSync(path.join(directory, 'AGENTS.md'), '# root\n', 'utf8');
    writeFileSync(path.join(directory, '.agents', 'skills', 'deploy', 'SKILL.md'), '# s\n', 'utf8');
    writeFileSync(path.join(directory, '.agents', 'last-review.json'), '{}\n', 'utf8');
    // Каталоги зависимостей и сборки других стеков: найденная там инструкция
    // принадлежит чужому пакету, а не проекту.
    writeFileSync(path.join(directory, 'target', 'AGENTS.md'), '# vendored\n', 'utf8');
    writeFileSync(path.join(directory, '.venv', 'CLAUDE.md'), '# vendored\n', 'utf8');

    assert.deepEqual(
      agentInstructionFiles(directory).map((file) =>
        path.relative(directory, file).split(path.sep).join('/'),
      ),
      ['.agents/skills/deploy/SKILL.md', 'AGENTS.md'],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unsupported reasoning effort is rejected before a run starts', () => {
  for (const [patch, expected] of [
    // Сообщение называет выбранный CLI, потому что словари усилий у Codex и
    // Claude разные; сам CLI берётся из конфигурации, а не пришивается сюда.
    [
      { developmentEffort: 'extreme' },
      /Поле "developmentEffort" при agentCli=(codex|claude) должно быть одним из/,
    ],
    [
      { review: { enabled: false, model: 'gpt-5.6-terra', effort: 'nope' } },
      /Поле "review\.effort"/,
    ],
    [
      {
        milestoneReview: {
          enabled: false,
          model: 'gpt-5.6-sol',
          maxTurns: 150,
          maxFindings: 10,
          effort: 3,
        },
      },
      /Поле "milestoneReview\.effort"/,
    ],
  ]) {
    assert.throws(
      () =>
        withPatchedRalphConfig(patch, () => {
          throw new Error('loadConfig should have failed');
        }),
      expected,
    );
  }
});

test('a version 1.1 Codex config with minimal effort remains valid', () => {
  const original = JSON.parse(readFileSync(ralphConfigPath, 'utf8'));
  withPatchedRalphConfig(
    {
      ...original,
      agentCli: 'codex',
      developmentEffort: 'minimal',
      review: { ...original.review, effort: 'minimal' },
      milestoneReview: { ...original.milestoneReview, effort: 'minimal' },
    },
    (config) => {
      assert.equal(config.developmentEffort, 'minimal');
      assert.equal(config.review.effort, 'minimal');
      assert.equal(config.milestoneReview.effort, 'minimal');
    },
  );
});

test('the milestone review marker records the effective model and effort', () => {
  const config = loadConfig();
  const marker = milestoneReviewMarker(
    config,
    { number: 8, title: 'Phase 8', description: '' },
    { number: 61, headRefOid: 'a'.repeat(40) },
  );
  // Маркер обязан нести действующие модель и усилие, какими бы они ни были:
  // от них зависит, засчитывается ли кешированный PASS. Сравнение подстрокой,
  // а не регулярным выражением: в имени модели встречаются точки.
  const suffix = `model:${config.milestoneReview.model} effort:${config.milestoneReview.effort} -->`;
  assert.equal(marker.endsWith(suffix), true, marker);
  // A different effort is a different review, so the cached PASS must not match.
  const lowEffortMarker = milestoneReviewMarker(
    { ...config, milestoneReview: { ...config.milestoneReview, effort: 'low' } },
    { number: 8, title: 'Phase 8', description: '' },
    { number: 61, headRefOid: 'a'.repeat(40) },
  );
  assert.notEqual(lowEffortMarker, marker);
  assert.equal(milestonePassReviewIsClean(`${marker}\nirrelevant body`, lowEffortMarker), false);
});

const escape = String.fromCharCode(27);

const newline = String.fromCharCode(10);

function playwrightFailureOutput() {
  return [
    'Running 42 tests using 4 workers',
    '',
    `${escape}[31m  1) [chromium] > e2e/example.spec.ts:42:5 > example > shows the value ------${escape}[39m`,
    '',
    '    Error: expect(locator).toBeVisible() failed',
    '',
    "    Locator: getByRole('img')",
    '        at ExamplePage.check (e2e/example.spec.ts:44:12)',
    '        at runNextTicks (node:internal/process/task_queues:104:5)',
    '',
    '    Retry #1 -------------------------------------',
    '    Error: expect(locator).toBeVisible() failed',
    '        at ExamplePage.check (e2e/example.spec.ts:44:12)',
    '    attachment #1: screenshot (test-results/example-shows-the-value-chromium/test-failed-1.png)',
    '',
    '    Retry #2 -------------------------------------',
    '    Error: expect(locator).toBeVisible() failed',
    '',
    '  1) [chromium] > e2e/example.spec.ts:42:5 > example > shows the value ------',
    '  2) [mobile] > e2e/second.spec.ts:10:3 > second > stores the item ----------',
    '',
    '  2 failed',
    '  40 passed (1.4m)',
  ].join(newline);
}

function validationError(output) {
  return Object.assign(new Error('Команда docker run завершилась с кодом 1.'), {
    code: 'RALPH_COMMAND_FAILED',
    status: 1,
    stdout: output,
    stderr: '',
    script: 'npm test',
  });
}

test('a failed validation is stored as a bounded structured summary', () => {
  const summary = summarizeCommandFailure(validationError(playwrightFailureOutput()));

  assert.equal(summary.command, 'npm test');
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.code, 'RALPH_COMMAND_FAILED');
  assert.equal(summary.error, 'Error: expect(locator).toBeVisible() failed');
  assert.deepEqual(summary.failedTests, [
    '[chromium] > e2e/example.spec.ts:42:5 > example > shows the value',
    '[mobile] > e2e/second.spec.ts:10:3 > second > stores the item',
  ]);
  assert.equal(summary.omittedFailedTests, 0);
  assert.deepEqual(summary.artifacts, [
    'test-results/example-shows-the-value-chromium/test-failed-1.png',
  ]);
  assert.ok(summary.excerpt.length <= 20);
  assert.equal(
    summary.excerpt.some((line) => line.includes(escape)),
    false,
    'ANSI colouring must be stripped',
  );
  assert.equal(
    summary.excerpt.some((line) => line.startsWith('at ')),
    false,
    'stack frames must be dropped',
  );
  assert.equal(
    summary.excerpt.filter((line) => line === 'Error: expect(locator).toBeVisible() failed').length,
    1,
    'identical retry lines must collapse into one',
  );
});

test('the rendered failure summary is far smaller than the raw output and points at run.log', () => {
  const output = [playwrightFailureOutput(), 'noise line '.repeat(4_000)].join(newline);
  const rendered = formatFailureSummary(summarizeCommandFailure(validationError(output)));

  assert.ok(output.length > 40_000);
  assert.ok(rendered.length <= 2_100, `summary was ${rendered.length} chars`);
  assert.match(rendered, /Команда: npm test/);
  assert.match(rendered, /Exit code: 1/);
  assert.match(rendered, /run\.log/);
});

test('failed tests are deduplicated across retries and bounded with a visible remainder', () => {
  const many = Array.from(
    { length: 14 },
    (_, index) => `  ${index + 1}) [chromium] > e2e/spec-${index}.spec.ts:1:1 > case ${index}`,
  );
  const withRetries = [...many, ...many, ...many].join(newline);
  const { tests, omitted } = uniqueFailedTests(withRetries);

  assert.equal(tests.length, 10);
  assert.equal(omitted, 4);
  assert.equal(new Set(tests).size, 10);
  assert.match(
    formatFailureSummary(summarizeCommandFailure(validationError(withRetries))),
    /Упавшие проверки \(показано 10 из 14\):/,
  );
});

test('jest and node:test failures are recognized alongside Playwright output', () => {
  const jest = [
    'FAIL test/profile.e2e-spec.ts',
    '  ● profile e2e > rejects an oversized current password',
    '',
    '    expect(received).toBe(expected)',
    '  ● Console',
    'Tests:       1 failed, 126 passed, 127 total',
  ].join(newline);
  assert.deepEqual(uniqueFailedTests(jest).tests, [
    'profile e2e > rejects an oversized current password',
  ]);

  const nodeTest = ['✖ config rejects an unsafe model (1.2ms)', 'ℹ fail 1'].join(newline);
  assert.deepEqual(uniqueFailedTests(nodeTest).tests, ['config rejects an unsafe model']);
});

test('a failure without command output degrades to the error message', () => {
  const summary = summarizeCommandFailure(
    Object.assign(new Error('Изолированный Codex не авторизован.'), {
      code: 'RALPH_AGENT_AUTH',
    }),
  );

  assert.equal(summary.command, null);
  assert.equal(summary.exitCode, null);
  assert.equal(summary.code, 'RALPH_AGENT_AUTH');
  assert.equal(summary.error, 'Изолированный Codex не авторизован.');
  assert.deepEqual(summary.failedTests, []);
  assert.match(formatFailureSummary(summary), /Код ошибки: RALPH_AGENT_AUTH/);
});

test('the recovery prompt carries the summary and tells the agent to rerun only what failed', () => {
  const summary = summarizeCommandFailure(validationError(playwrightFailureOutput()));
  const prompt = recoveryPrompt({
    lastFailure: formatFailureSummary(summary),
    lastFailureSummary: summary,
  });

  assert.match(prompt, /## AFK recovery/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /Сначала повтори только упавшие проверки/);
  assert.match(prompt, /не дублируй его/);
  assert.ok(prompt.length < 2_500);

  const withoutFailure = recoveryPrompt({});
  assert.match(withoutFailure, /процесс завершился до фиксации результата/);
  assert.equal(/Сначала повтори только упавшие проверки/.test(withoutFailure), false);
});

test('потерянный комментарий не роняет цикл, а незакрытая issue роняет', () => {
  const failing = () => {
    const error = new Error('gh api: HTTP 503');
    throw error;
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));

  try {
    // Публикация недоступна: обрыв цикла здесь стоил бы уже сделанной работы.
    reopenIssueWithComment('owner/repo', { number: 82 }, 'Findings', {
      issueState: () => 'OPEN',
      patchIssue: () => ({}),
      postComment: failing,
    });

    // Переоткрытие недоступно: закрытая issue выпадет из очереди, и расхождение
    // с сохранённым состоянием обязано остановить прогон.
    assert.throws(
      () =>
        reopenIssueWithComment('owner/repo', { number: 82 }, 'Findings', {
          issueState: () => 'CLOSED',
          patchIssue: failing,
          postComment: () => {},
        }),
      /503/,
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(errors.length, 1);
  assert.match(errors[0], /#82/);
  assert.match(errors[0], /потерян только комментарий/);
});

test('после отказа ревью база следующей сессии — HEAD, а не commit issue', () => {
  const commit = 'a'.repeat(40);
  const head = 'b'.repeat(40);

  // Обычный случай: HEAD и есть commit issue.
  assert.equal(
    baseForNextSession(commit, {
      run: () => ({ status: 0, stdout: commit }),
      isAncestorCommit: () => true,
    }),
    commit,
  );

  // Ветка ушла вперёд, работа issue в её истории: между коммитом issue и HEAD
  // ложатся правки Ralph, и следующая сессия обязана продолжать с HEAD.
  assert.equal(
    baseForNextSession(commit, {
      run: () => ({ status: 0, stdout: head }),
      isAncestorCommit: () => true,
    }),
    head,
  );

  // История разошлась: перенос базы вперёд потерял бы работу issue.
  assert.equal(
    baseForNextSession(commit, {
      run: () => ({ status: 0, stdout: head }),
      isAncestorCommit: () => false,
    }),
    commit,
  );
});

test('разбор git status переживает обрезку пробелов и переименование', () => {
  // `run` обрезает пробелы по краям вывода, поэтому первая строка приходит без
  // ведущего пробела статуса: срез на три символа съел бы первый символ её пути.
  const raw = ' M src/app/items/item-form.ts\n M e2e/example.spec.ts\n';

  assert.deepEqual(workingTreePaths(raw), workingTreePaths(raw.trim()));
  assert.deepEqual(workingTreePaths(raw.trim()), [
    'src/app/items/item-form.ts',
    'e2e/example.spec.ts',
  ]);

  // Непрослеженные файлы и переименования: из `R old -> new` нужен новый путь.
  assert.deepEqual(workingTreePaths('?? design/example.pen\nR  a.ts -> b.ts'), [
    'design/example.pen',
    'b.ts',
  ]);
});

test('пределы повторов разведены по цене одной попытки', () => {
  const original = JSON.parse(readFileSync(ralphConfigPath, 'utf8'));
  const runtime = (patch) => ({ runtime: { ...original.runtime, ...patch } });

  // Повтор сетевой команды стоит секунд ожидания: трёх попыток с паузами 2 и 4
  // секунды не хватает на мигающий GitHub, а обрыв теряет прогон, уже
  // сделавший всю дорогую работу.
  withPatchedRalphConfig(runtime({ networkRetryAttempts: 30 }), (config) => {
    assert.equal(config.runtime.networkRetryAttempts, 30);
  });
  assert.throws(
    () =>
      withPatchedRalphConfig(runtime({ networkRetryAttempts: 61 }), () => {
        throw new Error('loadConfig должен был отказать');
      }),
    /от 1 до 60/,
  );

  // Повтор ревью — целая сессия агента: минуты и сотни тысяч токенов за
  // попытку, поэтому предел остаётся жёстким.
  assert.throws(
    () =>
      withPatchedRalphConfig(runtime({ reviewRetryAttempts: 6 }), () => {
        throw new Error('loadConfig должен был отказать');
      }),
    /от 1 до 5/,
  );
});

test('повторное создание задачи не заводит дубликат после дошедшего запроса', () => {
  const pullRequest = { number: 77, headRefOid: 'head-1' };
  const finding = { severity: 'P2', title: 'Notice lies', body: 'x', file: 'form.tsx', line: 220 };
  const milestone = { number: 8, title: 'Phase 8' };
  const created = [];

  // Первый POST дошёл, но ответ потерялся: повтор обязан найти уже созданную
  // задачу по marker, а не завести вторую с тем же замечанием.
  const landed = {
    number: 85,
    state: 'OPEN',
    body: reviewFindingMarker(pullRequest, finding),
  };

  const queued = createOrReopenReviewIssues(
    { milestone: 'Phase 8' },
    'owner/repository',
    milestone,
    pullRequest,
    { verdict: 'fail', findings: [finding] },
    {
      milestoneIssues: () => [landed],
      createReviewFindingIssue: () => {
        created.push('POST');
        return { number: 999, state: 'OPEN', body: '' };
      },
      updateReviewFindingIssue: () => {},
      reopenReviewFindingIssue: () => {},
    },
  );

  assert.deepEqual(created, []);
  assert.deepEqual(
    queued.map((issue) => issue.number),
    [85],
  );
});

test('отпечаток отложенного замечания не зависит от PR, строки и круга ревью', () => {
  const finding = {
    severity: 'P3',
    title: 'Комментарий обещает больше, чем делает код',
    file: 'src/items/list-variant.service.ts',
    line: 101,
  };

  assert.equal(
    deferredFindingFingerprint(finding),
    deferredFindingFingerprint({ ...finding, line: 999 }),
  );
  assert.notEqual(
    deferredFindingFingerprint(finding),
    deferredFindingFingerprint({ ...finding, file: 'src/other.ts' }),
  );
  assert.notEqual(
    deferredFindingFingerprint(finding),
    deferredFindingFingerprint({ ...finding, severity: 'P2' }),
  );
});

test('замечания ниже порога записываются отложенными issues без дубликатов', () => {
  const config = { reviewSeverityFloor: 'P1' };
  const belowFloor = [
    { severity: 'P2', title: 'Уже записано и открыто', body: 'x', file: 'one.ts', line: 1 },
    {
      severity: 'P3',
      title: 'Уже записано и закрыто человеком',
      body: 'y',
      file: 'two.ts',
      line: 2,
    },
    { severity: 'P3', title: 'Новое замечание', body: 'z', file: 'three.ts', line: 3 },
  ];
  const existing = [
    { number: 11, state: 'OPEN', body: deferredFindingMarker(belowFloor[0]) },
    { number: 12, state: 'CLOSED', body: deferredFindingMarker(belowFloor[1]) },
  ];
  const created = [];
  let labelEnsured = 0;

  const recorded = recordDeferredFindings(
    config,
    'owner/repository',
    { verdict: 'pass', findings: [], belowFloorFindings: belowFloor },
    'independent review of issue #99',
    {
      ensureDeferredFindingLabel: () => {
        labelEnsured += 1;
      },
      listDeferredIssues: () => existing,
      createDeferredFindingIssue: (_config, _repository, batch) => {
        created.push(batch.map((finding) => finding.title));
        return {
          number: 13,
          state: 'OPEN',
          body: batch.map((finding) => deferredFindingMarker(finding)).join('\n'),
          url: 'https://example.test/issues/13',
        };
      },
    },
  );

  assert.equal(labelEnsured, 1);
  // Открытая и закрытая существующие issues не трогаются: закрыл человек,
  // и повторная находка того же текста не отменяет его решения.
  assert.deepEqual(created, [['Новое замечание']]);
  assert.deepEqual(
    recorded.map((issue) => issue.number),
    [13],
  );
});

test('без замечаний ниже порога отложенные issues не создаются и GitHub не трогается', () => {
  const untouched = () => assert.fail('GitHub не должен вызываться');

  assert.deepEqual(
    recordDeferredFindings(
      { reviewSeverityFloor: 'P3' },
      'owner/repository',
      { verdict: 'fail', findings: [{ severity: 'P1' }] },
      'review',
      {
        ensureDeferredFindingLabel: untouched,
        listDeferredIssues: untouched,
        createDeferredFindingIssue: untouched,
      },
    ),
    [],
  );
});

test('группа с уже записанным замечанием не топит остальные: создаётся issue из свежих', () => {
  const config = { reviewSeverityFloor: 'P1' };
  const sameFile = [
    { severity: 'P3', title: 'Уже записано', body: 'a', file: 'shared.ts', line: 1 },
    { severity: 'P3', title: 'Свежее из той же группы', body: 'b', file: 'shared.ts', line: 2 },
  ];
  const existing = [{ number: 21, state: 'OPEN', body: deferredFindingMarker(sameFile[0]) }];
  const created = [];

  recordDeferredFindings(
    config,
    'owner/repository',
    { verdict: 'pass', findings: [], belowFloorFindings: sameFile },
    'review',
    {
      ensureDeferredFindingLabel: () => {},
      listDeferredIssues: () => existing,
      createDeferredFindingIssue: (_config, _repository, batch) => {
        created.push(batch.map((finding) => finding.title));
        return { number: 22, state: 'OPEN', body: '', url: 'u' };
      },
    },
  );

  assert.deepEqual(created, [['Свежее из той же группы']]);
});

test('базой инкрементального milestone-ревью служит только совместимое новейшее ревью', () => {
  const config = {
    baseBranch: 'master',
    milestoneReview: { model: 'model-one', effort: 'high' },
  };
  const milestone = { number: 7, title: 'Phase 6', description: 'Uploader identity.' };
  const pullRequest = { number: 89 };
  const oldHead = 'a'.repeat(40);
  const newHead = 'b'.repeat(40);
  const reviewFor = (head, extra = '') =>
    `${milestoneReviewMarker(config, milestone, { headRefOid: head })}${extra}\nтекст ревью ${head.slice(0, 4)}`;
  const listedReviews = (bodies) => ({
    githubPagedArray: () => bodies.map((body) => ({ body })),
  });

  // Новейшее подходящее ревью побеждает более старое.
  const newest = lastPublishedMilestoneReview(
    config,
    milestone,
    'owner/repository',
    pullRequest,
    listedReviews([reviewFor(oldHead), reviewFor(newHead)]),
  );
  assert.equal(newest.head, newHead);

  // Ревью с неполным покрытием (обрезано maxFindings) базой не становится:
  // отрезанные findings живут только в обещании «deferred to the next full
  // review», и сузить следующий круг значило бы потерять их навсегда.
  assert.equal(
    lastPublishedMilestoneReview(
      config,
      milestone,
      'owner/repository',
      pullRequest,
      listedReviews([reviewFor(newHead, `\n${milestonePartialCoverageMarker}`)]),
    ),
    null,
  );

  // Смена модели или effort — документированный способ заказать свежий полный
  // аудит: ревью прежней модели базой не признаётся.
  assert.equal(
    lastPublishedMilestoneReview(
      { ...config, milestoneReview: { model: 'model-two', effort: 'high' } },
      milestone,
      'owner/repository',
      pullRequest,
      listedReviews([reviewFor(newHead)]),
    ),
    null,
  );

  // Ревью другого milestone на том же PR не учитывается.
  assert.equal(
    lastPublishedMilestoneReview(
      config,
      { ...milestone, number: 8, title: 'Phase 7' },
      'owner/repository',
      pullRequest,
      listedReviews([reviewFor(newHead)]),
    ),
    null,
  );
});

test('чистый PASS с секцией ниже порога распознаётся как уже опубликованный', () => {
  const config = { baseBranch: 'master', milestoneReview: { model: 'm', effort: 'high' } };
  const milestone = { number: 7, title: 'Phase 6', description: 'D' };
  const pullRequest = { headRefOid: 'c'.repeat(40) };
  const marker = milestoneReviewMarker(config, milestone, pullRequest);
  const passBody = (belowFloor) => `${marker}
## Ralph Loop: milestone review

- **Verdict:** **PASS**

Сводка.

### Findings

No actionable findings.
${belowFloor}
The pull request remains draft so a human can make the final merge decision.`;

  assert.equal(milestonePassReviewIsClean(passBody(''), marker), true);
  assert.equal(
    milestonePassReviewIsClean(
      passBody(
        '\n### Below the severity floor (not blocking)\n\n- **P3 — мелочь** (a.ts:1)\n  текст\n',
      ),
      marker,
    ),
    true,
  );
  // FAIL с настоящими findings чистым PASS не считается.
  assert.equal(
    milestonePassReviewIsClean(passBody('\n- **P1 — дефект** (a.ts:1)\n  текст\n'), marker),
    false,
  );
});

test('уже застадированное удаление не попадает в git add', () => {
  // `git rm` убирает файл и из дерева, и из индекса. Путь остаётся в porcelain
  // как `D `, но `git add` по нему отвечает `did not match any files` и роняет
  // прогон кодом 128.
  const status = [
    ' M src/items/items.controller.ts',
    'D  src/items/services/item-uploader.service.ts',
    '?? src/items/services/item-uploader-renamed.service.ts',
  ].join('\n');

  const entries = workingTreeEntries(status.trim());
  assert.deepEqual(
    entries.map((entry) => `${entry.index}${entry.worktree}`),
    [' M', 'D ', '??'],
  );

  // Стадировать нужно только изменённое в дереве; удаление уже в индексе и в
  // коммит попадёт само.
  assert.deepEqual(
    entries.filter((entry) => entry.worktree !== ' ').map((entry) => entry.path),
    [
      'src/items/items.controller.ts',
      'src/items/services/item-uploader-renamed.service.ts',
    ],
  );

  // Список путей задачи при этом полный: удалённый файл — тоже её изменение.
  assert.equal(workingTreePaths(status.trim()).length, 3);
});

/**
 * Дублёр Git для слияния базы: отвечает на команды, которые читает
 * `syncPhaseBranchWithBase`, и записывает то, что она выполнила.
 */
function gitStubForBaseSync({ status = '', mergeStatus = 0 } = {}) {
  const calls = [];

  return {
    calls,
    run: (command, args, options) => {
      calls.push(args.join(' '));
      if (args[0] === 'status') return { status: 0, stdout: status };
      if (args[0] === 'merge' && args[1] !== '--abort') {
        return { status: mergeStatus, stdout: '', stderr: 'CONFLICT (content)' };
      }
      if (options?.allowFailure) return { status: 0, stdout: '' };
      return { status: 0, stdout: '' };
    },
    runNetwork: (command, args) => {
      calls.push(args.join(' '));
      return { status: 0, stdout: '' };
    },
  };
}

const baseSyncConfig = { branch: 'features/phase-6', baseBranch: 'features/phase-5' };

test('база, уже вошедшая в ветку, не вызывает слияния', () => {
  const git = gitStubForBaseSync();

  const merged = syncPhaseBranchWithBase(baseSyncConfig, {
    run: git.run,
    runNetwork: git.runNetwork,
    isAncestorCommit: () => true,
  });

  assert.equal(merged, false);
  assert.equal(
    git.calls.some((call) => call.startsWith('merge')),
    false,
  );
});

test('незавершённая работа в дереве откладывает слияние базы, а не смешивается с ним', () => {
  // Восстановление после сбоя: diff агента ещё не закончен, и чужие изменения
  // поверх него смешали бы две работы в одном коммите.
  const git = gitStubForBaseSync({ status: ' M src/items/items.controller.ts' });

  const merged = syncPhaseBranchWithBase(baseSyncConfig, {
    run: git.run,
    runNetwork: git.runNetwork,
    isAncestorCommit: () => false,
  });

  assert.equal(merged, false);
  assert.equal(
    git.calls.some((call) => call.startsWith('merge')),
    false,
  );
});

test('разошедшаяся база вливается в чистую ветку фазы', () => {
  const git = gitStubForBaseSync();

  const merged = syncPhaseBranchWithBase(baseSyncConfig, {
    run: git.run,
    runNetwork: git.runNetwork,
    isAncestorCommit: () => false,
  });

  assert.equal(merged, true);
  assert.ok(git.calls.includes('fetch origin features/phase-5'));
  assert.ok(git.calls.includes('merge --no-edit origin/features/phase-5'));
  assert.equal(
    git.calls.some((call) => call === 'merge --abort'),
    false,
  );
});

test('конфликт с базой отменяет слияние и останавливает прогон', () => {
  // Выбор между двумя реализациями — это и есть содержание конфликта, поэтому
  // разрешать его автоматически нельзя: цикл обязан позвать человека.
  const git = gitStubForBaseSync({ mergeStatus: 1 });

  assert.throws(
    () =>
      syncPhaseBranchWithBase(baseSyncConfig, {
        run: git.run,
        runNetwork: git.runNetwork,
        isAncestorCommit: () => false,
      }),
    /конфликтует с базой origin\/features\/phase-5/,
  );
  assert.ok(git.calls.includes('merge --abort'));
});

test('слияние базы включено по умолчанию, когда конфиг о нём молчит', () => {
  // Проверяется умолчание кода на конфиге без этого поля, а не значение из файла
  // проекта: выключить слияние — право оператора, и тест, читающий его
  // настройку, ловил бы её вместо поведения кода.
  withPatchedRalphConfig({ syncBaseBranch: undefined }, (config) => {
    assert.equal(config.syncBaseBranch, true);
  });
});
