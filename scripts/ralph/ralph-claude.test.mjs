import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  agentBackend,
  agentBinary,
  reasoningEffortsFor,
  runReviewSession,
} from './ralph-agent-backends.mjs';
import {
  claudeBackend,
  claudeCredentialVariables,
  createSandboxedClaudeEnvironment,
  developmentClaudeArguments,
  reviewClaudeArguments,
  runClaudeWithTurnLimit,
  verifyClaudeAuthentication,
  sessionFailureCode,
} from './ralph-claude-session.mjs';
import { addUsage } from './ralph-agent-session.mjs';
import { withFakeClaude } from './ralph-test-support.mjs';

const schemaPath = fileURLToPath(new URL('../../.agents/review.schema.json', import.meta.url));

// Схема, какой её обязан получить CLI: файл целиком, но без объявления диалекта.
function schemaWithoutDialect() {
  const { $schema: _dialect, ...schema } = JSON.parse(readFileSync(schemaPath, 'utf8'));
  return schema;
}

test('agentCli selects the backend and its reasoning-effort vocabulary', () => {
  assert.equal(agentBackend({ agentCli: 'claude' }).cli, 'claude');
  assert.equal(agentBackend({ agentCli: 'codex' }).cli, 'codex');
  // Отсутствие поля — это Codex: конфигурация без `agentCli` работает без
  // правки.
  assert.equal(agentBackend({}).cli, 'codex');
  assert.equal(agentBinary({ agentCli: 'claude' }), 'claude');

  assert.deepEqual(reasoningEffortsFor('codex'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(reasoningEffortsFor('claude'), ['low', 'medium', 'high', 'xhigh', 'max']);
  // Словари не совпадают, поэтому одна общая проверка усилий была бы неверной
  // ровно для этих значений.
  assert.equal(reasoningEffortsFor('claude').includes('minimal'), false);
  assert.equal(reasoningEffortsFor('codex').includes('xhigh'), true);
});

test('claude arguments always carry --verbose alongside stream-json', () => {
  // Без --verbose CLI завершается кодом 1 и пустым stdout: сессия не стартует
  // вообще, а причина видна только в stderr.
  for (const args of [
    developmentClaudeArguments({ developmentModel: 'claude-opus-5', developmentEffort: 'medium' }),
    reviewClaudeArguments({
      model: 'claude-opus-5',
      effort: 'high',
      schemaPath,
      outputPath: 'unused',
    }),
  ]) {
    assert.equal(args.includes('--verbose'), true);
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(args.includes('-p'), true);
  }
});

test('both roles keep the cached prefix free of per-machine sections', () => {
  // Каждая сессия получает свой mkdtemp-HOME, и его путь попадает в секцию
  // памяти системного промпта: без флага префикс двух соседних сессий
  // расходится и кэш не переиспользуется — вторая сессия создаёт префикс
  // заново вместо того, чтобы прочитать готовый.
  for (const args of [
    developmentClaudeArguments({ developmentModel: 'claude-opus-5', developmentEffort: 'medium' }),
    reviewClaudeArguments({
      model: 'claude-opus-5',
      effort: 'high',
      schemaPath,
      outputPath: 'unused',
    }),
  ]) {
    assert.equal(args.includes('--exclude-dynamic-system-prompt-sections'), true);
  }
});

test('the development role is not handed tools it never calls', () => {
  // Схемы инструментов лежат в кэшируемом префиксе и оплачиваются каждой
  // сессией: полный набор стоит заметно дороже урезанного.
  const args = developmentClaudeArguments({
    developmentModel: 'claude-opus-5',
    developmentEffort: 'medium',
  });
  const denied = args[args.indexOf('--disallowedTools') + 1].split(',');

  assert.equal(denied.includes('Workflow'), true);
  assert.equal(denied.includes('WebSearch'), true);
  // Инструменты реализации остаются: без них итерация не сможет закончиться.
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']) {
    assert.equal(denied.includes(tool), false);
  }
  // WebFetch — единственный запрет, способный превратиться в заблокированную
  // итерацию: контракт issue иногда живёт во внешней документации.
  assert.equal(denied.includes('WebFetch'), false);
});

test('tool calls are counted from results, not from the step label', () => {
  // Шаг с вызовом инструмента регулярно подписан как `assistant_message`:
  // метка берётся из первой части сообщения. Результат приходит ровно один на
  // выполненный вызов, поэтому считается он.
  const twoResults = claudeBackend.readEvent(
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', content: 'первый' },
          { type: 'tool_result', content: 'второй' },
        ],
      },
    }),
  );
  assert.equal(twoResults.toolResults, 2);
  assert.match(twoResults.log, /первый/);

  // Пустой результат ничего не печатает, но считается.
  const empty = claudeBackend.readEvent(
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '' }] } }),
  );
  assert.equal(empty.toolResults, 1);
  assert.equal(empty.log, undefined);
});

