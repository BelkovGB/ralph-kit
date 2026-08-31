import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
let configuredGitHubAccount = null;
let configuredGitHubToken = null;
let disabledGitHooksDirectory = null;

export function applyRuntimeSettings(runtime) {
  settings = { ...runtime };
}

export function runtimeSettings() {
  return settings;
}

export function removeTemporaryDirectory(directory, dependencies = {}) {
  const remove = dependencies.rmSync ?? rmSync;
  const warn = dependencies.warn ?? console.warn;
  try {
    remove(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    warn(`Ralph не удалил временный каталог ${directory}: ${error?.message ?? String(error)}.`);
    return false;
  }
}

/**
 * Выбирает сохранённый в GitHub CLI аккаунт только для команд `gh` Ralph.
 * Глобальный active account в пользовательском `hosts.yml` не меняется.
 */
export function applyGitHubAccount(account) {
  configuredGitHubAccount = account ?? null;
  configuredGitHubToken = null;
}

export function executable(name) {
  if (process.platform !== 'win32') {
    return name;
  }

  return `${name}.exe`;
}

// Имена, которые на Windows могут оказаться батником, а не исполняемым файлом.
// Здесь только те команды, которые запускает сам Ralph: у обоих CLI агента есть
// и нативная установка (.exe), и установка пакетным менеджером (.cmd). Команды
// проверок в этот список не входят — их запускает оболочка, а не поиск по PATH,
// и какой инструмент за ними стоит, знает только проект.
export const windowsShimCandidates = ['codex', 'claude'];

// cmd.exe нужен только батнику: .exe и .com запускаются напрямую.
const windowsShimExtensions = new Set(['.BAT', '.CMD']);

/**
 * Поиск команды по PATH и PATHEXT в том же порядке, что применяет сама Windows:
 * внешний цикл — каталог, внутренний — расширение.
 *
 * Порядок важен и не является деталью: он даёт тот же файл, который получает
 * оператор, набрав имя в своей оболочке. Подстановка `${name}.cmd` вместо
 * поиска выбирает npm-шим даже там, где рядом в более раннем каталоге PATH
 * лежит рабочий .exe: на машине со сломанной npm-установкой Claude Code сессия
 * падает с «claude.exe не совместим с версией Windows», хотя `claude --version`
 * в оболочке работает.
 */
export function resolveWindowsExecutable(name, source = process.env) {
  const directories = (source.PATH ?? source.Path ?? '')
    .split(path.delimiter)
    // Элемент PATH разрешено писать в кавычках — `"C:\Program Files\Foo"`, — и
    // cmd.exe вместе с CreateProcess их снимают. Без этого шага такой каталог
    // молча пропускается, а поскольку отсутствие команды ниже — жёсткая ошибка,
    // установленный CLI превращается в RALPH_COMMAND_NOT_FOUND.
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

function readConfiguredGitHubToken(account, dependencies = {}) {
  const execute = dependencies.spawnSync ?? spawnSync;
  const commandTarget = commandSpec('gh', [
    'auth',
    'token',
    '--hostname',
    'github.com',
    '--user',
    account,
  ]);
  const environment = { ...process.env, ...windowsSafeCommandEnvironment };
  // Иначе переменная окружения подменяет сохранённую авторизацию, ради которой
  // и задан githubAccount. Сам токен читается только из хранилища GitHub CLI.
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
    delete environment[name];
  }
  const result = execute(commandTarget.command, commandTarget.commandArgs, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: environment,
    stdio: 'pipe',
    timeout: settings.commandTimeoutMs,
    windowsHide: true,
  });
  const token = result.stdout?.trim() ?? '';
  if (result.error || result.status !== 0 || token === '') {
    const error = new Error(
      `Аккаунт GitHub "${account}" не авторизован в GitHub CLI. ` +
        `Выполните gh auth login для этого аккаунта или выберите другой githubAccount.`,
    );
    error.code = 'RALPH_GITHUB_ACCOUNT';
    throw error;
  }
  return token;
}

