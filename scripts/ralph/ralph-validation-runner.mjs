import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonFile, writeJsonAtomic } from './ralph-runtime.mjs';
import {
  fail,
  validationScriptsForChangedFiles,
  validationScriptsForCommentOnlyChange,
} from './ralph-scope.mjs';
import { credentialFreeEnvironment, run } from './ralph-process-runner.mjs';
import { agentInstructionFiles, trustedFileHash } from './ralph-config.mjs';
import { stripAnsi } from './ralph-failure-summary.mjs';

/**
 * Изолированный прогон npm scripts в контейнере и attestation результата.
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
  // выводить его здесь значило бы держать правило «что считается инструкцией»
  // в двух местах, и они уже расходились.
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
      // валидацию в принципе. На issue #84 три попытки подряд падали с ENOENT
      // за секунду и съели остаток бюджета итераций.
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

const validationDependencyFiles = [
  '.env.example',
  'package.json',
  'package-lock.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'scripts/ralph/ralph-validation-docker-shim.sh',
  'scripts/ralph/ralph-validation-entrypoint.sh',
];

/**
 * Образ валидации ставит зависимости по HEAD, а не по рабочему дереву, и это
 * намеренно: сборка образа — единственный шаг с сетью, поэтому брать
 * `package.json` из дерева значило бы выполнить lifecycle-хуки, которые туда
 * только что мог записать агент. Ровно это закрывают тесты «built from
 * committed inputs, not the mutable workspace» и «takes package.json from HEAD
 * and ignores injected lifecycle hooks».
 *
 * Плата — дрейф. Стоит агенту добавить пакет, и контейнер собирает дерево,
 * объявляющее одну зависимость, против node_modules предыдущего коммита. Молча
 * это выглядит как ошибка компиляции «модуль не найден», а починить её агент не
 * может: коммитить ему запрещено, HEAD не двигается, тег образа считается по
 * тем же HEAD-байтам, поэтому и пересборки не будет — все maxTestFixAttempts
 * уходят на один и тот же отказ. Обратный случай тише и опаснее: поднятая в
 * дереве версия проверяется против ранее установленной, даёт зелёный прогон и
 * уходит в push.
 *
 * Поэтому расхождение называется вслух и до контейнера. Файлы схемы Prisma сюда
 * не входят: `prisma:generate` выполняется внутри `build` и `test:e2e` по
 * рабочему дереву, так что схема не дрейфует.
 */
export function assertValidationDependenciesCommitted(dependencies = {}) {
  const execute = dependencies.run ?? run;
  const drifted = execute('git', [
    'diff',
    '--name-only',
    'HEAD',
    '--',
    ...validationDependencyFiles,
  ])
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (drifted.length === 0) return;

  fail(
    `Образ валидации ставит зависимости по HEAD, а в рабочем дереве изменены: ${drifted.join(', ')}. ` +
      'Контейнер проверял бы это дерево против node_modules предыдущего коммита, ' +
      'поэтому прогон остановлен. Закоммитьте эти файлы и запустите Ralph заново.',
  );
}