test('reasoning is measured in tokens, not guessed from the log', () => {
  const result = claudeBackend.readEvent(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      num_turns: 3,
      total_cost_usd: 1.25,
      usage: { output_tokens: 900, output_tokens_details: { thinking_tokens: 780 } },
    }),
  );

  assert.equal(result.telemetry.thinkingTokens, 780);
  assert.equal(result.telemetry.outputTokens, 900);
  assert.equal(result.telemetry.costUsd, 1.25);
});

test('a session killed by the step limit still reports what it spent', () => {
  // При обрыве по лимиту CLI не успевает прислать итоговое событие, поэтому
  // расход считается по ходу сессии: иначе самая дорогая из них — та, что
  // упёрлась в лимит шагов, — осталась бы единственной без чисел.
  const first = claudeBackend.readEvent(
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'иду' }],
        usage: { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1_000 },
      },
    }),
  );
  assert.deepEqual(first.usage.outputTokens, 100);
  assert.equal(first.usage.thinkingTokens, null);

  const second = { outputTokens: 40, cacheReadTokens: 2_000, thinkingTokens: 30 };
  const total = addUsage(addUsage(null, first.usage), second);

  assert.equal(total.outputTokens, 140);
  assert.equal(total.cacheReadTokens, 3_000);
  // Поле, пришедшее только во втором ответе, начинает считаться с него.
  assert.equal(total.thinkingTokens, 30);
  // Ни разу не сообщённое поле остаётся null, а не нулём: ноль в сводке
  // читается как измеренная величина.
  assert.equal(total.cacheCreationTokens, null);
});

test('a closed quota window is reported instead of being swallowed', () => {
  const open = claudeBackend.readEvent(
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
  );
  assert.deepEqual(open, {});

  const closed = claudeBackend.readEvent(
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1786933800 },
    }),
  );

  assert.match(closed.errorLog, /квота five_hour: rejected/);
  assert.match(closed.errorLog, /2026-08-17T/);
  // Событие не должно считаться шагом: иначе ожидание съедало бы maxTurns.
  assert.equal(closed.stepId, undefined);
});

test('the claude review role gets a read-only tool set and an inline schema', () => {
  const args = reviewClaudeArguments({
    model: 'claude-opus-5',
    effort: 'high',
    schemaPath,
    outputPath: 'unused',
  });

  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  // Флага --output-schema с путём у CLI нет: схема передаётся строкой.
  assert.equal(args.includes('--output-schema'), false);
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), schemaWithoutDialect());
});

test('the inline review schema drops the $schema key the CLI cannot resolve', () => {
  // Валидатор CLI 2.1.229 не знает мета-схему 2020-12 и отклоняет весь аргумент
  // до старта сессии: «--json-schema is not a valid JSON Schema: no schema with
  // key or ref …», exit 1, пустой stdout. Отказ роняет каждое ревью, поэтому
  // ключ обязан отсутствовать в аргументе — а в самом файле схемы остаться.
  const onDisk = JSON.parse(readFileSync(schemaPath, 'utf8'));
  assert.equal(typeof onDisk.$schema, 'string');

  const args = reviewClaudeArguments({
    model: 'claude-opus-5',
    effort: 'high',
    schemaPath,
    outputPath: 'unused',
  });
  const inline = args[args.indexOf('--json-schema') + 1];

  assert.equal(Object.hasOwn(JSON.parse(inline), '$schema'), false);
  // Однострочность — второе требование того же аргумента: при откате на
  // cmd.exe командная строка обрезается на первом переводе строки.
  assert.equal(inline.includes('\n'), false);
  // Всё остальное обязано дойти без потерь.
  assert.deepEqual(JSON.parse(inline), schemaWithoutDialect());
});

