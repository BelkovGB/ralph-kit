import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  commandTimeoutError,
  logDetail,
  logDetailError,
  retryTransientOperation,
} from './ralph-runtime.mjs';

/**
 * Запуск внешних команд: Git, GitHub CLI, npm и Codex CLI.
 *
 * Пути выводятся здесь заново, а не импортируются из оркестратора. Это не
 * дублирование ради удобства: `loadConfig` вызывает `applyRuntimeSettings`, а
 * `run` нуждается в путях, поэтому импорт путей из модуля конфигурации создал бы
 * настоящий цикл с temporal dead zone — оба значения вычисляются на этапе
 * загрузки модуля. Файлы лежат в одном каталоге, поэтому значения совпадают.
 */

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..', '..');
const commandRunnerPath = path.join(scriptDirectory, 'ralph-command-runner.mjs');

// Значения по умолчанию действуют, пока конфигурация не загружена: часть тестов
// и ранние проверки запускают команды до `loadConfig`.
export const defaultRuntimeSettings = Object.freeze({
  commandTimeoutMs: 300_000,
  validationTimeoutMs: 1_800_000,
  validationRunTimeoutMs: 3_600_000,
  agentTimeoutMs: 5_400_000,
  networkRetryAttempts: 3,
  networkRetryBaseDelayMs: 2_000,
  maxPages: 20,
  reviewRetryAttempts: 3,
});

let settings = { ...defaultRuntimeSettings };

export function applyRuntimeSettings(runtime) {
  settings = { ...runtime };
}

export function runtimeSettings() {
  return settings;
}

export function executable(name) {
  if (process.platform !== 'win32') {
    return name;
  }

  return `${name}.exe`;
}

// Имена, которые на Windows могут оказаться батником, а не исполняемым файлом:
// npm и npx поставляются только шимом .cmd, а у codex и claude есть и нативная
// установка (.exe), и установка через npm (.cmd).
export const windowsShimCandidates = ['codex', 'claude', 'npm', 'npx'];

// cmd.exe нужен только батнику: .exe и .com запускаются напрямую.
const windowsShimExtensions = new Set(['.BAT', '.CMD']);

/**
 * Поиск команды по PATH и PATHEXT в том же порядке, что применяет сама Windows:
 * внешний цикл — каталог, внутренний — расширение.
 *
 * Порядок важен и не является деталью: он даёт тот же файл, который получает
 * оператор, набрав имя в своей оболочке. Прежний код вместо поиска подставлял
 * `${name}.cmd` и тем самым выбирал npm-шим даже там, где рядом в более раннем
 * каталоге PATH лежит рабочий .exe. На машине, где npm-установка Claude Code
 * сломана, каждая сессия падала с «claude.exe не совместим с версией Windows»,
 * хотя `claude --version` в оболочке работал.
 */
export function resolveWindowsExecutable(name, source = process.env) {
  const directories = (source.PATH ?? source.Path ?? '')
    .split(path.delimiter)
    // Элемент PATH разрешено писать в кавычках — `"C:\Program Files\Foo"`, — и
    // cmd.exe вместе с CreateProcess их снимают. Без этого шага такой каталог
    // молча пропускался, а поскольку ниже отсутствие команды стало жёсткой
    // ошибкой, установленный CLI превращался бы в RALPH_COMMAND_NOT_FOUND.
    .map((directory) => directory.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const extensions = (source.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function commandSpec(name, args) {
  if (process.platform !== 'win32' || !windowsShimCandidates.includes(name)) {
    return { command: executable(name), commandArgs: args };
  }

  const resolved = resolveWindowsExecutable(name);
  if (resolved === null) {
    const error = new Error(
      `Команда ${name} не найдена в PATH. Ожидались ${name}.exe (нативная установка) ` +
        `или ${name}.cmd (установка через npm).`,
    );
    error.code = 'RALPH_COMMAND_NOT_FOUND';
    throw error;
  }

  if (!windowsShimExtensions.has(path.extname(resolved).toUpperCase())) {
    return { command: resolved, commandArgs: args };
  }

  // Батнику передаётся имя, а не найденный путь, и это вынужденно: аргумент
  // `cmd /d /s /c "C:\dir with space\x.cmd"` разбирается по пробелу и падает с
  // «'C:\dir' is not recognized» — проверено. Голое имя, в свою очередь,
  // безопасно только вместе с NoDefaultCurrentDirectoryInExePath: без неё
  // cmd.exe ищет команду в текущем каталоге раньше PATH. Обе стороны обязаны
  // сойтись, поэтому переменную ставят все, кто собирает окружение дочернего
  // процесса, — см. windowsSafeCommandEnvironment.
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    commandArgs: ['/d', '/s', '/c', path.basename(resolved), ...args],
  };
}

/**
 * Окружение, без которого запуск батника через cmd.exe небезопасен.
 *
 * cmd.exe ищет команду в текущем каталоге раньше, чем в PATH. Текущий каталог
 * дочернего процесса — корень репозитория, куда development-сессия пишет с
 * `--permission-mode bypassPermissions`. Без этой переменной подложенный в
 * корень `codex.cmd` или `claude.cmd` подменял бы CLI на следующем же запуске,
 * в том числе для review-сессии, которая обязана быть read-only.
 *
 * Проверено обеими сторонами: с переменной `cmd /d /s /c probe.cmd` выбирает
 * файл из PATH, без неё — из текущего каталога.
 */
export const windowsSafeCommandEnvironment =
  process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {};

export function outputTail(value, maxLength = 20_000) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? `…${text.slice(-maxLength)}` : text;
}

// Полный allowlist переменных, которые дочерний процесс может унаследовать.
// Сам по себе он не является политикой: home/config-переменные указывают на
// каталоги с учётными данными, поэтому единственная применяемая политика ниже
// вычитает их. Список остаётся отдельно, чтобы вычитание было видимым.
export const inheritableEnvironmentVariables = [
  'PATH',
  'Path',
  'PATHEXT',
  'ComSpec',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
];

export const credentialFreeEnvironmentVariables = inheritableEnvironmentVariables.filter(
  (name) =>
    ![
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
    ].includes(name),
);

function createEnvironment(variableNames, source = process.env) {
  return Object.fromEntries(
    variableNames.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]])),
  );
}

