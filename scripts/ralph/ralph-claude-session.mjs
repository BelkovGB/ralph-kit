import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { fail } from './ralph-scope.mjs';
import { outputTail } from './ralph-process-runner.mjs';
import { createSandboxRoot, genericExitFailure, runAgentSession } from './ralph-agent-session.mjs';

/**
 * Backend Claude Code CLI: аргументы ролей, изолированный CLAUDE_CONFIG_DIR и
 * разбор потока `--output-format stream-json`.
 *
 * Три отличия от Codex меняют не только аргументы, но и то, что считается
 * отказом, поэтому вынесены в отдельный модуль, а не в развилки внутри общего.
 */

// Claude принимает уровень усилий флагом, а не -c override, и словарь у него
// другой: minimal отсутствует, xhigh и max добавлены.
export const reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Учётные данные передаются переменной окружения, а не копией файла.
 *
 * Приём Codex — скопировать auth.json в песочницу — для Claude не переносится:
 * на Windows живой токен лежит не в `~/.claude/.credentials.json`, и
 * изолированный CLAUDE_CONFIG_DIR с копией этого файла даёт "Not logged in".
 *
 * Годятся обе переменные, и это не equivalent: `CLAUDE_CODE_OAUTH_TOKEN` от
 * `claude setup-token` работает по уже оплаченной подписке, а
 * `ANTHROPIC_API_KEY` тарифицируется отдельно. Порядок предпочтения не
 * навязывается: если заданы обе, решает CLI.
 */
export const claudeCredentialVariables = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];

function claudeCredentials(source) {
  return Object.fromEntries(
    claudeCredentialVariables
      .map((name) => [name, source[name]?.trim()])
      .filter(([, value]) => Boolean(value)),
  );
}

function missingClaudeCredentials() {
  const error = new Error(
    `Не задана ни одна из переменных ${claudeCredentialVariables.join(' / ')}. ` +
      'Claude-сессия Ralph запускается с изолированным HOME, где OAuth-состояние CLI ' +
      'недоступно. Токен по подписке выдаёт `claude setup-token`; API-ключ ' +
      'тарифицируется отдельно.',
  );
  error.code = 'RALPH_AGENT_AUTH';
  return error;
}

export function createSandboxedClaudeEnvironment(source = process.env, options = {}) {
  const sandbox = createSandboxRoot(source, 'ralph-claude-');
  const configDir = path.join(sandbox.root, 'claude');
  mkdirSync(configDir, { recursive: true });

  const credentials = options.credentials ?? claudeCredentials(source);
  if (Object.keys(credentials).length === 0) {
    sandbox.cleanup();
    throw missingClaudeCredentials();
  }

  return {
    root: sandbox.root,
    env: { ...sandbox.env, CLAUDE_CONFIG_DIR: configDir, ...credentials },
  };
}

// --output-format stream-json без --verbose завершается кодом 1 и пустым
// stdout, поэтому флаг зашит рядом, а не оставлен на вызывающего.
const streamArguments = ['-p', '--verbose', '--output-format', 'stream-json'];

/**
 * Флаг уносит машинно-зависимые секции — cwd, окружение, пути памяти, git
 * status — из системного блока в первое сообщение пользователя. Информация не
 * теряется, меняется только то, что попадает в кэшируемый префикс.
 *
 * Для Ralph это существенно: каждая сессия получает свой mkdtemp-HOME, его путь
 * печатался в секции памяти, и префикс двух соседних сессий расходился на
 * ровном месте. Замер в песочнице, повторяющей боевую: без флага вторая сессия
 * заново создаёт 6 168 токенов кэша, с флагом — 1 156, а цена префикса падает с
 * $0,0436 до $0,0150.
 */
const cacheStableArguments = ['--exclude-dynamic-system-prompt-sections'];

/**
 * Инструменты, которых у сессии Ralph быть не должно.
 *
 * Схемы всех инструментов лежат в кэшируемом префиксе и оплачиваются каждой
 * сессией. Замер: полный набор — 43 442 токена входа, с этим списком — 25 961.
 *
 * Список запрещает, а не разрешает, сознательно: allowlist при обновлении CLI
 * молча отрежет новый полезный инструмент, denylist молча вернёт лишний вес.
 * Второе дешевле.
 *
 * `WebFetch` намеренно оставлен: контракт issue иногда живёт во внешней
 * документации, и это единственный запрет, способный превратиться в
 * заблокированную итерацию. `WebSearch` запрещён — поиск без возможности
 * открыть найденное бесполезен.
 */
const deniedDevelopmentTools = [
  'Task',
  'Workflow',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
  'SendMessage',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'WebSearch',
  'NotebookEdit',
  'ReportFindings',
  'Skill',
];