test('the claude sandbox isolates HOME and carries only the credentials', () => {
  // Обе переменные годятся, и это не одно и то же: токен из `claude
  // setup-token` работает по подписке, API-ключ тарифицируется отдельно.
  for (const variable of claudeCredentialVariables) {
    const source = {
      PATH: process.env.PATH,
      [variable]: 'secret-credential',
      GH_TOKEN: 'must-not-leak',
      HOME: 'C:/Users/operator',
      CLAUDE_CONFIG_DIR: 'C:/Users/operator/.claude',
    };
    const sandbox = createSandboxedClaudeEnvironment(source);

    try {
      assert.equal(sandbox.env[variable], 'secret-credential', variable);
      assert.equal(sandbox.env.GH_TOKEN, undefined);
      assert.notEqual(sandbox.env.HOME, source.HOME);
      assert.notEqual(sandbox.env.CLAUDE_CONFIG_DIR, source.CLAUDE_CONFIG_DIR);
      assert.match(sandbox.env.CLAUDE_CONFIG_DIR, /ralph-claude-/);
      // cwd сессии — корень репозитория, куда она же пишет с полным доступом,
      // поэтому cmd.exe не должен искать команду в текущем каталоге.
      assert.equal(
        sandbox.env.NoDefaultCurrentDirectoryInExePath,
        process.platform === 'win32' ? '1' : undefined,
      );
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
});

test('a claude session without credentials stops before the process starts', () => {
  assert.throws(
    () => createSandboxedClaudeEnvironment({ PATH: process.env.PATH }),
    (error) => {
      assert.equal(error.code, 'RALPH_AGENT_AUTH');
      // Сообщение обязано назвать оба пути и подсказать дешёвый.
      assert.match(error.message, /CLAUDE_CODE_OAUTH_TOKEN/);
      assert.match(error.message, /ANTHROPIC_API_KEY/);
      assert.match(error.message, /claude setup-token/);
      return true;
    },
  );
  assert.throws(() => verifyClaudeAuthentication({ env: {} }), /CLAUDE_CODE_OAUTH_TOKEN/);
  // Достаточно любой одной переменной.
  verifyClaudeAuthentication({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'token' } });
  verifyClaudeAuthentication({ env: { ANTHROPIC_API_KEY: 'key' } });
});

// Поддельный CLI записывает полученный argv: аргумент, обрезанный cmd.exe,
// иначе выглядел бы как успешный прогон.
const claudeStreamScript = (events) => `
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

writeFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'received-argv.json'),
  JSON.stringify(process.argv.slice(2)),
);

const lines = ${JSON.stringify(events)};
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n');
  process.exit(0);
});
`;

const assistantEvent = (id, text) => ({
  type: 'assistant',
  message: { id, role: 'assistant', content: [{ type: 'text', text }] },
});

test('tool output reaches the log the same way Codex command output does', () => {
  // Без разбора события user в run.log Claude-сессии остались бы только реплики
  // модели, тогда как для Codex туда попадает aggregated_output команд.
  const stringContent = claudeBackend.readEvent(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: '12 passed\n' }] },
    }),
  );
  assert.equal(stringContent.log, '12 passed');

  const blockContent = claudeBackend.readEvent(
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'build ok' }] }],
      },
    }),
  );
  assert.equal(blockContent.log, 'build ok');

  // Событие без вывода не должно печатать пустую строку.
  assert.equal(
    claudeBackend.readEvent(JSON.stringify({ type: 'user', message: { content: [] } })).log,
    undefined,
  );
  // Результат инструмента шагом не считается: шаги — это ответы модели.
  assert.equal(stringContent.stepId, undefined);
});

test('a claude session counts assistant turns and returns the final message', async () => {
  await withFakeClaude(
    claudeStreamScript([
      { type: 'system', subtype: 'init' },
      assistantEvent('msg-1', 'first'),
      assistantEvent('msg-2', 'second'),
      { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2 },
    ]),
    async () => {
      const session = await runClaudeWithTurnLimit(
        developmentClaudeArguments({
          developmentModel: 'claude-opus-5',
          developmentEffort: 'medium',
        }),
        { input: 'work', maxTurns: 10, timeoutMs: 60_000, label: 'Claude test' },
      );

      assert.equal(session.turns, 2);
      assert.equal(session.lastAgentMessage, 'done');
    },
  );
});

test('an unauthenticated claude session fails even though the CLI exits 0', async () => {
  // Самое опасное расхождение с Codex: без этой проверки полностью
  // неавторизованный прогон выглядел бы успешной сессией с пустым diff, и цикл
  // ушёл бы в ветку «изменений нет» вместо остановки.
  await withFakeClaude(
    claudeStreamScript([
      { type: 'system', subtype: 'init' },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        result: 'Not logged in · Please run /login',
      },
    ]),
    async () => {
      await assert.rejects(
        runClaudeWithTurnLimit(
          developmentClaudeArguments({
            developmentModel: 'claude-opus-5',
            developmentEffort: 'medium',
          }),
          { input: 'work', maxTurns: 10, timeoutMs: 60_000, label: 'Claude test' },
        ),
        (error) => {
          assert.equal(error.code, 'RALPH_AGENT_AUTH');
          return true;
        },
      );
    },
  );
});

