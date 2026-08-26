/**
 * Структурированная сводка упавшей проверки.
 *
 * Полный вывод остаётся в run.log. В state и в recovery prompt попадает только
 * ограниченная сводка: команда, exit code, уникальные упавшие проверки, основная
 * ошибка, значимые строки и пути к артефактам. Идентичные строки повторных
 * попыток Playwright схлопываются, поэтому retry не раздувает prompt.
 */

// ESC + '[' + parameters + final byte. `[[]` is a character class for a literal
// '[' so the source stays free of escape sequences that tooling can mangle.
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}[[][0-9;]*[A-Za-z]`, 'g');

export function stripAnsi(value) {
  return String(value ?? '').replace(ansiEscapePattern, '');
}

function significantOutputLines(text) {
  const seen = new Set();
  const lines = [];
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (/^[\s\-─━=_*.·•#|+]+$/.test(line)) continue;
    if (/^at\s/.test(line)) continue;
    if (/^npm (?:notice|warn|info|WARN)\b/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

const failedTestPatterns = [
  // Playwright: "  1) [chromium] › e2e/profile.spec.ts:42:5 › shows avatar ────"
  /^\s*\d+\)\s+(.+)$/,
  // Jest: "  ● profile e2e › rejects an oversized password"
  /^\s*●\s+(.+)$/,
  // node:test: "✖ my test (1.2ms)"
  /^\s*[✖✗×]\s+(.+)$/,
];

export function uniqueFailedTests(text, limit = 10) {
  const seen = new Set();
  const all = [];
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    for (const pattern of failedTestPatterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      const title = match[1]
        .replace(/[\s\-─━]+$/, '')
        .replace(/\s+\(\d+(?:\.\d+)?ms\)$/, '')
        .trim();
      // `failing tests:` — заголовок сводки node:test, а не имя теста. Он
      // попадал в список упавших и приводил к указанию «перезапусти» на строке,
      // которой не существует.
      if (title === '' || /^(?:console|failing tests:)$/i.test(title)) break;
      if (!seen.has(title)) {
        seen.add(title);
        all.push(title);
      }
      break;
    }
  }
  return { tests: all.slice(0, limit), omitted: Math.max(0, all.length - limit) };
}

function failureArtifacts(text, limit = 5) {
  // Backslashes are normalized first so one slash-only pattern covers Windows and
  // POSIX paths, and the keyword must be a directory segment: a bare word
  // "screenshot" in prose is not an artifact path.
  const normalized = stripAnsi(text).split(String.fromCharCode(92)).join('/');
  const matches =
    normalized.match(/[^\s"'(),]*(?:test-results|playwright-report|screenshot)\/[^\s"'(),]*/gi) ??
    [];
  return [...new Set(matches)].slice(0, limit);
}

function primaryErrorLine(lines) {
  return (
    lines.find((line) => /\berror TS\d+\b/.test(line)) ??
    lines.find((line) =>
      /^(?:Error|AssertionError|TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(line),
    ) ??
    lines.find((line) => /\b(?:Error|error|failed|FAIL|Ошибка)\b/.test(line)) ??
    lines[0] ??
    null
  );
}

/**
 * Вывод одного упавшего script, а не всего набора.
 *
 * Entrypoint печатает маркер отдельной строкой перед каждым script, а `set -eu`
 * останавливает цикл на первом сбое: всё до последнего маркера — вывод уже
 * прошедших проверок. Без отсечения excerpt показывал хвост предыдущего,
 * успешного script: на реальном прогоне в сводке про упавший `test:e2e:web`
 * стояли строки `PASS test/...` от API-набора.
 */
const validationScriptMarkerLine = /^RALPH_VALIDATION_SCRIPT=(\S+)\s*$/gm;

export function failingScriptOutput(rawOutput, script) {
  // Маркер печатается контейнером и может прийти в escape-последовательностях,
  // как и всё остальное; runner ищет его тоже по очищенному тексту.
  const output = stripAnsi(rawOutput);
  const markers = [...output.matchAll(validationScriptMarkerLine)];
  const last = markers.at(-1);
  // Сверка с именем, которое runner уже определил: если маркеры разъедутся с
  // атрибуцией ошибки, лучше показать весь вывод, чем чужой кусок.
  if (!last || (script && last[1] !== script)) return output;

  return output.slice(last.index + last[0].length);
}

export function summarizeCommandFailure(error, options = {}) {
  const maxLines = options.maxLines ?? 20;
  const fullOutput =
    [error?.stdout, error?.stderr].filter(Boolean).join('\n').trim() ||
    stripAnsi(error?.message ?? '');
  const output = failingScriptOutput(fullOutput, error?.script);
  const lines = significantOutputLines(output);
  const { tests, omitted } = uniqueFailedTests(output);
  const primary = primaryErrorLine(lines) ?? String(error?.message ?? '').split(/\r?\n/)[0] ?? '';
  return {
    command: error?.script ? `npm run ${error.script}` : (options.command ?? null),
    exitCode: Number.isInteger(error?.status) ? error.status : null,
    code: error?.code ?? null,
    error: primary.length > 300 ? `${primary.slice(0, 300)}…` : primary,
    failedTests: tests,
    omittedFailedTests: omitted,
    excerpt: lines.slice(-maxLines),
    artifacts: failureArtifacts(output),
  };
}

export function formatFailureSummary(summary, maxChars = 2_000) {
  const parts = [];
  if (summary.command) parts.push(`Команда: ${summary.command}`);
  if (summary.exitCode !== null) parts.push(`Exit code: ${summary.exitCode}`);
  else if (summary.code) parts.push(`Код ошибки: ${summary.code}`);
  if (summary.error) parts.push(`Ошибка: ${summary.error}`);
  if (summary.failedTests.length > 0) {
    const total = summary.failedTests.length + summary.omittedFailedTests;
    parts.push(
      `Упавшие проверки${summary.omittedFailedTests > 0 ? ` (показано ${summary.failedTests.length} из ${total})` : ''}:`,
    );
    parts.push(...summary.failedTests.map((test) => `- ${test}`));
  }
  if (summary.excerpt.length > 0) {
    parts.push('Значимые строки вывода:');
    parts.push(...summary.excerpt.map((line) => `  ${line}`));
  }
  if (summary.artifacts.length > 0) {
    parts.push(`Артефакты: ${summary.artifacts.join(', ')}`);
  }
  parts.push('Полный вывод сохранён в .git/ralph-loop/run.log.');
  const text = parts.join('\n');
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n… сводка усечена; полный вывод в run.log.`
    : text;
}

