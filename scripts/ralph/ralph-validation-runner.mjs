import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { fail } from './ralph-scope.mjs';
import { credentialFreeEnvironment, run } from './ralph-process-runner.mjs';
import { agentInstructionFiles, trustedFileHash } from './ralph-config.mjs';

/**
 * Прогон команд проверки в рабочей папке проекта.
 *
 * Проверка неизменности control plane живёт здесь же, потому что вызывается
 * перед каждым прогоном.
 *
 * Приставка `host` в именах означает машину оператора, а не выбор режима:
 * режим один. Путь `hostHomeDirectory` с сегментом `host-home` переживает
 * прогоны вместе с кэшами инструментов, поэтому переименование осиротило бы
 * их на машинах операторов.
 */

// Пути выводятся здесь заново, как в `ralph-process-runner.mjs`.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// -----------------------------------------------------------------------------
// Проверка неизменности доверенного control plane
// -----------------------------------------------------------------------------

export function assertTrustedControlFilesUnchanged(config) {
  // Ожидаемый набор берётся из конфигурации, а не выводится из имён файлов:
  // выводить его здесь значит держать правило «что считается инструкцией» в
  // двух местах, и они разойдутся.
  const trustedAgentInstructionFiles = new Set(config.agentInstructionFiles ?? []);
  const currentAgentInstructionFiles = new Set(agentInstructionFiles());
  if (
    trustedAgentInstructionFiles.size !== currentAgentInstructionFiles.size ||
    [...currentAgentInstructionFiles].some((file) => !trustedAgentInstructionFiles.has(file))
  ) {
    fail(
      'AFK-сессия изменила набор доверенных файлов инструкций. ' +
        'Изменение отклонено до валидации, commit и push.',
    );
  }
  for (const [file, expectedHash] of config.trustedControlFileHashes ?? []) {
    if (!existsSync(file) || trustedFileHash(file) !== expectedHash) {
      fail(
        `AFK-сессия изменила доверенный файл ${file}. ` +
          'Изменение отклонено до валидации, commit и push.',
      );
    }
  }
}