/** Окружение одного `gh`: выбранный токен не достаётся git, агенту и проверкам. */
export function githubAccountEnvironment(source = process.env, dependencies = {}) {
  if (configuredGitHubAccount === null) return source;
  configuredGitHubToken ??= (dependencies.readToken ?? readConfiguredGitHubToken)(
    configuredGitHubAccount,
  );
  const environment = {
    ...source,
    GH_HOST: 'github.com',
    GH_TOKEN: configuredGitHubToken,
  };
  for (const name of ['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
    delete environment[name];
  }
  return environment;
}

/**
 * Передаёт выбранный аккаунт сетевому `git` через одноразовый HTTP-заголовок.
 * URL и аргументы команды не содержат токен, Git Credential Manager не меняется.
 */
export function githubGitEnvironment(source = process.env, dependencies = {}) {
  if (configuredGitHubAccount === null) return source;
  configuredGitHubToken ??= (dependencies.readToken ?? readConfiguredGitHubToken)(
    configuredGitHubAccount,
  );
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    if (normalized === 'GIT_CURL_VERBOSE' || normalized.startsWith('GIT_TRACE')) {
      delete environment[name];
    }
  }
  const inheritedCount = Number.parseInt(environment.GIT_CONFIG_COUNT ?? '0', 10);
  const configIndex = Number.isInteger(inheritedCount) && inheritedCount >= 0 ? inheritedCount : 0;
  const authorization = Buffer.from(`x-access-token:${configuredGitHubToken}`, 'utf8').toString(
    'base64',
  );
  disabledGitHooksDirectory ??= mkdtempSync(path.join(tmpdir(), 'ralph-disabled-git-hooks-'));
  environment.GIT_CONFIG_COUNT = String(configIndex + 2);
  environment[`GIT_CONFIG_KEY_${configIndex}`] = 'http.https://github.com/.extraheader';
  environment[`GIT_CONFIG_VALUE_${configIndex}`] = `AUTHORIZATION: basic ${authorization}`;
  environment[`GIT_CONFIG_KEY_${configIndex + 1}`] = 'core.hooksPath';
  environment[`GIT_CONFIG_VALUE_${configIndex + 1}`] = disabledGitHooksDirectory;
  return environment;
}

process.once('exit', () => {
  if (disabledGitHooksDirectory !== null) {
    removeTemporaryDirectory(disabledGitHooksDirectory);
  }
});

const authenticatedGitCommands = new Set(['fetch', 'ls-remote', 'push']);

export function run(name, args, options = {}) {
  const commandTarget = commandSpec(name, args);
  const useCommandRunner = process.platform === 'win32';
  const command = useCommandRunner ? process.execPath : commandTarget.command;
  const commandArgs = useCommandRunner ? [commandRunnerPath] : commandTarget.commandArgs;
  const stdio = options.inherit ? ['pipe', 'inherit', 'inherit'] : 'pipe';
  // Когда окружение не задано, дочерний процесс наследует окружение вызывающего.
  // Защита от подмены батника обязана попасть в оба случая, поэтому окружение
  // здесь всегда выписывается явно.
  let commandEnvironment = options.env;
  if (name === 'gh' && args[0] !== '--version') {
    commandEnvironment = githubAccountEnvironment(options.env ?? process.env);
  } else if (name === 'git' && authenticatedGitCommands.has(args[0])) {
    commandEnvironment = githubGitEnvironment(options.env ?? process.env);
  }
  const childEnvironment =
    process.platform === 'win32'
      ? { ...(commandEnvironment ?? process.env), ...windowsSafeCommandEnvironment }
      : commandEnvironment;
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

  // Вывод команды идёт в журнал, а не в консоль. Живым он всё равно не бывает:
  // spawnSync отдаёт его целиком по завершении, то есть контейнер валидации
  // выплеснул бы в консоль десятки тысяч строк разом, и ход прогона в ней
  // потерялся бы. В `run.log` вывод сохраняется полностью.
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