export function developmentClaudeArguments(config) {
  return [
    ...streamArguments,
    ...cacheStableArguments,
    '--model',
    config.developmentModel,
    '--effort',
    config.developmentEffort,
    '--disallowedTools',
    deniedDevelopmentTools.join(','),
    // Аналог `--sandbox danger-full-access` у Codex: сессия не должна ждать
    // подтверждения, которое в AFK-режиме некому дать.
    '--permission-mode',
    'bypassPermissions',
  ];
}

export function reviewClaudeArguments(role) {
  return [
    ...streamArguments,
    ...cacheStableArguments,
    '--model',
    role.model,
    '--effort',
    role.effort,
    // У Claude нет read-only песочницы, поэтому роль ограничивается набором
    // инструментов. Настоящая гарантия — сверка HEAD, ветки и рабочего дерева
    // после ревью: она работает одинаково для обоих CLI.
    '--tools',
    'Read,Glob,Grep',
    '--json-schema',
    inlineSchema(role.schemaPath),
  ];
}

/**
 * Схема передаётся строкой, а не путём: файлового флага у CLI нет. Отсюда два
 * ограничения на эту строку, оба проверены на живом CLI.
 *
 * Однострочность. Когда на Windows рядом нет нативного claude.exe, commandSpec
 * пропускает claude через `cmd.exe /d /s /c claude.cmd`, а cmd.exe обрезает
 * командную строку на первом переводе строки — до сериализации сюда доходил
 * только «{», и каждое ревью падало с «--json-schema is not valid JSON».
 *
 * Отсутствие `$schema`. Валидатор CLI 2.1.229 не знает мета-схему
 * https://json-schema.org/draft/2020-12/schema и отклоняет весь аргумент:
 * «--json-schema is not a valid JSON Schema: no schema with key or ref …»,
 * exit 1, пустой stdout. Отказ наступает до старта сессии, то есть ронял
 * подряд все ревью и все milestone-ревью. Ключ снимается здесь, а не в файле
 * схемы: для Codex и для редактора объявленный диалект остаётся верным.
 */
function inlineSchema(schemaPath) {
  const source = readFileSync(schemaPath, 'utf8');
  try {
    const { $schema: _dialect, ...schema } = JSON.parse(source);
    return JSON.stringify(schema);
  } catch (error) {
    fail(`Некорректный JSON схемы ревью ${schemaPath}: ${error.message}`);
  }
}

function assistantText(parts) {
  return parts
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n');
}

function isSyntheticApiError(event) {
  return event.is_api_error_message === true || event.message?.model === '<synthetic>';
}

/**
 * Событие `result` — единственное место, где CLI сообщает цену сессии, и оно
 * приходит одинаково при успехе и при отказе. Поля берутся с проверкой типа:
 * при ошибке до первого запроса `usage` приходит пустым, а `total_cost_usd`
 * отсутствует, и ноль вместо «не сообщено» занизил бы сводку прогона.
 *
 * `reportedTurns` сохраняется рядом с собственным счётчиком, а не вместо него:
 * Ralph не считает шагом синтетический ответ на ошибку API, CLI считает, и
 * расхождение между двумя числами — признак транзиентных сбоев, а не дефекта.
 */
/**
 * Счётчики токенов из `usage`, под именами, которыми их знает сводка.
 *
 * Одна и та же форма приходит и в итоговом событии, и в каждом ответе
 * ассистента, поэтому разбор общий: по ответам сумма собирается на случай, если
 * итогового события не будет.
 */
function usageTokens(usage = {}) {
  const numberOrNull = (value) => (typeof value === 'number' ? value : null);

  return {
    uncachedInputTokens: numberOrNull(usage.input_tokens),
    outputTokens: numberOrNull(usage.output_tokens),
    cacheReadTokens: numberOrNull(usage.cache_read_input_tokens),
    cacheCreationTokens: numberOrNull(usage.cache_creation_input_tokens),
    thinkingTokens: numberOrNull(usage.output_tokens_details?.thinking_tokens),
  };
}

function claudeTelemetry(event) {
  const usage = event.usage ?? {};
  const numberOrNull = (value) => (typeof value === 'number' ? value : null);

  return {
    ...usageTokens(usage),
    reportedTurns: numberOrNull(event.num_turns),
    // Рассуждения тарифицируются как выход. Без отдельного числа «дорого ли
    // обходится effort» остаётся мнением: метка шага в логе для этого не
    // годится, она называет только первую часть сообщения.
    thinkingTokens: numberOrNull(usage.output_tokens_details?.thinking_tokens),
    // Имя отличается от `wallMs` сессии намеренно: оркестратор меряет жизнь
    // дочернего процесса, CLI — собственную работу, и это разные числа.
    cliWallMs: numberOrNull(event.duration_ms),
    apiMs: numberOrNull(event.duration_api_ms),
    costUsd: numberOrNull(event.total_cost_usd),
    // Имя называет ровно то, что в поле: `usage.input_tokens` — это вход, не
    // покрытый кэшем. Полный вход сессии складывается из него, записи кэша и
    // чтения кэша, и складывает его сводка. Прежнее имя `inputTokens` обещало
    // весь вход и показывало 0,06% от него.
    uncachedInputTokens: numberOrNull(usage.input_tokens),
    outputTokens: numberOrNull(usage.output_tokens),
    cacheReadTokens: numberOrNull(usage.cache_read_input_tokens),
    cacheCreationTokens: numberOrNull(usage.cache_creation_input_tokens),
    models: Object.keys(event.modelUsage ?? {}),
  };
}

function readClaudeEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  // Повторы запроса к API — единственный след того, что сессия не висит, а
  // ждёт. Раньше все события system отбрасывались, и run.log замолкал на всё
  // время отката без единой строки. Codex-backend такой дыры не имеет: он
  // выводит item.type === 'error'.
  if (event.type === 'system' && event.subtype === 'api_retry') {
    return {
      errorLog:
        `api_retry ${event.attempt}/${event.max_retries} status=${event.error_status} ` +
        `error=${event.error} повтор через ${event.retry_delay_ms} ms`,
    };
  }

  // Состояние квоты приходит отдельным событием и раньше молча отбрасывалось.
  // Пока окно открыто, оно шум; когда закрывается — это единственная строка,
  // объясняющая, почему прогон встал, и когда его можно продолжить.
  if (event.type === 'rate_limit_event') {
    const limit = event.rate_limit_info ?? {};
    if (limit.status === 'allowed') return {};
    const resets = Number.isFinite(limit.resetsAt)
      ? `, сброс в ${new Date(limit.resetsAt * 1000).toISOString()}`
      : '';
    return { errorLog: `квота ${limit.rateLimitType ?? 'без имени'}: ${limit.status}${resets}` };
  }

  // Шагом считается ответ ассистента: это та же единица, которую CLI сам
  // называет turn и возвращает в result.num_turns. Счётчик Codex ведётся по
  // item.id и охватывает ещё и выполненные команды, поэтому одно и то же
  // значение maxTurns ограничивает разный объём работы.
  // При ошибке API CLI подставляет собственное сообщение от лица ассистента:
  // `message.model === '<synthetic>'`, `is_api_error_message: true`. У него
  // обычный message.id, поэтому раньше оно считалось шагом и становилось
  // lastAgentMessage — то есть транзиентный 5xx съедал шаг из maxTurns и
  // подменял последнюю реплику агента текстом ошибки. Модель не работала, шага
  // быть не должно; оператору сообщение всё равно нужно, но как ошибка.
  if (event.type === 'assistant' && isSyntheticApiError(event)) {
    const text = assistantText(event.message?.content ?? []);
    return text ? { errorLog: text } : {};
  }

  if (event.type === 'assistant') {
    const parts = event.message?.content ?? [];
    const text = assistantText(parts);
    const tools = parts
      .filter((part) => part.type === 'tool_use')
      .map((part) => part.name)
      .join(', ');
    return {
      stepId: event.message?.id ?? event.uuid,
      stepLabel: tools ? `tool_use ${tools}` : 'assistant_message',
      log: text || undefined,
      agentMessage: text || undefined,
      // Счётчики за этот запрос. Итоговое событие точнее и перекроет их, но
      // при обрыве по лимиту шагов оно не приходит вовсе.
      usage: event.message?.usage ? usageTokens(event.message.usage) : undefined,
    };
  }

  // Результаты инструментов приходят отдельными событиями с ролью user. Без
  // них run.log Claude-сессии содержал бы только реплики модели, тогда как для
  // Codex туда попадает вывод выполненных команд.
  if (event.type === 'user') {
    const results = (event.message?.content ?? []).filter(
      (part) => part.type === 'tool_result',
    ).length;
    const output = (event.message?.content ?? [])
      .filter((part) => part.type === 'tool_result')
      .map((part) =>
        typeof part.content === 'string'
          ? part.content
          : (part.content ?? [])
              .filter((piece) => piece.type === 'text' && piece.text)
              .map((piece) => piece.text)
              .join('\n'),
      )
      .filter(Boolean)
      .join('\n')
      .replace(/\r?\n$/, '');

    // Счётчик ведётся по результатам, а не по меткам шагов: метка называет
    // только первую часть сообщения ассистента, поэтому шаг с вызовом
    // инструмента регулярно подписан как `assistant_message`. Результат же
    // приходит ровно один на выполненный вызов.
    return { toolResults: results, ...(output ? { log: outputTail(output) } : {}) };
  }

  if (event.type !== 'result') return {};

  const resultText = typeof event.result === 'string' ? event.result : '';
  // Телеметрия отдаётся на всех трёх выходах: сессия, оборвавшаяся по лимиту
  // шагов, стоит дороже успешной, и именно её цену нужно видеть.
  const telemetry = claudeTelemetry(event);
  if (!event.is_error) {
    return { agentMessage: resultText || undefined, telemetry };
  }

  // Единственное место, где виден отказ: код завершения остаётся нулевым и при
  // неавторизованном запуске, и при исчерпании собственного лимита шагов.
  if (event.subtype === 'error_max_turns') {
    const error = new Error(`Claude завершил сессию по собственному лимиту шагов. ${resultText}`);
    error.code = 'RALPH_MAX_TURNS';
    return { error, telemetry };
  }

  const error = new Error(`Claude завершил сессию с ошибкой: ${resultText || event.subtype}`);
  const code = sessionFailureCode(event, resultText);
  if (code) {
    error.code = code;
  }
  return { error, telemetry };
}