export function recordedFailure(error, options = {}) {
  const summary = summarizeCommandFailure(error, options);
  return { lastFailure: formatFailureSummary(summary), lastFailureSummary: summary };
}

export const clearedFailure = { lastFailure: null, lastFailureSummary: null };

/**
 * Продолжение после отказа независимого ревью.
 *
 * Отдельная ветка нужна потому, что состояние здесь противоположное обычному
 * восстановлению: сбоя не было, дерево чистое, реализация уже в HEAD и уже
 * прошла валидацию. Без этого сессия начиналась с нуля и заново выясняла, что
 * сделано, — самая крупная повторная трата на многоитерационной issue.
 *
 * Сами замечания сюда не копируются: оркестратор кладёт их в тело issue, а тело
 * и так целиком попадает в prompt.
 */
function reviewRecoveryPrompt(storedIssue) {
  return (
    '\n\n## AFK recovery: независимое ревью вернуло замечания\n\nHEAD уже содержит ' +
    `commit ${storedIssue.commit} — твою реализацию этой issue, и весь набор ` +
    'validationScripts на этом дереве прошёл. Замечания ревьюера перечислены в теле ' +
    'issue выше. Исправь их поверх HEAD: не переделывай реализацию заново и не ' +
    'откатывай существующие изменения.'
  );
}

export function recoveryPrompt(storedIssue) {
  if (storedIssue?.phase === 'review-failed' && storedIssue.commit) {
    return reviewRecoveryPrompt(storedIssue);
  }

  const failure = storedIssue?.lastFailure ?? 'процесс завершился до фиксации результата';
  const failedTests = storedIssue?.lastFailureSummary?.failedTests ?? [];
  const focus =
    failedTests.length > 0
      ? '\n\nСначала повтори только упавшие проверки из списка выше. Полный набор ' +
        'validationScripts запускает оркестратор; не дублируй его.'
      : '';
  return (
    '\n\n## AFK recovery\n\nЭто продолжение незавершённой сессии Ralph. Не сбрасывай ' +
    'существующие изменения. Изучи текущий git diff, продолжи реализацию той же issue ' +
    `и исправь последний сбой оркестратора:\n\n${failure}${focus}`
  );
}
