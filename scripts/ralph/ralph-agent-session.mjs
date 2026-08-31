import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { retryDelayMs, terminateProcessTreeByPid, waitSync } from './ralph-runtime.mjs';
import {
  commandSpec,
  credentialFreeEnvironment,
  outputTail,
  removeTemporaryDirectory,
  runtimeSettings,
  windowsSafeCommandEnvironment,
} from './ralph-process-runner.mjs';

/**
 * Запуск сессии агента: один процесс, один поток событий, один лимит шагов.
 *
 * Всё, что не зависит от конкретного CLI, живёт здесь: песочница файловой
 * системы, spawn, буферизация stdout, счётчик шагов, wall-clock timeout и
 * завершение дерева процессов. Различия каждого CLI описывает backend —
 * `ralph-codex-session.mjs` или `ralph-claude-session.mjs`.
 */

// Пути выводятся здесь заново по той же причине, что и в
// `ralph-process-runner.mjs`: импорт из модуля конфигурации создал бы цикл.
export const agentProjectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

// -----------------------------------------------------------------------------
// Песочница файловой системы, общая для обоих CLI
// -----------------------------------------------------------------------------

// Изолированный HOME отрезает пользовательский конфиг агента: скиллы, плагины,
// MCP-серверы и правила, которых нет в доверенном control plane. Каталог для
// учётных данных создаёт backend: у каждого CLI он свой.
export function createSandboxRoot(source, prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  const config = path.join(root, 'config');
  const cache = path.join(root, 'cache');
  for (const directory of [home, temp, config, cache]) {
    mkdirSync(directory, { recursive: true });
  }

  return {
    root,
    cleanup: () => removeTemporaryDirectory(root),
    env: {
      ...credentialFreeEnvironment(source),
      // cwd сессии — корень репозитория, куда сама же сессия пишет с полным
      // доступом, поэтому cmd.exe нельзя оставлять с поиском в текущем каталоге.
      ...windowsSafeCommandEnvironment,
      HOME: home,
      USERPROFILE: home,
      APPDATA: config,
      LOCALAPPDATA: config,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
    },
  };
}

// -----------------------------------------------------------------------------
// Завершение дерева процессов
// -----------------------------------------------------------------------------

function terminateProcessTree(child, force = false) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  terminateProcessTreeByPid(child.pid, force);
}

