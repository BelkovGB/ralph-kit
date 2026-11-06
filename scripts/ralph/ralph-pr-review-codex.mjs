import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createSandboxedCodexEnvironment } from './ralph-codex-session.mjs';
import { commandSpec, removeTemporaryDirectory } from './ralph-process-runner.mjs';
import { terminateProcessTreeByPid } from './ralph-runtime.mjs';

const TIMEOUT_MS = 90_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const codexArguments = [
  'app-server', '--listen', 'stdio://', '--strict-config',
  '-c', 'forced_login_method="chatgpt"',
  '-c', 'model_provider="openai"',
  '-c', 'web_search="disabled"',
  '-c', 'mcp_servers={}',
  '-c', 'project_doc_max_bytes=0',
  '-c', 'project_root_markers=[]',
  '-c', 'approval_policy="never"',
  '-c', 'default_permissions=":read-only"',
  '-c', 'skills.include_instructions=false',
  '-c', 'skills.bundled.enabled=false',
  '-c', 'orchestrator.skills.enabled=false',
  '-c', 'tools.update_plan.enabled=false',
  '-c', 'tools.experimental_request_user_input.enabled=false',
  '-c', 'features.skip_host_skill_discovery=true',
  ...[
    'shell_tool', 'shell_snapshot', 'hooks', 'apps', 'plugins', 'remote_plugin',
    'browser_use', 'computer_use', 'in_app_browser', 'view_image', 'image_generation',
    'multi_agent', 'multi_agent_v2', 'memories', 'request_permissions_tool',
    'skill_mcp_dependency_install', 'skill_search', 'tool_suggest', 'workspace_dependencies',
    'code_mode', 'goals', 'standalone_web_search',
  ].flatMap((name) => ['--disable', name]),
];

const allowedItems = new Set(['userMessage', 'agentMessage', 'reasoning']);

// Protocol errors and stderr may include credentials or untrusted text. Only
// fixed messages authored here are safe to show in the report.
export class CodexReviewFailure extends Error {}

function rejectUnexpectedEvent(event) {
  if ((Object.hasOwn(event, 'id') && Object.hasOwn(event, 'method')) ||
      event.method === 'thread/environment/connected' ||
      event.method === 'mcpServer/startupStatus/updated') {
    throw new CodexReviewFailure('Codex запросил возможность, недоступную для ревью.');
  }
  if (event.method === 'error' && event.params?.willRetry !== true) {
    throw new CodexReviewFailure('Codex завершил сессию ревью с ошибкой.');
  }
}

function checkItem(item) {
  if (!allowedItems.has(item?.type) || item.questions?.length) {
    throw new CodexReviewFailure('Codex попытался использовать инструмент во время ревью.');
  }
}

function checkTurnItems(turn) {
  if (!Array.isArray(turn?.items)) {
    throw new CodexReviewFailure('Codex вернул некорректное состояние ревью.');
  }
  for (const item of turn.items) checkItem(item);
}