const authenticationStatuses = new Set([401]);

const authenticationTexts =
  /not logged in|authentication_failed|failed to authenticate|invalid api key|(?:api key|access token) is invalid/i;

/**
 * 403 «Request not allowed» — не отказ авторизации, хотя приходит под тем же
 * текстом «Failed to authenticate».
 *
 * Отличается он поведением: тот же токен работает минутой раньше и минутой
 * позже. За сутки этот код пришёл трижды — один раз положил девять
 * одновременных агентов разом, дважды пришёл в одиночную сессию, — и каждый раз
 * останавливал цикл на самом дорогом шаге. В справочнике ошибок Anthropic он не
 * описан вовсе; в трекере claude-code он тянется больше года как
 * перемежающийся сбой сервиса на активной подписке.
 *
 * Поэтому он получает свой код и повторяется, а фатальным остаётся 401 —
 * задокументированный отказ учётных данных, где повтор вернул бы то же самое.
 */
const transientRejectionTexts = /request not allowed/i;

export function sessionFailureCode(event, resultText) {
  const text = resultText || '';
  if (event.api_error_status === 403 || transientRejectionTexts.test(text)) {
    return 'RALPH_AGENT_REJECTED';
  }
  return isAuthenticationFailure(event, text) ? 'RALPH_AGENT_AUTH' : null;
}

/**
 * Отказ авторизации распознаётся по HTTP-статусу события, а не только по тексту.
 *
 * Реальное событие CLI 2.1.229 с протухшим токеном выглядит так:
 * `is_error: true`, `subtype: "success"`, `terminal_reason: "api_error"`,
 * `api_error_status: 401`, `result: "Failed to authenticate. API Error: 401
 * OAuth access token is invalid."` Ни «not logged in», ни «invalid api key» в
 * тексте нет, поэтому прежняя проверка только по тексту давала промах — и цена
 * промаха велика: с кодом RALPH_AGENT_AUTH цикл останавливается сразу, а без
 * него итерация считается обычным сбоем сессии, и Ralph сжигает все
 * maxIterations, каждый раз заново получая 401.
 *
 * Текстовая ветка остаётся второй опорой: 401 приходит не при каждом виде
 * отказа, а поле `api_error_status` появляется только у ошибок HTTP.
 */
function isAuthenticationFailure(event, resultText) {
  if (authenticationStatuses.has(event.api_error_status)) return true;
  return authenticationTexts.test(resultText || '');
}

export const claudeBackend = {
  cli: 'claude',
  binary: 'claude',
  label: 'Claude',
  reasoningEfforts,
  createSandboxedEnvironment: createSandboxedClaudeEnvironment,
  developmentArguments: developmentClaudeArguments,
  reviewArguments: reviewClaudeArguments,
  verifyAuthentication: verifyClaudeAuthentication,
  readEvent: readClaudeEvent,
  exitFailure: genericExitFailure,
  // Файлового флага для итогового сообщения у CLI нет, поэтому контракт
  // ревьюеров — «результат лежит в outputPath» — выполняет сам backend.
  writeReviewOutput(role, session) {
    writeFileSync(role.outputPath, session.lastAgentMessage ?? '', 'utf8');
  },
};

export async function runClaudeWithTurnLimit(args, options) {
  return runAgentSession(claudeBackend, args, options);
}

/**
 * Проверяется наличие учётных данных в окружении, а не ответ CLI:
 * `claude auth status` завершается кодом 0 и когда пользователь не авторизован,
 * а его OAuth-состояние всё равно не попадёт в изолированный CLAUDE_CONFIG_DIR
 * сессии.
 */
export function verifyClaudeAuthentication(dependencies = {}) {
  const credentials =
    dependencies.credentials ?? claudeCredentials(dependencies.env ?? process.env);
  if (Object.keys(credentials).length === 0) {
    throw missingClaudeCredentials();
  }
}