async function waitForChildTermination(child, childResult, graceMs) {
  let timer;
  const completed = await Promise.race([
    childResult.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (completed) return;

  terminateProcessTree(child, true);
  await Promise.race([
    childResult.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

/**
 * Складывает счётчики токенов, сохраняя различие между нулём и «не сообщено».
 * Поле, которого backend не присылает ни разу, обязано остаться null: ноль в
 * сводке читается как измеренная величина.
 */
export function addUsage(total, usage) {
  const sum = { ...(total ?? {}) };
  for (const [field, value] of Object.entries(usage)) {
    if (typeof value === 'number') {
      sum[field] = (typeof sum[field] === 'number' ? sum[field] : 0) + value;
    } else if (!(field in sum)) {
      // Поле остаётся в записи как null, а не исчезает: форма сводки не должна
      // зависеть от того, что backend прислал в конкретном ответе.
      sum[field] = null;
    }
  }

  return sum;
}

// -----------------------------------------------------------------------------
// Circuit breaker: лимит шагов и wall-clock timeout
// -----------------------------------------------------------------------------

/**
 * backend описывает единственное, что различается между CLI:
 *
 * - `binary` — имя исполняемого файла;
 * - `createSandboxedEnvironment(source, options)` — песочница с учётными данными;
 * - `readEvent(line)` — разбор одной строки stdout. Возвращает `null`, если
 *   строка не разобрана (её печатают как есть), иначе объект с полями
 *   `stepId`, `log`, `agentMessage`, `error`, `telemetry`, `toolResults`;
 * - `exitFailure(result, stderr)` — Error по коду завершения, если backend
 *   умеет распознать причину точнее общего сообщения.
 *
 * `telemetry` — цена сессии по данным самого CLI: шаги, токены, стоимость.
 * Backend волен её не присылать; тогда в сводке остаётся только измеренное
 * оркестратором время и собственный счётчик шагов.
 */
export async function runAgentSession(backend, args, options) {
  const sessionStartedMs = Date.now();
  const { command, commandArgs } = commandSpec(backend.binary, args);
  const childEnvironment = backend.createSandboxedEnvironment(options.env ?? process.env, {
    authenticationFile: options.authenticationFile,
  });
  let child;
  try {
    child = spawn(command, commandArgs, {
      cwd: agentProjectRoot,
      env: childEnvironment.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (error) {
    removeTemporaryDirectory(childEnvironment.root);
    throw error;
  }
  const cleanupChildEnvironment = () => removeTemporaryDirectory(childEnvironment.root);
  child.once('error', cleanupChildEnvironment);
  child.once('close', cleanupChildEnvironment);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stderr = '';
  let stdoutBuffer = '';
  let lastAgentMessage = '';
  // Счётчик шагов текущей сессии агента.
  let turns = 0;
  let limitReached = false;
  let wallTimeoutReached = false;
  // Claude CLI завершается кодом 0 и при отказе авторизации, и при собственном
  // лимите шагов: единственный признак отказа приходит в потоке событий.
  let streamError = null;
  let backendTelemetry = null;
  let accumulatedUsage = null;
  let toolResults = 0;
  let resolveTurnLimit;
  const seenStepIds = new Set();
  // Считается один раз на сообщение: одно сообщение — один запрос к API, и
  // повторное событие с тем же id удвоило бы его расход.
  const countedUsageIds = new Set();

  // Сводка снимается в момент выхода, а выходов у сессии шесть, включая четыре
  // аварийных. Дороже всех именно они: оборванная по лимиту сессия успевает
  // потратить весь бюджет, и без её цены сводка прогона занижена.
  //
  // Итоговое событие CLI точнее, но при обрыве по лимиту шагов процесс убивают
  // до него, и оборванная сессия остаётся без чисел. Поэтому суммы
  // накапливаются по ходу, а итоговые перекрывают их — но только теми полями,
  // которые в них действительно есть.
  const reportedFields = (telemetry) =>
    Object.fromEntries(Object.entries(telemetry ?? {}).filter(([, value]) => value !== null));
  const sessionTelemetry = () => ({
    turns,
    toolResults,
    wallMs: Date.now() - sessionStartedMs,
    ...(accumulatedUsage ?? {}),
    ...reportedFields(backendTelemetry),
  });

  const handleLine = (line) => {
    if (line.trim() === '') {
      return;
    }

    const event = backend.readEvent(line);
    if (!event) {
      // Строка обрезается: единственный гарантированный источник неразобранной
      // строки — обрыв процесса circuit breaker'ом посреди события, а событие с
      // выводом инструмента бывает в сотни килобайт. Целиком такой блок лёг бы
      // в run.log сразу после сообщения breaker'а, ради которого журнал и читают.
      console.log(`[${backend.label}] неразобранная строка: ${outputTail(line)}`);
      return;
    }

    if (event.agentMessage) lastAgentMessage = event.agentMessage;
    if (event.error) streamError ??= event.error;
    if (event.telemetry) backendTelemetry = event.telemetry;
    if (event.toolResults) toolResults += event.toolResults;
    if (event.usage && event.stepId != null && !countedUsageIds.has(event.stepId)) {
      countedUsageIds.add(event.stepId);
      accumulatedUsage = addUsage(accumulatedUsage, event.usage);
    }

    let currentTurn = null;
    if (event.stepId !== undefined && event.stepId !== null && !seenStepIds.has(event.stepId)) {
      // Проверяем лимит до запуска следующего уникального шага.
      if (turns >= options.maxTurns) {
        if (limitReached) return;
        limitReached = true;
        console.error(
          `\nCircuit breaker: ${options.label} попытался превысить лимит ${options.maxTurns} шагов.`,
        );
        terminateProcessTree(child);
        resolveTurnLimit({ code: null, signal: 'RALPH_MAX_TURNS' });
        return;
      }

      seenStepIds.add(event.stepId);
      turns += 1;
      currentTurn = turns;
    }

    if (currentTurn !== null && event.stepLabel) {
      console.log(`[${backend.label} step ${currentTurn}/${options.maxTurns}] ${event.stepLabel}`);
    }
    if (event.log) console.log(event.log);
    if (event.errorLog) console.error(`[${backend.label}] ${event.errorLog}`);
  };

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      handleLine(line);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    console.error(chunk.replace(/\r?\n$/, ''));
  });

  const childResult = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const turnLimitResult = new Promise((resolve) => {
    resolveTurnLimit = resolve;
  });
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') {
      console.error(`Ошибка stdin ${backend.label}: ${error.message}`);
    }
  });

  child.stdin.end(options.input);
  const timeoutMs = options.timeoutMs ?? runtimeSettings().agentTimeoutMs;
  let wallTimer;
  const wallTimeout = new Promise((resolve) => {
    wallTimer = setTimeout(() => {
      wallTimeoutReached = true;
      console.error(`\nCircuit breaker: ${options.label} превысил ${timeoutMs} ms.`);
      terminateProcessTree(child);
      resolve({ code: null, signal: 'RALPH_WALL_TIMEOUT' });
    }, timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([childResult, wallTimeout, turnLimitResult]);
  } finally {
    clearTimeout(wallTimer);
  }
  if (limitReached || wallTimeoutReached) {
    await waitForChildTermination(child, childResult, 10_000);
  }
  if (stdoutBuffer.trim() !== '') {
    handleLine(stdoutBuffer);
  }

  if (limitReached) {
    const error = new Error(`${options.label} достиг лимита maxTurns=${options.maxTurns}.`);
    error.code = 'RALPH_MAX_TURNS';
    error.turns = turns;
    error.telemetry = sessionTelemetry();
    throw error;
  }

  if (wallTimeoutReached) {
    const error = new Error(`${options.label} достиг wall-clock timeout ${timeoutMs} ms.`);
    error.code = 'RALPH_AGENT_TIMEOUT';
    error.turns = turns;
    error.timeoutMs = timeoutMs;
    error.telemetry = sessionTelemetry();
    throw error;
  }

  // Ошибка из потока событий проверяется раньше кода завершения: Claude CLI
  // выходит с нулём и при отказе авторизации, и при собственном лимите шагов,
  // поэтому опора на код завершения приняла бы такой прогон за успешный.
  if (streamError) {
    streamError.turns = turns;
    streamError.telemetry = sessionTelemetry();
    throw streamError;
  }

  if (result.code !== 0) {
    const error =
      backend.exitFailure?.(result, stderr, options.label) ??
      genericExitFailure(result, stderr, options.label);
    error.turns = turns;
    error.telemetry = sessionTelemetry();
    throw error;
  }

  console.log(`${options.label}: использовано шагов ${turns}/${options.maxTurns}.`);
  return { turns, lastAgentMessage, telemetry: sessionTelemetry() };
}

export function genericExitFailure(result, stderr, label) {
  return new Error(
    `${label} завершился с кодом ${result.code ?? 'null'}` +
      `${result.signal ? ` (сигнал ${result.signal})` : ''}.` +
      `${stderr.trim() ? `\n${stderr.trim()}` : ''}`,
  );
}

// -----------------------------------------------------------------------------
// Повтор review-сессии при технической ошибке
// -----------------------------------------------------------------------------

// Ошибка с nonRetryable — это вердикт ревьюера, а не сбой запуска, и повторять
// её нельзя.
//
// Коды ниже — тоже не сбой запуска: между попытками не меняются ни prompt, ни
// состояние репозитория, поэтому повтор воспроизводит тот же результат и только
// тратит время и квоту. Дороже всех RALPH_AGENT_TIMEOUT: при agentTimeoutMs в
// 90 минут три попытки — это 4,5 часа до первого сообщения оператору. Путь
// разработки уже считает RALPH_AGENT_AUTH фатальным (ralph-loop.mjs), и ревью
// не должно расходиться с ним.
//
// RALPH_AGENT_REJECTED сюда намеренно не входит: 403 «Request not allowed»
// приходит и уходит сам, и повтор той же сессии — единственный способ его
// пережить, не потеряв уже сделанную работу.
const nonRetryableReviewCodes = new Set([
  'RALPH_AGENT_AUTH',
  'RALPH_AGENT_TIMEOUT',
  'RALPH_MAX_TURNS',
  'RALPH_COMMAND_NOT_FOUND',
]);

export async function runReviewWithRetries(config, operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= config.runtime.reviewRetryAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        error.nonRetryable ||
        nonRetryableReviewCodes.has(error.code) ||
        attempt === config.runtime.reviewRetryAttempts
      ) {
        throw error;
      }
      const delay = retryDelayMs(config.runtime.networkRetryBaseDelayMs, attempt);
      console.error(
        `${label} технически не завершился (попытка ${attempt}): ${error.message}. ` +
          `Повтор через ${delay} ms.`,
      );
      waitSync(delay);
    }
  }
  throw lastError;
}