test('a synthetic API-error message is an error, not an agent step', () => {
  // При ошибке API CLI подставляет сообщение от лица ассистента с обычным
  // message.id. Считайся оно шагом, транзиентный 5xx съедал бы шаг из maxTurns
  // и подменял бы собой lastAgentMessage — COMMIT_MESSAGE агента и вердикт
  // ревью терялись бы, а вину за исчерпанный лимит шагов Ralph приписывал бы
  // агенту в комментарии к issue.
  const synthetic = claudeBackend.readEvent(
    JSON.stringify({
      type: 'assistant',
      is_api_error_message: true,
      message: {
        id: 'msg-synthetic',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'API Error: 500 Internal server error' }],
      },
    }),
  );

  assert.equal(synthetic.stepId, undefined);
  assert.equal(synthetic.agentMessage, undefined);
  // Оператору сообщение нужно, но как ошибка, а не как реплика агента.
  assert.equal(synthetic.errorLog, 'API Error: 500 Internal server error');

  // Обычный ответ ассистента шагом остаётся.
  const genuine = claudeBackend.readEvent(
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-real',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'COMMIT_MESSAGE: fix: real work' }],
      },
    }),
  );
  assert.equal(genuine.stepId, 'msg-real');
  assert.equal(genuine.agentMessage, 'COMMIT_MESSAGE: fix: real work');
});

test('api_retry events reach the log instead of leaving it silent', () => {
  // Без этой ветки run.log молчит всё время отката: события system
  // отбрасываются целиком, и оператор не отличает ожидание от зависания.
  const retry = claudeBackend.readEvent(
    JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 1099,
      error_status: 401,
      error: 'authentication_failed',
    }),
  );

  assert.match(retry.errorLog, /api_retry 2\/10/);
  assert.match(retry.errorLog, /status=401/);
  // Повтор — не шаг агента и не его реплика.
  assert.equal(retry.stepId, undefined);
  assert.equal(retry.agentMessage, undefined);

  // Остальные system-события шумом не идут.
  assert.deepEqual(
    claudeBackend.readEvent(JSON.stringify({ type: 'system', subtype: 'init' })),
    {},
  );
});

test('a 401 from the real CLI is an auth failure even though its text matches no keyword', () => {
  // Событие записано с живого claude.exe 2.1.229 при протухшем
  // CLAUDE_CODE_OAUTH_TOKEN. Ни «not logged in», ни «invalid api key» в тексте
  // нет, а subtype равен "success" — распознать отказ можно только по статусу.
  const recorded = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 401,
    result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
  };

  assert.equal(claudeBackend.readEvent(JSON.stringify(recorded)).error.code, 'RALPH_AGENT_AUTH');
  // Цена промаха — не косметика: RALPH_AGENT_AUTH останавливает цикл, а без
  // него итерация считается обычным сбоем сессии и Ralph повторяет её
  // maxIterations раз, каждый раз получая тот же 401.
  //
  // 401 и 403 — разные отказы: 401 гасит рабочий токен насовсем, а 403
  // приходит на живом токене и уходит сам. Свой код делает его повторяемым:
  // иначе он останавливает цикл на самом дорогом шаге.
  assert.equal(
    claudeBackend.readEvent(
      JSON.stringify({ ...recorded, api_error_status: 403, result: 'Forbidden' }),
    ).error.code,
    'RALPH_AGENT_REJECTED',
  );
  // Текстовая ветка остаётся: статус приходит не при каждом виде отказа.
  assert.equal(
    claudeBackend.readEvent(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
      }),
    ).error.code,
    'RALPH_AGENT_AUTH',
  );
  // Прочие отказы не должны выдавать себя за отказ авторизации: цикл на них
  // обязан продолжиться, а не остановиться.
  assert.equal(
    claudeBackend.readEvent(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 500,
        result: 'API Error: 500 Internal server error',
      }),
    ).error.code,
    undefined,
  );
});

test('the claude native turn limit is reported as RALPH_MAX_TURNS despite exit 0', async () => {
  await withFakeClaude(
    claudeStreamScript([
      assistantEvent('msg-1', 'partial'),
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: '' },
    ]),
    async () => {
      await assert.rejects(
        runClaudeWithTurnLimit(
          developmentClaudeArguments({
            developmentModel: 'claude-opus-5',
            developmentEffort: 'medium',
          }),
          { input: 'work', maxTurns: 10, timeoutMs: 60_000, label: 'Claude test' },
        ),
        (error) => {
          assert.equal(error.code, 'RALPH_MAX_TURNS');
          return true;
        },
      );
    },
  );
});