export function credentialFreeEnvironment(source = process.env) {
  return createEnvironment(credentialFreeEnvironmentVariables, source);
}

export function run(name, args, options = {}) {
  const commandTarget = commandSpec(name, args);
  const useCommandRunner = process.platform === 'win32';
  const command = useCommandRunner ? process.execPath : commandTarget.command;
  const commandArgs = useCommandRunner ? [commandRunnerPath] : commandTarget.commandArgs;
  const stdio = options.inherit ? ['pipe', 'inherit', 'inherit'] : 'pipe';
  // Когда окружение не задано, дочерний процесс наследует окружение вызывающего.
  // Защита от подмены батника обязана попасть в оба случая, поэтому окружение
  // здесь всегда выписывается явно.
  const childEnvironment =
    process.platform === 'win32'
      ? { ...(options.env ?? process.env), ...windowsSafeCommandEnvironment }
      : options.env;
  const timeoutMs = options.timeoutMs ?? settings.commandTimeoutMs;
  const startedAt = Date.now();
  console.log(`Команда: ${name} ${args[0] ?? ''}`.trim());
  const result = spawnSync(command, commandArgs, {
    cwd: projectRoot,
    encoding: 'utf8',
    input: useCommandRunner
      ? JSON.stringify({
          command: commandTarget.command,
          args: commandTarget.commandArgs,
          cwd: projectRoot,
          input: options.input,
          timeoutMs,
          env: childEnvironment,
        })
      : options.input,
    stdio,
    timeout: useCommandRunner ? timeoutMs + 25_000 : timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
    ...(childEnvironment === undefined ? {} : { env: childEnvironment }),
  });

  const commandRunnerTimedOut =
    useCommandRunner &&
    result.status === 124 &&
    String(result.stderr ?? '').includes('RALPH_COMMAND_TIMEOUT:');
  if (result.error?.code === 'ETIMEDOUT' || commandRunnerTimedOut) {
    throw commandTimeoutError(name, args, timeoutMs, result);
  }
  if (result.error) {
    const error = new Error(`Не удалось запустить ${name}: ${result.error.message}`);
    error.code = result.error.code;
    error.stdout = result.stdout?.trim() ?? '';
    error.stderr = result.stderr?.trim() ?? '';
    throw error;
  }
  if (result.status === null) {
    const error = new Error(
      `Команда ${name} ${args[0] ?? ''} завершилась без exit code` +
        `${result.signal ? ` (сигнал ${result.signal})` : ''}.`,
    );
    error.code = 'RALPH_COMMAND_TERMINATED';
    error.stdout = outputTail(result.stdout);
    error.stderr = outputTail(result.stderr);
    throw error;
  }

  const allowedExitCodes = new Set(options.allowedExitCodes ?? []);
  if (result.status !== 0 && !options.allowFailure && !allowedExitCodes.has(result.status)) {
    const details = [result.stderr, result.stdout]
      .filter(Boolean)
      .map((value) => value.trim())
      .filter(Boolean)
      .join('\n');
    const error = new Error(
      `Команда ${name} ${args[0] ?? ''} завершилась с кодом ${result.status}.` +
        `${details ? `\n${outputTail(details)}` : ''}`,
    );
    error.code = 'RALPH_COMMAND_FAILED';
    error.status = result.status;
    error.stdout = result.stdout?.trim() ?? '';
    error.stderr = result.stderr?.trim() ?? '';
    throw error;
  }

  // Вывод команды идёт в журнал, а не в консоль. Живым он всё равно не был:
  // spawnSync отдаёт его целиком по завершении, то есть контейнер валидации
  // выплёскивал в консоль десятки тысяч строк разом, и ход прогона в ней
  // терялся. В `run.log` вывод сохраняется полностью.
  if (options.echoOutput) {
    if (result.stdout?.trim()) logDetail(outputTail(result.stdout, 100_000));
    if (result.stderr?.trim()) logDetailError(outputTail(result.stderr, 100_000));
  }
  console.log(`Команда ${name} завершена за ${Date.now() - startedAt} ms.`);

  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

export function runNetwork(name, args, options = {}) {
  return retryTransientOperation(() => run(name, args, options), {
    attempts: settings.networkRetryAttempts,
    baseDelayMs: settings.networkRetryBaseDelayMs,
    onRetry: (error, attempt, delay) =>
      console.error(
        `Временная ошибка ${name} (попытка ${attempt}): ${error.message}. Повтор через ${delay} ms.`,
      ),
  });
}
