import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readJsonFile, retryTransientOperation, writeJsonAtomic } from './ralph-runtime.mjs';
import { fail } from './ralph-scope.mjs';
import { credentialFreeEnvironment, run } from './ralph-process-runner.mjs';
import { agentInstructionFiles, trustedFileHash } from './ralph-config.mjs';
import { stripAnsi } from './ralph-failure-summary.mjs';

/**
 * Прогон команд проверки на хосте или в изолированном контейнере.
 *
 * Проверка неизменности control plane живёт здесь же, потому что вызывается
 * перед каждым прогоном.
 */

// Пути выводятся здесь заново, как в `ralph-process-runner.mjs`.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const runtimeAttestationsPath = path.join(
  projectRoot,
  '.git',
  'ralph-loop',
  'validation-attestations.json',
);

const preparedValidationImages = new Set();
// -----------------------------------------------------------------------------
// Проверка неизменности доверенного control plane
// -----------------------------------------------------------------------------

// Очистка attestation при обнаруженной подделке не нужна: все доверенные файлы
// отслеживаются Git и потому входят в snapshot, а значит и в workspaceHash —
// ключ attestation. Подделанный файл даёт другой ключ и не совпадает ни с одной
// выданной записью; откат правки возвращает исходный ключ, и переиспользовать
// его PASS правильно, потому что дерево действительно проходило проверки.
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

export function validationContainerRunArgs(config, scripts, snapshotPath) {
  const scriptList = Array.isArray(scripts) ? scripts : [scripts];
  return [
    'run',
    '--rm',
    '--init',
    // Сеть отключена всегда: изоляция валидации — единственная причина
    // существования контейнера, поэтому это не настройка.
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--user',
    '65532:65532',
    ...(config.validationContainer.writableVolumes ?? []).flatMap((target) => [
      '--mount',
      `type=volume,target=${target}`,
    ]),
    '--tmpfs',
    '/workspace:rw,exec,nosuid,nodev,size=4g,uid=65532,gid=65532',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=1g,uid=65532,gid=65532',
    '--mount',
    `type=bind,source=${snapshotPath},target=/source,readonly`,
    '--workdir',
    '/workspace',
    '--env',
    'HOME=/tmp',
    // Значения оператора идут после HOME: docker берёт последнее вхождение, и
    // проект вправе задать свой домашний каталог внутри контейнера.
    ...(config.validationEnvironment ?? []).flatMap((entry) => ['--env', entry]),
    config.validationContainer.image,
    ...scriptList,
  ];
}