test("Ralph's own step limit stops a claude session that ignores it", async () => {
  await withFakeClaude(
    claudeStreamScript([
      assistantEvent('msg-1', 'one'),
      assistantEvent('msg-2', 'two'),
      assistantEvent('msg-3', 'three'),
      { type: 'result', subtype: 'success', is_error: false, result: 'done' },
    ]),
    async () => {
      await assert.rejects(
        runClaudeWithTurnLimit(
          developmentClaudeArguments({
            developmentModel: 'claude-opus-5',
            developmentEffort: 'medium',
          }),
          { input: 'work', maxTurns: 2, timeoutMs: 60_000, label: 'Claude test' },
        ),
        (error) => {
          assert.equal(error.code, 'RALPH_MAX_TURNS');
          assert.equal(error.turns, 2);
          return true;
        },
      );
    },
  );
});

test('a claude review writes its verdict to the outputPath the orchestrator reads', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-claude-review-'));
  const outputPath = path.join(directory, 'review.json');
  const verdict = { verdict: 'pass', summary: 'Looks fine.', findings: [] };

  try {
    await withFakeClaude(
      claudeStreamScript([
        assistantEvent('msg-1', 'reading'),
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: JSON.stringify(verdict),
        },
      ]),
      async ({ receivedArguments }) => {
        await runReviewSession(
          { agentCli: 'claude' },
          { model: 'claude-opus-5', effort: 'high', schemaPath, outputPath },
          { input: 'review', maxTurns: 10, timeoutMs: 60_000, label: 'Claude review' },
        );

        // Схема должна дойти до процесса целиком. На Windows аргументы проходят
        // через cmd.exe, который обрезает командную строку на первом переводе
        // строки: pretty-printed схема дошла бы как «{», и ревью падало бы всегда.
        const received = receivedArguments();
        const schemaArgument = received[received.indexOf('--json-schema') + 1];
        assert.deepEqual(JSON.parse(schemaArgument), schemaWithoutDialect());
        assert.equal(received.at(-1), schemaArgument);
      },
    );

    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), verdict);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the codex backend keeps writing its own review output file', () => {
  // Codex пишет файл сам флагом --output-last-message, поэтому backend не
  // должен его перезаписывать: иначе схема-валидированный вывод затёрся бы
  // последним текстовым сообщением.
  assert.equal(claudeBackend.writeReviewOutput === undefined, false);
  assert.equal(agentBackend({ agentCli: 'codex' }).writeReviewOutput, undefined);

  const args = agentBackend({ agentCli: 'codex' }).reviewArguments({
    model: 'gpt-5.6-terra',
    effort: 'medium',
    schemaPath: 'schema.json',
    outputPath: 'out.json',
  });
  assert.equal(args[args.indexOf('--output-last-message') + 1], 'out.json');
  assert.equal(args[args.indexOf('--output-schema') + 1], 'schema.json');
});

test('the fake-claude output file stays a valid review payload path', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-claude-write-'));
  const outputPath = path.join(directory, 'nested', 'review.json');

  try {
    writeFileSync(path.join(directory, 'marker'), 'x', 'utf8');
    assert.throws(() =>
      claudeBackend.writeReviewOutput({ outputPath }, { lastAgentMessage: '{}' }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('403 «Request not allowed» повторяется, 401 остаётся фатальным', () => {
  // Оба приходят под текстом «Failed to authenticate», но означают разное:
  // 403 приходит на рабочем токене и уходит сам, поэтому он повторяется: без
  // своего кода он останавливал бы цикл на самом дорогом шаге — финальном
  // ревью milestone.
  assert.equal(
    sessionFailureCode(
      { api_error_status: 403 },
      'Failed to authenticate. API Error: 403 Request not allowed',
    ),
    'RALPH_AGENT_REJECTED',
  );
  // Статуса может не быть — тогда решает текст.
  assert.equal(
    sessionFailureCode({}, 'Failed to authenticate. API Error: 403 Request not allowed'),
    'RALPH_AGENT_REJECTED',
  );

  // 401 — задокументированный отказ учётных данных: повтор вернёт то же самое.
  assert.equal(
    sessionFailureCode(
      { api_error_status: 401 },
      'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
    ),
    'RALPH_AGENT_AUTH',
  );
  assert.equal(sessionFailureCode({}, 'not logged in'), 'RALPH_AGENT_AUTH');

  // Обычный сбой сессии кода не получает и обрабатывается как всегда.
  assert.equal(sessionFailureCode({}, 'Something else went wrong'), null);
});
