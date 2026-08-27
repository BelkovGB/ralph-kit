import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { run, runtimeSettings } from './ralph-process-runner.mjs';
import {
  agentProjectRoot,
  createSandboxRoot,
  genericExitFailure,
  runAgentSession,
} from './ralph-agent-session.mjs';

/**
 * Backend Codex CLI: аргументы ролей, изолированный CODEX_HOME и разбор
 * JSONL-потока `codex exec --json`.
 */

function codexAuthenticationFile(source = process.env) {
  const codexHome = source.CODEX_HOME?.trim();
  if (codexHome) return path.join(codexHome, 'auth.json');

  const userHome = source.USERPROFILE?.trim() || source.HOME?.trim();
  return userHome ? path.join(userHome, '.codex', 'auth.json') : null;
}

export function createSandboxedCodexEnvironment(source = process.env, options = {}) {
  const sandbox = createSandboxRoot(source, 'ralph-codex-');
  const codexHome = path.join(sandbox.root, 'codex');
  mkdirSync(codexHome, { recursive: true });

  const authenticationFile =
    options.authenticationFile === undefined
      ? codexAuthenticationFile(source)
      : options.authenticationFile;
  if (authenticationFile !== null) {
    try {
      if (!authenticationFile || !existsSync(authenticationFile)) {
        const error = new Error(
          'Codex auth.json не найден. Выполните `codex login`, затем повторите запуск Ralph.',
        );
        error.code = 'RALPH_AGENT_AUTH';
        throw error;
      }
      const sandboxedAuthenticationFile = path.join(codexHome, 'auth.json');
      copyFileSync(authenticationFile, sandboxedAuthenticationFile);
      chmodSync(sandboxedAuthenticationFile, 0o600);
      writeFileSync(path.join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (error) {
      sandbox.cleanup();
      throw error;
    }
  }

  return { root: sandbox.root, env: { ...sandbox.env, CODEX_HOME: codexHome } };
}

// Изолированный CODEX_HOME не содержит пользовательский config.toml, поэтому без
// явного override каждая роль получает текущий default CLI/модели. Передаём
// эффективное значение сами, чтобы поведение не менялось вместе с default.
export const reasoningEfforts = ['minimal', 'low', 'medium', 'high'];

export function reasoningEffortArguments(effort) {
  return ['-c', `model_reasoning_effort="${effort}"`];
}

export function developmentCodexArguments(config) {
  return [
    'exec',
    '--json',
    // Полный доступ к файловой системе: с ограниченной песочницей сессия
    // падает на записи вне рабочего дерева, и цикл уходит в бесконечный повтор
    // одной issue. Изоляцию даёт временный HOME, а не флаг.
    '--sandbox',
    'danger-full-access',
    '--model',
    config.developmentModel,
    ...reasoningEffortArguments(config.developmentEffort),
    '-C',
    agentProjectRoot,
    '-',
  ];
}

export function reviewCodexArguments(role) {
  return [
    'exec',
    '--sandbox',
    'read-only',
    '--json',
    '--model',
    role.model,
    ...reasoningEffortArguments(role.effort),
    '--output-schema',
    role.schemaPath,
    '--output-last-message',
    role.outputPath,
    '-',
  ];
}

export function agentReportedWriteAccessFailure(message) {
  return /(?:file system|filesystem|файловая система).{0,80}(?:read[- ]only|только для чтения)|(?:access|доступ).{0,40}(?:denied|запрещ[её]н)|(?:EPERM|EACCES).{0,80}(?:write|запис)/is.test(
    String(message ?? ''),
  );
}

function readCodexEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  const item = event.item;
  if (!item) return {};
  if (item.type === 'error') return { errorLog: item.message };

  const parsed = {};
  if ((event.type === 'item.started' || event.type === 'item.completed') && item.id) {
    parsed.stepId = item.id;
    parsed.stepLabel = item.type;
  }
  if (event.type === 'item.completed') {
    if (item.type === 'agent_message' && item.text) {
      parsed.agentMessage = item.text;
      parsed.log = item.text;
    } else if (item.type === 'command_execution' && item.aggregated_output) {
      parsed.log = item.aggregated_output.replace(/\r?\n$/, '');
    }
  }
  return parsed;
}

export const codexBackend = {
  cli: 'codex',
  binary: 'codex',
  label: 'Codex',
  reasoningEfforts,
  createSandboxedEnvironment: createSandboxedCodexEnvironment,
  developmentArguments: developmentCodexArguments,
  reviewArguments: reviewCodexArguments,
  verifyAuthentication: verifyCodexAuthentication,
  readEvent: readCodexEvent,
  exitFailure(result, stderr, label) {
    const error = genericExitFailure(result, stderr, label);
    if (/401 Unauthorized|Missing bearer or basic authentication/i.test(stderr)) {
      error.code = 'RALPH_AGENT_AUTH';
    }
    return error;
  },
};

export async function runCodexWithTurnLimit(args, options) {
  return runAgentSession(codexBackend, args, options);
}

export function verifyCodexAuthentication(dependencies = {}) {
  const execute = dependencies.run ?? run;
  const childEnvironment = createSandboxedCodexEnvironment(dependencies.env ?? process.env, {
    authenticationFile: dependencies.authenticationFile,
  });
  try {
    execute('codex', ['login', 'status'], {
      env: childEnvironment.env,
      timeoutMs: runtimeSettings().commandTimeoutMs,
    });
  } catch (cause) {
    const error = new Error(
      'Изолированный Codex не авторизован. Выполните `codex login` и повторите запуск Ralph.',
      { cause },
    );
    error.code = 'RALPH_AGENT_AUTH';
    throw error;
  } finally {
    rmSync(childEnvironment.root, { recursive: true, force: true });
  }
}