export function createValidationWorkspaceSnapshot() {
  const snapshotPath = mkdtempSync(path.join(tmpdir(), 'ralph-validation-'));
  try {
    const files = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      .stdout.split('\0')
      .filter(Boolean);
    for (const relativePath of files) {
      const normalizedPath = path.normalize(relativePath);
      if (
        normalizedPath === '.' ||
        path.isAbsolute(normalizedPath) ||
        normalizedPath.startsWith(`..${path.sep}`) ||
        normalizedPath === '..'
      ) {
        fail(`Небезопасный путь в git ls-files: ${relativePath}`);
      }
      const sourcePath = path.join(projectRoot, normalizedPath);
      // Удалённый в рабочем дереве файл git ls-files всё ещё перечисляет как
      // отслеживаемый. Снимок обязан повторять дерево, а не индекс: иначе
      // issue, которую нельзя выполнить без удаления файла, не проходит
      // валидацию в принципе: попытки падают с ENOENT и съедают бюджет
      // итераций.
      const sourceStats = lstatSync(sourcePath, { throwIfNoEntry: false });
      if (!sourceStats) continue;
      if (sourceStats.isSymbolicLink()) {
        fail(`Validation snapshot не допускает symbolic link: ${relativePath}`);
      }
      const destinationPath = path.join(snapshotPath, normalizedPath);
      mkdirSync(path.dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    }
    return snapshotPath;
  } catch (error) {
    rmSync(snapshotPath, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Файлы самого Ralph, которые Dockerfile копирует в образ. Они не проектные и
 * потому не настраиваются: без них не соберётся ни один образ валидации.
 */
const ralphValidationImageFiles = [
  'scripts/ralph/ralph-validation-docker-shim.sh',
  'scripts/ralph/ralph-validation-entrypoint.sh',
];

/**
 * Пути, из которых собирается слой зависимостей образа: манифесты и lock-файлы
 * проекта из `validationDependencyPaths` плюс файлы Ralph. Путь может указывать
 * и на каталог — он разворачивается в файлы по HEAD.
 */
function validationDependencyPaths(config) {
  return [...ralphValidationImageFiles, ...(config?.validationDependencyPaths ?? [])];
}

/**
 * Образ валидации ставит зависимости по HEAD, а не по рабочему дереву, и это
 * намеренно: сборка образа — единственный шаг с сетью, поэтому брать
 * `package.json` из дерева значило бы выполнить lifecycle-хуки, которые туда
 * только что мог записать агент. Ровно это закрывают тесты «built from
 * committed inputs, not the mutable workspace» и «takes package.json from HEAD
 * and ignores injected lifecycle hooks».
 *
 * Плата — дрейф. Стоит агенту добавить пакет, и контейнер собирает дерево,
 * объявляющее одну зависимость, против зависимостей предыдущего коммита. Молча
 * это выглядит как ошибка компиляции «модуль не найден», а починить её агент не
 * может: коммитить ему запрещено, HEAD не двигается, тег образа считается по
 * тем же HEAD-байтам, поэтому и пересборки не будет — все maxTestFixAttempts
 * уходят на один и тот же отказ. Обратный случай тише и опаснее: поднятая в
 * дереве версия проверяется против ранее установленной, даёт зелёный прогон и
 * уходит в push.
 *
 * Поэтому расхождение называется вслух и до контейнера.
 */
export function assertValidationDependenciesCommitted(config, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const drifted = execute('git', [
    'diff',
    '--name-only',
    'HEAD',
    '--',
    ...validationDependencyPaths(config),
  ])
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (drifted.length === 0) return;

  fail(
    `Образ валидации ставит зависимости по HEAD, а в рабочем дереве изменены: ${drifted.join(', ')}. ` +
      'Контейнер проверял бы это дерево против зависимостей предыдущего коммита, ' +
      'поэтому прогон остановлен. Закоммитьте эти файлы и запустите Ralph заново.',
  );
}

export function createTrustedValidationDependencySnapshot(config) {
  const snapshotPath = mkdtempSync(path.join(tmpdir(), 'ralph-validation-dependencies-'));
  try {
    // Пути разворачиваются в файлы по HEAD, а не читаются как имена: так один и
    // тот же ключ конфигурации принимает и отдельный манифест, и каталог.
    const files = run('git', [
      'ls-tree',
      '-r',
      '--name-only',
      'HEAD',
      '--',
      ...validationDependencyPaths(config),
    ])
      .stdout.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const gitPath of files) {
      const destinationPath = path.join(snapshotPath, ...gitPath.split('/'));
      mkdirSync(path.dirname(destinationPath), { recursive: true });
      writeFileSync(destinationPath, run('git', ['show', `HEAD:${gitPath}`]).stdout);
    }
    return snapshotPath;
  } catch (error) {
    rmSync(snapshotPath, { recursive: true, force: true });
    throw error;
  }
}

function validationInputHash(snapshotPath, hash = createHash('sha256'), relativePath = '') {
  const entries = readdirSync(snapshotPath, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const nextRelativePath = path.join(relativePath, entry.name);
    const entryPath = path.join(snapshotPath, entry.name);
    if (entry.isDirectory()) {
      validationInputHash(entryPath, hash, nextRelativePath);
    } else if (entry.isFile()) {
      hash
        .update(`${nextRelativePath.replaceAll(path.sep, '/')}\0`)
        .update(readFileSync(entryPath));
    } else {
      fail(`Validation dependency snapshot содержит неподдерживаемый файл: ${nextRelativePath}`);
    }
  }
  return hash;
}

export function validationImageForSnapshot(config, snapshotPath) {
  const inputsHash = validationInputHash(snapshotPath);
  const dockerfilePath = config.validationContainer.dockerfilePath;
  if (dockerfilePath) {
    inputsHash.update('Dockerfile.validation\0').update(readFileSync(dockerfilePath));
  }
  const inputHash = inputsHash.digest('hex').slice(0, 16);
  return `${config.validationContainer.image}-inputs-${inputHash}`;
}

export function ensureValidationImage(config, snapshotPath, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const dockerfilePath = config.validationContainer.dockerfilePath;
  const image = validationImageForSnapshot(config, snapshotPath);
  if (preparedValidationImages.has(image)) return image;
  const existingImage = execute('docker', ['image', 'inspect', image], {
    allowFailure: true,
    allowedExitCodes: [1],
    env: credentialFreeEnvironment(),
  });
  if (existingImage.status === 0) {
    preparedValidationImages.add(image);
    return image;
  }
  if (existingImage.status !== 1) {
    fail(`Не удалось проверить образ изоляции валидации ${image}.`);
  }
  console.log(`\n=== Validation isolation: docker build ${image} ===\n`);
  // Сборка образа — единственный шаг валидации с сетью, и тянет она весь слой
  // зависимостей проекта разом. Обрыв на таком объёме — рядовое событие, а не
  // отказ проекта: сеть виртуальной машины Docker Desktop роняет параллельные
  // загрузки по idle-таймауту, пропуская при этом мелкие запросы. Без повтора
  // такой обрыв останавливает прогон, и человек, ушедший от машины, возвращается
  // к невыполненной итерации.
  //
  // Число попыток берётся из настроек сетевых команд, а не из отдельного поля:
  // причина отказа та же самая, и второе поле означало бы два места для одного
  // решения. Слои, которые успели собраться, Docker берёт из кеша, поэтому
  // повтор продолжает сборку, а не начинает её заново. Повторов внутри самого
  // шага установки зависимостей кит не делает: он видит только код возврата
  // всей сборки. Как написать их в проекте, показывает комментарий в
  // `Dockerfile.validation`.
  //
  // `validationTimeoutMs` после этого ограничивает попытку, а не все попытки
  // вместе: зависшая сборка занимает его столько раз, сколько их задано.
  retryTransientOperation(
    () =>
      execute('docker', ['build', '--file', dockerfilePath, '--tag', image, snapshotPath], {
        echoOutput: true,
        timeoutMs: config.runtime.validationTimeoutMs,
        env: credentialFreeEnvironment(),
      }),
    {
      attempts: config.runtime.networkRetryAttempts,
      baseDelayMs: config.runtime.networkRetryBaseDelayMs,
      ...(dependencies.wait === undefined ? {} : { wait: dependencies.wait }),
      onRetry: (error, attempt, delay) =>
        console.error(
          `Сборка образа валидации ${image} оборвалась (попытка ${attempt}): ${error.message}. ` +
            `Повтор через ${delay} ms.`,
        ),
    },
  );
  preparedValidationImages.add(image);
  return image;
}

// -----------------------------------------------------------------------------
// Validation attestation
//
// PASS принадлежит не «issue» и не «run», а точному набору входов
// (байты source и зависимостей, scripts, образ, runtime-настройки). Поэтому
// запись переиспользуется только при полном совпадении всех входов и не зависит
// от runId. Любое изменение кода, конфигурации, Dockerfile или образа меняет
// хотя бы один вход. VALIDATION_CONTRACT_VERSION поднимается вручную, когда
// меняется смысл самого прогона.
// -----------------------------------------------------------------------------

const VALIDATION_CONTRACT_VERSION = 1;
const maxStoredValidationAttestations = 32;

export function validationAttestationKey(inputs) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: VALIDATION_CONTRACT_VERSION,
        workspaceHash: inputs.workspaceHash,
        dependencyHash: inputs.dependencyHash,
        imageDigest: inputs.imageDigest,
        scripts: inputs.scripts,
        writableVolumes: inputs.writableVolumes ?? [],
        environment: inputs.environment ?? [],
      }),
    )
    .digest('hex');
}