function configuredValidationEnvironment(config) {
  return Object.fromEntries(
    (config.validationEnvironment ?? []).map((entry) => {
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

/**
 * Домашний каталог host-проверок.
 *
 * Профиль оператора командам не отдают: там лежат credentials агента и `gh`.
 * Пустое место HOME тоже не годится — go, cargo, npm, pip и JVM ищут в нём кэш
 * и останавливаются до первой команды проекта. Поэтому Ralph выдаёт свой
 * каталог внутри системного temp: он переживает прогоны вместе с кэшами и не
 * попадает внутрь рабочей папки. Каталог внутри неё сбивал бы инструменты,
 * которые ищут корень проекта вверх по дереву и находили бы его в HOME.
 */
const hostHomeProjectKey = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);

/**
 * Корень профиля — каталог кэша пользователя, а не общий temp. Путь выводится из
 * пути проекта, то есть известен заранее, а общий temp на POSIX доступен на
 * запись всем: сосед по машине создал бы каталог первым и положил туда свой
 * `.gitconfig` или `.npmrc`, и Ralph отдал бы это командам проверок как HOME.
 */
const hostHomeRoot =
  process.platform === 'win32'
    ? (process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'))
    : (process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'));

export const hostHomeDirectory = path.join(
  hostHomeRoot,
  'ralph-loop',
  hostHomeProjectKey,
  'host-home',
);

/**
 * Путь оператора берётся, только если он абсолютный и непустой. Пустая строка
 * роняла бы `mkdir` на ENOENT, а относительный путь создавал бы домашний каталог
 * внутри рабочей папки: там его находят инструменты, ищущие корень проекта, и
 * созданные файлы останавливают проверку как изменение дерева.
 */
function hostDirectory(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (!path.isAbsolute(value)) {
    fail(`Значение ${name} в validationEnvironment должно быть абсолютным путём: ${value}`);
  }
  const relativeToProject = path.relative(projectRoot, value);
  if (
    relativeToProject !== '' &&
    !relativeToProject.startsWith('..') &&
    !path.isAbsolute(relativeToProject)
  ) {
    fail(
      `Значение ${name} в validationEnvironment указывает внутрь рабочей папки: ${value}. ` +
        'Созданные там файлы попадут в отпечаток дерева, и проверка остановит прогон.',
    );
  }
  return value;
}

export function hostValidationEnvironment(config, source = process.env) {
  const configured = configuredValidationEnvironment(config);
  const home = hostDirectory('HOME', configured.HOME, hostHomeDirectory);
  const userProfile = hostDirectory('USERPROFILE', configured.USERPROFILE, home);
  // Каталоги перечислены отдельно: они проверены и не должны перетираться
  // сырым значением из конфига, в том числе пустой строкой.
  const directories = {
    HOME: home,
    USERPROFILE: userProfile,
    APPDATA: hostDirectory(
      'APPDATA',
      configured.APPDATA,
      path.join(userProfile, 'AppData', 'Roaming'),
    ),
    LOCALAPPDATA: hostDirectory(
      'LOCALAPPDATA',
      configured.LOCALAPPDATA,
      path.join(userProfile, 'AppData', 'Local'),
    ),
    XDG_CONFIG_HOME: hostDirectory(
      'XDG_CONFIG_HOME',
      configured.XDG_CONFIG_HOME,
      path.join(home, '.config'),
    ),
    XDG_CACHE_HOME: hostDirectory(
      'XDG_CACHE_HOME',
      configured.XDG_CACHE_HOME,
      path.join(home, '.cache'),
    ),
  };

  return {
    ...credentialFreeEnvironment(source),
    ...directories,
    ...Object.fromEntries(
      Object.entries(configured).filter(([name]) => !(name in directories)),
    ),
  };
}

/**
 * Отпечаток рабочего дерева host-режима: путь и хеш каждого файла, который
 * отличается от закоммиченного состояния.
 *
 * Список берётся у `git status`, а не обходом всех файлов: содержимое, которое
 * изменилось, обязано попасть в его вывод, поэтому читать нужно только
 * названные им пути. Неизменённые файлы git берёт из своего кэша состояния и с
 * диска не поднимает, а раньше набор перечитывал весь проект целиком, и так
 * дважды за одну проверку.
 *
 * Размен назван честно: git считает файл неизменённым по размеру и времени
 * правки, поэтому запись, вернувшая прежние размер и время, отпечаток не
 * изменит. От случайной правки форматтером, генератором или тестом со снимками
 * это защищает полностью; подделать время может только код, который и так
 * выполняется на машине оператора.
 *
 * Карта, а не один хеш: по ней остановка называет изменённые файлы, а задание
 * «верните прежний diff» без их списка невыполнимо.
 */
export function hostWorkingTreeEntries(dependencies = {}) {
  const execute = dependencies.run ?? run;
  const listPaths = (args) =>
    execute('git', args)
      .stdout.split(String.fromCharCode(0))
      .filter(Boolean);
  // Два списка вместо обхода всего проекта: изменённые относительно коммита
  // отслеживаемые файлы и новые файлы, которые не исключает `.gitignore`.
  const changedPaths = new Set([
    ...listPaths(['diff', '--name-only', '-z', 'HEAD']),
    ...listPaths(['ls-files', '-z', '--others', '--exclude-standard']),
  ]);
  const entries = new Map();

  for (const relativePath of [...changedPaths].sort((left, right) => left.localeCompare(right))) {
    const normalizedPath = path.normalize(relativePath);
    if (
      normalizedPath === '.' ||
      path.isAbsolute(normalizedPath) ||
      normalizedPath.startsWith(`..${path.sep}`) ||
      normalizedPath === '..'
    ) {
      fail(`Небезопасный путь в выводе git: ${relativePath}`);
    }
    const filePath = path.join(projectRoot, normalizedPath);
    const stats = lstatSync(filePath, { throwIfNoEntry: false });
    const key = relativePath.replaceAll('\\', '/');
    if (!stats) {
      entries.set(key, 'deleted');
      continue;
    }
    // Символьная ссылка хешируется своей целью: читать по ней файл значит выйти
    // за пределы проекта, а подмена цели — такое же изменение дерева.
    if (stats.isSymbolicLink()) {
      entries.set(key, createHash('sha256').update(readlinkSync(filePath)).digest('hex'));
      continue;
    }
    if (!stats.isFile()) {
      fail(`Host validation ожидает файл: ${relativePath}`);
    }
    entries.set(key, createHash('sha256').update(readFileSync(filePath)).digest('hex'));
  }
  return entries;
}

export function hostWorkingTreeHash(dependencies = {}) {
  const hash = createHash('sha256');
  for (const [relativePath, fileHash] of hostWorkingTreeEntries(dependencies)) {
    hash.update(`${relativePath}\0${fileHash}\0`);
  }
  return hash.digest('hex');
}

function hostTreeHashOfEntries(entries) {
  const hash = createHash('sha256');
  for (const [relativePath, fileHash] of entries) {
    hash.update(`${relativePath}\0${fileHash}\0`);
  }
  return hash.digest('hex');
}

function changedTreePaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((relativePath) => before.get(relativePath) !== after.get(relativePath))
    .sort((left, right) => left.localeCompare(right));
}

const namedMutatedPathLimit = 10;

function hostShellCommand(script, platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/d', '/s', '/c', script],
    };
  }
  return { command: 'sh', args: ['-eu', '-c', script] };
}

export function runConfiguredScripts(config, scripts, label, options = {}) {
  const execute = options.run ?? run;
  // Preflight готовит окружение и по своему контракту вправе менять дерево:
  // миграции и генерация кода для того и существуют. Снимок берётся после него,
  // иначе подготовка останавливала бы прогон собственным результатом, а
  // следующий запуск повторял бы её с тем же исходом.
  const preparation = [...config.preflightScripts];
  const guarded = [...scripts];
  if (preparation.length + guarded.length === 0) return { ran: false, scripts: [] };

  assertTrustedControlFilesUnchanged(config);
  const environment = hostValidationEnvironment(config, options.environmentSource ?? process.env);
  // Отказ на подготовке каталогов — беда окружения, а не проверок. Без своего
  // кода он уходит в цикл как провал проверок, и агент тратит все попытки на
  // ошибку, которую правка репозитория не устраняет.
  try {
    const makeDirectory = options.mkdir ?? mkdirSync;
    for (const variable of [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
    ]) {
      makeDirectory(environment[variable], { recursive: true, mode: 0o700 });
    }
  } catch (error) {
    const failure = new Error(
      `${label}: не удалось подготовить каталоги окружения host-проверок. ${error.message}`,
      { cause: error },
    );
    failure.code = 'RALPH_VALIDATION_ENVIRONMENT';
    throw failure;
  }
  const startedAt = Date.now();
  console.log(`\n=== ${label}: ${[...preparation, ...guarded].join(' && ')} ===\n`);

  let activeScript = preparation[0] ?? guarded[0];
  let baseline = null;
  let failure = null;
  const runScript = (script) => {
    activeScript = script;
    const remainingMs = config.runtime.validationRunTimeoutMs - (Date.now() - startedAt);
    if (remainingMs < 1) {
      const error = new Error(
        `${label}: общий лимит ${config.runtime.validationRunTimeoutMs} ms исчерпан.`,
      );
      error.code = 'RALPH_COMMAND_TIMEOUT';
      throw error;
    }
    const command = hostShellCommand(script, options.platform);
    execute(command.command, command.args, {
      echoOutput: true,
      timeoutMs: remainingMs,
      env: environment,
    });
  };

  try {
    for (const script of preparation) runScript(script);
    baseline = hostWorkingTreeEntries({ run: execute });
    for (const script of guarded) runScript(script);
  } catch (error) {
    failure = error;
  }

  if (baseline !== null) {
    try {
      const observed = hostWorkingTreeEntries({ run: execute });
      const mutatedPaths = changedTreePaths(baseline, observed);
      if (mutatedPaths.length > 0) {
        const named = mutatedPaths.slice(0, namedMutatedPathLimit);
        const rest = mutatedPaths.length - named.length;
        const treeError = new Error(
          `${label}: команды проверки изменили отслеживаемые или новые файлы проекта: ` +
            `${named.join(', ')}${rest > 0 ? ` и ещё ${rest}` : ''}.` +
            (failure ? ` Исходная ошибка: ${failure.message}` : ''),
          failure ? { cause: failure } : undefined,
        );
        treeError.code = 'RALPH_VALIDATION_MUTATED';
        treeError.expectedTreeHash = hostTreeHashOfEntries(baseline);
        treeError.observedTreeHash = hostTreeHashOfEntries(observed);
        treeError.mutatedPaths = mutatedPaths;
        failure = treeError;
      }
    } catch (error) {
      if (failure && error !== failure) error.cause = failure;
      failure = error;
    }
  }

  if (failure) {
    if (!['RALPH_COMMAND_TIMEOUT', 'RALPH_VALIDATION_MUTATED'].includes(failure.code)) {
      failure.code = 'RALPH_VALIDATION_FAILED';
    }
    failure.script = activeScript;
    throw failure;
  }
  return { ran: true, scripts: [...preparation, ...guarded] };
}

/**
 * Артефакты прошлого прогона: отчёты, трассы, покрытие.
 *
 * Проверки идут в рабочей папке проекта, поэтому файл, оставленный
 * одной командой, попадает под следующую: отчёт браузерного набора — под линтер,
 * и проверка падает на чужом сгенерированном коде. Пути называет проект: набор
 * не знает, что у него мусор, а что дорогой кеш, и по умолчанию не удаляет
 * ничего.
 *
 * Удаляется только то, чего нет в Git. Отслеживаемый путь — это работа, а не
 * мусор, и его удаление прогон останавливает.
 */
export function removeValidationArtifacts(config, options = {}) {
  const artifactPaths = config?.validationArtifactPaths ?? [];
  if (artifactPaths.length === 0) return [];
  const root = path.resolve(options.projectRoot ?? projectRoot);
  const execute = options.run ?? run;
  const removed = [];

  for (const relativePath of artifactPaths) {
    const target = path.resolve(root, relativePath);
    const reject = (reason) =>
      fail(`Поле "validationArtifactPaths": путь ${relativePath} ${reason}.`);
    if (target === root) reject('указывает на корень проекта');
    if (!target.startsWith(root + path.sep)) reject('выходит за пределы проекта');
    const inside = path.relative(root, target);
    if (inside.split(path.sep)[0] === '.git') reject('принадлежит служебному каталогу Git');

    const tracked = String(
      execute('git', ['ls-files', '-z', '--', inside.replaceAll('\\', '/')]).stdout ?? '',
    ).replaceAll('\0', '');
    if (tracked !== '') {
      reject(
        'отслеживается Git. Ralph удаляет только то, чего в Git нет: удаление ' +
          'отслеживаемого файла — потеря работы, а не уборка',
      );
    }

    if (!existsSync(target)) continue;
    // Ссылка ведёт наружу, а её содержимое проверкам не принадлежит.
    if (lstatSync(target).isSymbolicLink()) reject('является символической ссылкой');
    rmSync(target, { recursive: true, force: true });
    removed.push(relativePath);
  }

  if (removed.length > 0) {
    console.log(`Артефакты прошлых проверок удалены: ${removed.join(', ')}.`);
  }

  return removed;
}

/**
 * Отдельный прогон подготовки в начале фазы.
 *
 * Набор проверок пуст: команды подготовки Ralph берёт из конфигурации сам, и
 * они идут подготовкой, а не проверкой. Передать их вторым аргументом значило
 * бы поставить их под снимок дерева и уронить прогон на собственной миграции.
 */
export function runPreflight(config, options = {}) {
  return runConfiguredScripts(config, [], 'Preflight', options);
}

/**
 * Полный набор `validationScripts`.
 *
 * Набор не сокращается по области изменения: какая команда какой файл
 * покрывает, знает только сам проект, а неверная догадка молча пропускает
 * проверку.
 */
export function runConfiguredValidation(config, options = {}) {
  // Уборка идёт до preflight: он готовит то, что нужно проверкам, и уборка
  // после него снесла бы собственную подготовку прогона.
  removeValidationArtifacts(config, options);
  // Preflight выполняется первым в том же окружении, что и остальные команды
  // текущей проверки.
  return runConfiguredScripts(config, config.validationScripts, 'Validation', options);
}