export function createTrustedValidationDependencySnapshot() {
  const snapshotPath = mkdtempSync(path.join(tmpdir(), 'ralph-validation-dependencies-'));
  try {
    const prismaFiles = run('git', [
      'ls-tree',
      '-r',
      '--name-only',
      'HEAD',
      '--',
      'apps/api/prisma',
    ])
      .stdout.split('\n')
      .filter(Boolean);
    for (const relativePath of [...validationDependencyFiles, ...prismaFiles]) {
      const gitPath = relativePath.split(path.sep).join('/');
      const destinationPath = path.join(snapshotPath, relativePath);
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
  execute('docker', ['build', '--file', dockerfilePath, '--tag', image, snapshotPath], {
    echoOutput: true,
    timeoutMs: config.runtime.validationTimeoutMs,
    env: credentialFreeEnvironment(),
  });
  preparedValidationImages.add(image);
  return image;
}

// -----------------------------------------------------------------------------
// Validation attestation
//
// PASS принадлежит не «issue» и не «run», а точной тройке
// (байты проверяемого source, упорядоченный список scripts, образ). Поэтому
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

// Entrypoint печатает этот маркер перед каждым script. `set -eu` останавливает
// цикл на первой ошибке, поэтому последний маркер и есть упавший script.
const validationScriptMarkerPattern = /RALPH_VALIDATION_SCRIPT=(\S+)/g;

export function failedValidationScript(error) {
  const output = stripAnsi([error?.stdout, error?.stderr].filter(Boolean).join('\n'));
  const markers = [...output.matchAll(validationScriptMarkerPattern)];
  return markers.at(-1)?.[1] ?? null;
}

/**
 * Возвращает исход прогона: выполнялся ли контейнер или набор был признан
 * проверенным по attestation. Без этого признака длительность стадии
 * бимодальна — доли секунды против нескольких минут на том же наборе, — и
 * усреднение по issues даёт число, которого не бывает ни в одном прогоне.
 */
export function runConfiguredScripts(config, scripts, label, options = {}) {
  const includePreflight = options.includePreflight ?? true;
  const execute = options.run ?? run;
  if (scripts.length === 0) return { ran: false, attested: false, scripts: [] };
  assertTrustedControlFilesUnchanged(config);
  // Один контейнер на весь набор. Изоляция от хоста сохраняется, а workspace,
  // node_modules, PostgreSQL и migrations готовятся один раз вместо одного раза
  // на каждый script. Entrypoint выполняет scripts последовательно и
  // останавливается на первой ошибке.
  const isolatedScripts = includePreflight
    ? [...config.preflightScripts, ...scripts]
    : [...scripts];
  const createWorkspaceSnapshot =
    options.createWorkspaceSnapshot ?? createValidationWorkspaceSnapshot;
  const createDependencySnapshot =
    options.createDependencySnapshot ?? createTrustedValidationDependencySnapshot;
  const snapshotPath = createWorkspaceSnapshot();
  const dependencySnapshotPath = createDependencySnapshot();
  console.log(`\n=== ${label}: isolated npm run ${isolatedScripts.join(', ')} ===\n`);
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

// -----------------------------------------------------------------------------
// Дешёвая дорожка: изменение, не тронувшее ни одного токена кода
// -----------------------------------------------------------------------------

// TypeScript берётся из node_modules проекта и только по требованию: загрузка
// стоит сотни миллисекунд, а нужна она лишь когда сокращённый набор всё равно
// требует базу и есть шанс, что правка не тронула код.
let cachedTypeScript;

function loadTypeScript() {
  if (cachedTypeScript === undefined) {
    try {
      cachedTypeScript = createRequire(path.join(projectRoot, 'package.json'))('typescript');
    } catch {
      cachedTypeScript = null;
    }
  }
  return cachedTypeScript;
}

const commentOnlyScriptExtensions = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const commentOnlyDocumentationExtensions = /\.md$/i;

/**
 * Поток токенов файла без комментариев и пробелов.
 *
 * Парсер компилятора, а не сырой сканер и не регулярное выражение. Построчный
 * разбор принял бы строку `` `// текст` `` внутри template literal за
 * комментарий. Сырой сканер без контекста парсера ошибается тоньше: после
 * подстановки `${...}` он лексирует хвост template literal как обычный код, и
 * `//` в нём открывает «комментарий», съедающий остаток строки вместе с
 * данными; то же с телом regex-литерала и текстом JSX. Обход дерева, собранного
 * `createSourceFile`, отдаёт токены с настоящими границами: хвосты template,
 * regex и JSX-текст — это содержимое токенов, и их изменение меняет поток.
 * Файл, который парсер не принял, возвращает null — «не уверен, дорожка не
 * применяется».
 */
export function scriptTokensIgnoringComments(source, fileName, typescript = loadTypeScript()) {
  if (!typescript) return null;
  const text = String(source);
  const scriptKind = /\.(tsx|jsx)$/i.test(fileName)
    ? typescript.ScriptKind.TSX
    : typescript.ScriptKind.TS;
  const sourceFile = typescript.createSourceFile(
    fileName,
    text,
    typescript.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0) return null;

  const tokens = [];
  // Shebang — не токен для сканера, но смена интерпретатора меняет поведение
  // напрямую исполняемого файла; строка входит в поток синтетическим токеном.
  const shebang = typescript.getShebang?.(text);
  if (shebang) tokens.push(`shebang:${shebang.length}:${shebang}`);
  const visit = (node) => {
    // JSDoc парсер отдаёт узлами дерева, но `/** ... */` — такой же
    // комментарий, как `//`: в поток токенов он не входит.
    if (
      node.kind >= typescript.SyntaxKind.FirstJSDocNode &&
      node.kind <= typescript.SyntaxKind.LastJSDocNode
    ) {
      return;
    }
    if (node.getChildCount(sourceFile) === 0) {
      const tokenText = node.getText(sourceFile);
      // Длина в префиксе делает границы токенов однозначными: без неё пары
      // токенов `a`+`bc` и `ab`+`c` склеились бы в одну строку.
      tokens.push(`${node.kind}:${tokenText.length}:${tokenText}`);
      return;
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return tokens.join(' ');
}

/**
 * Не изменила ли правка ничего, кроме комментариев и документации.
 *
 * Сравнивается рабочее дерево с HEAD, поэтому функция отвечает только за ещё
 * не закоммиченную работу; для валидации уже закоммиченного изменения ответ
 * бессмыслен, и вызывающий обязан не задавать вопрос — сравнение дерева с HEAD
 * там описывало бы посторонние правки оператора, а не проверяемый commit.
 * Любая неуверенность — новый файл, удалённый файл, незнакомое расширение,
 * недоступный TypeScript, не принятый парсером файл — тоже «нет»: цена ошибки
 * в эту сторону — лишний прогон, в обратную — пропущенные тесты.
 */
export function changeIsCommentOnly(changedFiles, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const readFile =
    dependencies.readFile ?? ((file) => readFileSync(path.join(projectRoot, file), 'utf8'));
  const typescript = dependencies.typescript ?? loadTypeScript();
  if (!typescript) return false;

  let sawChange = false;
  for (const file of changedFiles ?? []) {
    const normalized = String(file ?? '')
      .trim()
      .replaceAll('\\', '/');
    const isDocumentation = commentOnlyDocumentationExtensions.test(normalized);
    if (!isDocumentation && !commentOnlyScriptExtensions.test(normalized)) return false;

    const before = execute('git', ['show', `HEAD:${normalized}`], { allowFailure: true });
    if (before.status !== 0) return false;
    let after;
    try {
      after = readFile(normalized);
    } catch {
      return false;
    }
    // Сравнение после trim с обеих сторон: run() обрезает края вывода git show,
    // и без него любой файл с завершающим переводом строки выглядел бы
    // изменённым.
    if (before.stdout.trim() === String(after).trim()) continue;

    sawChange = true;
    if (isDocumentation) continue;
    try {
      const beforeTokens = scriptTokensIgnoringComments(before.stdout, normalized, typescript);
      const afterTokens = scriptTokensIgnoringComments(after, normalized, typescript);
      if (beforeTokens === null || beforeTokens !== afterTokens) return false;
    } catch {
      return false;
    }
  }
  return sawChange;
}

/**
 * `changedFiles` — пути, которые изменила эта issue. По ним набор сокращается
 * до применимых проверок; без них выполняется полный набор.
 *
 * Перед созданием PR валидация вызывается без аргумента намеренно: сокращённые
 * прогоны покрывают каждую issue по отдельности, а ветку целиком должен один
 * раз проверить полный набор.
 */
export function runConfiguredValidation(config, changedFiles, options = {}) {
  // Проверка стоит здесь, а не в runConfiguredScripts: дрейф вносит только
  // сессия агента, а preflight выполняется по заведомо чистому дереву.
  assertValidationDependenciesCommitted();
  let selection = config.scopedValidation
    ? validationScriptsForChangedFiles(config.validationScripts, changedFiles)
    : { scripts: config.validationScripts, skipped: [], narrowed: false, requiresDatabase: true };
  // Дешёвая дорожка поверх карты областей. Требует явного разрешения от
  // вызывающего: определитель сравнивает рабочее дерево с HEAD, поэтому он
  // применим только к ещё не закоммиченной работе агента. На валидации уже
  // закоммиченного изменения (already-fixed, committed recovery) сравнение
  // описывало бы посторонние правки оператора в дереве, а не проверяемый
  // commit, и кодовое изменение могло бы пройти без тестов. Пробуется только
  // когда карта областей всё равно требует базу — на md-only изменении карта
  // уже дешевле.
  if (
    options.allowCommentOnlyLane === true &&
    config.scopedValidation &&
    config.commentOnlyValidation &&
    selection.requiresDatabase &&
    Array.isArray(changedFiles) &&
    changedFiles.length > 0 &&
    changeIsCommentOnly(changedFiles)
  ) {
    const commentOnlySelection = validationScriptsForCommentOnlyChange(config.validationScripts);
    if (commentOnlySelection.narrowed) {
      selection = commentOnlySelection;
      console.log(
        'Validation сокращена: изменение не тронуло ни одного токена кода ' +
          '(комментарии и документация).',
      );
    }
  }
  if (selection.narrowed) {
    console.log(
      `Validation сокращена по области изменения: пропущены ${selection.skipped.join(', ')}.`,
    );
  }
  // Каждый validation-запуск получает новый контейнер с новой изолированной БД и
  // выполняет preflight первым, чтобы migration текущей issue была применена
  // внутри того же контейнера, что и остальные scripts.
  return runConfiguredScripts(config, selection.scripts, 'Validation', {
    includePreflight: selection.requiresDatabase,
  });
}