export function readValidationAttestations(attestationsPath = runtimeAttestationsPath) {
  const stored = readJsonFile(attestationsPath, null);
  if (stored?.version !== VALIDATION_CONTRACT_VERSION || !Array.isArray(stored.entries)) return [];
  return stored.entries.filter((entry) => typeof entry?.key === 'string');
}

export function hasValidationAttestation(key, attestationsPath = runtimeAttestationsPath) {
  return readValidationAttestations(attestationsPath).some((entry) => entry.key === key);
}

export function recordValidationAttestation(
  key,
  details,
  attestationsPath = runtimeAttestationsPath,
) {
  const entries = [
    { key, ...details, recordedAt: new Date().toISOString() },
    ...readValidationAttestations(attestationsPath).filter((entry) => entry.key !== key),
  ].slice(0, maxStoredValidationAttestations);
  writeJsonAtomic(attestationsPath, { version: VALIDATION_CONTRACT_VERSION, entries });
}

function validationImageDigest(image, execute) {
  const inspected = execute('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
    allowFailure: true,
    allowedExitCodes: [1],
    env: credentialFreeEnvironment(),
  });
  const digest = inspected.status === 0 ? inspected.stdout.trim() : '';
  // Без подтверждённого digest тег остаётся изменяемым указателем, поэтому
  // attestation не выдаётся вообще: лучше лишний прогон, чем ложный PASS.
  return digest === '' ? null : digest;
}