async function reviewSession(child, lines, cwd, { input, instructions, model, schema }) {
  let lastId = 0;
  const messages = lines[Symbol.asyncIterator]();
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  const sendRequest = (method, params) => {
    lastId += 1;
    send({ id: lastId, method, params });
    return lastId;
  };
  const nextMessage = async () => {
    const { value, done } = await messages.next();
    if (done) throw new CodexReviewFailure('Codex закрыл сессию до готовности отчёта.');
    let event;
    try {
      event = JSON.parse(value);
    } catch {
      throw new CodexReviewFailure('Codex вернул некорректное сообщение.');
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new CodexReviewFailure('Codex вернул некорректное сообщение.');
    }
    rejectUnexpectedEvent(event);
    return event;
  };
  const request = async (method, params, failure) => {
    const id = sendRequest(method, params);
    for (;;) {
      const event = await nextMessage();
      if (Object.hasOwn(event, 'id')) {
        if (event.id !== id || event.error || !event.result) throw new CodexReviewFailure(failure);
        return event.result;
      }
      if (event.method === 'item/started' || event.method === 'item/completed') {
        throw new CodexReviewFailure('Codex начал работу до проверки настроек ревью.');
      }
    }
  };

  const identity = await request('initialize', {
    clientInfo: { name: 'ralph_pr_review', title: 'Ralph PR review', version: '1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  }, 'Не удалось открыть сессию Codex для ревью.');
  const version = /^ralph_pr_review\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(identity.userAgent);
  if (!version || (Number(version[1]) === 0 &&
      (Number(version[2]) < 153 || (Number(version[2]) === 153 && Number(version[3]) < 4)))) {
    throw new CodexReviewFailure('Для ревью нужен Codex CLI 0.153.4 или новее.');
  }
  send({ method: 'initialized' });
  const account = await request('account/read', { refreshToken: false }, 'Не удалось проверить вход в Codex.');
  if (account.account?.type !== 'chatgpt') {
    throw new CodexReviewFailure('Для ревью войдите в Codex через ChatGPT командой codex login.');
  }

  const thread = await request('thread/start', {
    cwd, model, modelProvider: 'openai', approvalPolicy: 'never', sandbox: 'read-only',
    ephemeral: true, environments: [], runtimeWorkspaceRoots: [], dynamicTools: [], selectedCapabilityRoots: [],
    baseInstructions: 'You are a code reviewer. Return only the requested structured review.',
    developerInstructions: instructions,
  }, 'Codex не открыл сессию без доступа к рабочему окружению.');
  const threadId = thread.thread?.id;
  if (typeof threadId !== 'string' || !threadId || thread.thread.ephemeral !== true ||
      thread.modelProvider !== 'openai' || thread.approvalPolicy !== 'never' ||
      thread.sandbox?.type !== 'readOnly' || thread.sandbox.networkAccess !== false ||
      !Array.isArray(thread.instructionSources) || thread.instructionSources.length !== 0) {
    throw new CodexReviewFailure('Codex не подтвердил ограничения сессии ревью.');
  }
  const mcp = await request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' },
    'Не удалось проверить настройки MCP в сессии ревью.');
  if (!Array.isArray(mcp.data) || mcp.data.length !== 0 || mcp.nextCursor !== null) {
    throw new CodexReviewFailure('В сессии ревью Codex доступны серверы MCP.');
  }

  const turnRequest = sendRequest('turn/start', {
    threadId, environments: [], effort: 'high', outputSchema: schema,
    input: [{ type: 'text', text: input, text_elements: [] }],
  });
  let turnId;
  let started = false;
  let completed = false;
  let finalText;
  let unphasedText;
  const correlate = (id) => {
    if (typeof id !== 'string' || !id || (turnId !== undefined && id !== turnId)) {
      throw new CodexReviewFailure('Codex вернул события разных сессий ревью.');
    }
    turnId = id;
  };

  while (!started || !completed) {
    const event = await nextMessage();
    const params = event.params;
    if (Object.hasOwn(event, 'id')) {
      if (event.id !== turnRequest || started || event.error) {
        throw new CodexReviewFailure('Codex не запустил ревью diff.');
      }
      correlate(event.result?.turn?.id);
      checkTurnItems(event.result.turn);
      started = true;
    } else if (event.method === 'item/started' || event.method === 'item/completed') {
      if (params?.threadId !== threadId) throw new CodexReviewFailure('Codex вернул события другой сессии.');
      correlate(params.turnId);
      checkItem(params.item);
      if (event.method === 'item/completed' && params.item.type === 'agentMessage') {
        const { phase, text } = params.item;
        // Older models can leave phase null. Only their last message can
        // supply the result, and only once the same turn reports completion.
        unphasedText = phase === null && typeof text === 'string' ? text : undefined;
        if (phase === 'final_answer') {
          if (finalText !== undefined || typeof text !== 'string') {
            throw new CodexReviewFailure('Codex вернул некорректный итог ревью.');
          }
          finalText = text;
        }
      }
    } else if (event.method === 'turn/started' || event.method === 'turn/completed') {
      if (params?.threadId !== threadId) throw new CodexReviewFailure('Codex вернул события другой сессии.');
      correlate(params.turn?.id);
      checkTurnItems(params.turn);
      if (event.method === 'turn/completed') {
        if (params.turn.status !== 'completed' || params.turn.error ||
            (finalText === undefined && unphasedText === undefined)) {
          throw new CodexReviewFailure('Codex не завершил ревью итоговым отчётом.');
        }
        completed = true;
      }
    }
  }
  return finalText ?? unphasedText;
}

export async function runCodexPrReview(options, dependencies = {}) {
  let sandbox;
  let child;
  let lines;
  let timeout;
  let close;
  let success = false;
  try {
    const { command, commandArgs } = (dependencies.commandSpec ?? commandSpec)('codex', codexArguments);
    sandbox = (dependencies.createEnvironment ?? createSandboxedCodexEnvironment)();
    const cwd = join(sandbox.root, 'review');
    mkdirSync(cwd);
    child = (dependencies.spawn ?? spawn)(command, commandArgs, {
      cwd, env: sandbox.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      detached: process.platform !== 'win32',
    });
    close = new Promise((resolve) => child.once('close', resolve));
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const failure = new Promise((_, reject) => {
      const connectionFailed = () => reject(new CodexReviewFailure('Не удалось обменяться данными с Codex CLI.'));
      child.once('error', connectionFailed);
      child.stdin.once('error', connectionFailed);
      let bytes = 0;
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_STDOUT_BYTES) reject(new CodexReviewFailure('Codex превысил лимит размера ответа.'));
      });
      timeout = setTimeout(() => reject(new CodexReviewFailure('Codex не завершил ревью за отведённое время.')),
        dependencies.timeoutMs ?? TIMEOUT_MS);
    });
    const text = await Promise.race([reviewSession(child, lines, cwd, options), failure]);
    success = true;
    return text;
  } catch (error) {
    if (error instanceof CodexReviewFailure) throw error;
    if (error?.code === 'RALPH_AGENT_AUTH') {
      throw new CodexReviewFailure('Для ревью войдите в Codex через ChatGPT командой codex login.');
    }
    throw new CodexReviewFailure('Не удалось запустить Codex CLI для ревью.');
  } finally {
    clearTimeout(timeout);
    lines?.close();
    if (child) {
      child.stdin.end();
      const stopped = success && await Promise.race([close.then(() => true), delay(500, false, { ref: false })]);
      if (!stopped && child.pid && child.exitCode === null && child.signalCode === null) {
        terminateProcessTreeByPid(child.pid, true);
        // Windows taskkill can fail in a restricted host. The process handle
        // still lets Node terminate the child it launched before cleanup.
        if (process.platform === 'win32') child.kill('SIGKILL');
        await Promise.race([close, delay(2_000, undefined, { ref: false })]);
      }
    }
    if (sandbox && !removeTemporaryDirectory(sandbox.root, { warn: () => {} })) {
      throw new CodexReviewFailure('Не удалось удалить временный каталог сессии Codex.');
    }
  }
}