// Entrypoint печатает этот маркер перед каждой командой. `set -eu` останавливает
// цикл на первой ошибке, поэтому последний маркер и есть упавшая команда.
// Разбор построчный: команда содержит пробелы, а перевод строки в ней запрещён
// проверкой конфигурации.
const validationScriptMarkerPattern = /^RALPH_VALIDATION_SCRIPT=(.+?)\s*$/gm;

export function failedValidationScript(error) {
  const output = stripAnsi([error?.stdout, error?.stderr].filter(Boolean).join('\n'));
  const markers = [...output.matchAll(validationScriptMarkerPattern)];
  return markers.at(-1)?.[1] ?? null;
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
 * каталог внутри `.git`: он переживает прогоны вместе с кэшами и не попадает ни
 * в рабочее дерево, ни в его хеш.
 */
export const hostHomeDirectory = path.join(projectRoot, '.git', 'ralph-loop', 'host-home');

export function hostValidationEnvironment(config, source = process.env) {
  return {
    ...credentialFreeEnvironment(source),
    HOME: hostHomeDirectory,
    USERPROFILE: hostHomeDirectory,
    // Значения оператора идут последними: проект вправе назвать свой HOME.
    ...configuredValidationEnvironment(config),
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

export function runHostConfiguredScripts(config, scripts, label, options = {}) {
  const execute = options.run ?? run;
  const includePreflight = options.includePreflight ?? true;
  // Preflight готовит окружение и по своему контракту вправе менять дерево:
  // миграции и генерация кода для того и существуют. Снимок берётся после него,
  // иначе подготовка останавливала бы прогон собственным результатом, а
  // следующий запуск повторял бы её с тем же исходом.
  const preparation = includePreflight ? [...config.preflightScripts] : [];
  const guarded = [...scripts];
  if (preparation.length + guarded.length === 0) return { ran: false, attested: false, scripts: [] };

  assertTrustedControlFilesUnchanged(config);
  const environment = hostValidationEnvironment(config, options.environmentSource ?? process.env);
  mkdirSync(hostHomeDirectory, { recursive: true });
  const startedAt = Date.now();
  console.log(`\n=== ${label}: host ${[...preparation, ...guarded].join(' && ')} ===\n`);

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
  return {
    ran: true,
    attested: false,
    scripts: [...preparation, ...guarded],
    mode: 'host',
  };
}

/**
 * Возвращает исход прогона: выполнялся ли контейнер или набор был признан
 * проверенным по attestation. Без этого признака длительность стадии
 * бимодальна — доли секунды против нескольких минут на том же наборе, — и
 * усреднение по issues даёт число, которого не бывает ни в одном прогоне.
 */
export function runConfiguredScripts(config, scripts, label, options = {}) {
  if (config.validationMode === 'host') {
    return runHostConfiguredScripts(config, scripts, label, options);
  }
  const includePreflight = options.includePreflight ?? true;
  const execute = options.run ?? run;
  if (scripts.length === 0) return { ran: false, attested: false, scripts: [] };
  assertTrustedControlFilesUnchanged(config);
  // Один контейнер на весь набор. Изоляция от хоста сохраняется, а workspace и
  // окружение готовятся один раз вместо одного раза на каждую команду.
  // Entrypoint выполняет команды последовательно и останавливается на первой
  // ошибке.
  const isolatedScripts = includePreflight
    ? [...config.preflightScripts, ...scripts]
    : [...scripts];
  const createWorkspaceSnapshot =
    options.createWorkspaceSnapshot ?? createValidationWorkspaceSnapshot;
  const createDependencySnapshot =
    options.createDependencySnapshot ?? (() => createTrustedValidationDependencySnapshot(config));
  const snapshotPath = createWorkspaceSnapshot();
  const dependencySnapshotPath = createDependencySnapshot();
  console.log(`\n=== ${label}: isolated ${isolatedScripts.join(' && ')} ===\n`);
  try {
    const image = ensureValidationImage(config, dependencySnapshotPath, { run: execute });
    const attestationsPath = options.attestationsPath ?? runtimeAttestationsPath;
    const imageDigest = validationImageDigest(image, execute);
    const attestationKey = imageDigest
      ? validationAttestationKey({
          workspaceHash: validationInputHash(snapshotPath).digest('hex'),
          dependencyHash: validationInputHash(dependencySnapshotPath).digest('hex'),
          imageDigest,
          scripts: isolatedScripts,
          writableVolumes: config.validationContainer.writableVolumes ?? [],
          environment: config.validationEnvironment ?? [],
        })
      : null;
    if (attestationKey && hasValidationAttestation(attestationKey, attestationsPath)) {
      console.log(
        `${label}: тот же source, тот же набор scripts и тот же образ уже прошли проверку ` +
          `(attestation ${attestationKey.slice(0, 12)}). Повторный прогон пропущен.`,
      );
      return { ran: false, attested: true, scripts: isolatedScripts, image };
    }
    execute(
      'docker',
      validationContainerRunArgs(
        { ...config, validationContainer: { ...config.validationContainer, image } },
        isolatedScripts,
        snapshotPath,
      ),
      {
        echoOutput: true,
        timeoutMs: config.runtime.validationRunTimeoutMs,
        env: credentialFreeEnvironment(),
      },
    );
    if (attestationKey) {
      recordValidationAttestation(
        attestationKey,
        { label, scripts: isolatedScripts, image, imageDigest },
        attestationsPath,
      );
    }
    return { ran: true, attested: false, scripts: isolatedScripts, image };
  } catch (error) {
    error.code = error.code === 'RALPH_COMMAND_TIMEOUT' ? error.code : 'RALPH_VALIDATION_FAILED';
    error.script = failedValidationScript(error) ?? isolatedScripts.join(', ');
    throw error;
  } finally {
    rmSync(snapshotPath, { recursive: true, force: true });
    rmSync(dependencySnapshotPath, { recursive: true, force: true });
  }
}

export function runPreflight(config) {
  return runConfiguredScripts(config, config.preflightScripts, 'Preflight', {
    includePreflight: false,
  });
}

/**
 * Полный набор `validationScripts` в выбранном режиме.
 *
 * Набор не сокращается по области изменения: какая команда какой файл
 * покрывает, знает только сам проект, а неверная догадка молча пропускает
 * проверку.
 */
export function runConfiguredValidation(config) {
  // Проверка стоит здесь, а не в runConfiguredScripts: дрейф вносит только
  // сессия агента, а preflight выполняется по заведомо чистому дереву.
  if (config.validationMode === 'container') {
    assertValidationDependenciesCommitted(config);
  }
  // Preflight выполняется первым в том же окружении, что и остальные команды
  // текущей проверки.
  return runConfiguredScripts(config, config.validationScripts, 'Validation');
}
