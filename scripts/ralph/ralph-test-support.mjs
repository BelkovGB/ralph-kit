import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, prepareConfig, trustedFileHash } from './ralph-config.mjs';

/**
 * Общие фикстуры тестов Ralph: те, которыми пользуется больше одного файла.
 */

/**
 * Каталог git этой копии репозитория.
 *
 * В worktree `.git` — файл со строкой `gitdir: <путь>`, и mkdir внутри него
 * роняет прогон на импорте этого модуля. Путь из файла ведёт в приватный
 * каталог worktree внутри основного `.git`: он исполняемый и невидимый для
 * `git ls-files`, как и обычный `.git`. Когда `.git` нет вовсе — так выглядит
 * workspace контейнера проверок, — возвращается путь для создания.
 */
export function repositoryGitDirectory(root) {
  const dotGit = path.join(root, '.git');
  const stats = statSync(dotGit, { throwIfNoEntry: false });
  if (!stats?.isFile()) return dotGit;
  const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'));

  return pointer ? path.resolve(root, pointer[1].trim()) : dotGit;
}

// Validation deliberately mounts /tmp with noexec, so fake executables cannot
// live there. `.git` is on the exec-mounted workspace, exists in every clone
// and in the container snapshot, and `git ls-files` never lists it — so its
// contents cannot leak into a validation snapshot.
export const executableTempDirectory = path.join(
  repositoryGitDirectory(fileURLToPath(new URL('../..', import.meta.url))),
  'ralph-test',
);
mkdirSync(executableTempDirectory, { recursive: true });

export function fakeCodexScript(source) {
  const directory = mkdtempSync(path.join(executableTempDirectory, '.ralph-fake-codex-'));
  const scriptPath = path.join(directory, 'fake-codex.mjs');
  writeFileSync(scriptPath, source, 'utf8');

  if (process.platform === 'win32') {
    writeFileSync(
      path.join(directory, 'codex.cmd'),
      '@echo off\r\nnode "%~dp0fake-codex.mjs" %*\r\n',
      'utf8',
    );
  } else {
    const executablePath = path.join(directory, 'codex');
    writeFileSync(executablePath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, 'utf8');
    chmodSync(executablePath, 0o755);
  }

  return directory;
}

export async function withFakeCodex(source, operation) {
  const directory = fakeCodexScript(source);
  const originalPath = process.env.PATH;
  const originalCodexHome = process.env.CODEX_HOME;
  writeFileSync(path.join(directory, 'auth.json'), '{}\n', { encoding: 'utf8', mode: 0o600 });
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ''}`;
  process.env.CODEX_HOME = directory;

  try {
    return await operation();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

export function fakeClaudeScript(source) {
  const directory = mkdtempSync(path.join(executableTempDirectory, '.ralph-fake-claude-'));
  const scriptPath = path.join(directory, 'fake-claude.mjs');
  writeFileSync(scriptPath, source, 'utf8');

  if (process.platform === 'win32') {
    // commandSpec направляет claude через cmd.exe /c claude.cmd, как и codex:
    // установка Claude Code пакетным менеджером кладёт именно .cmd.
    writeFileSync(
      path.join(directory, 'claude.cmd'),
      '@echo off\r\nnode "%~dp0fake-claude.mjs" %*\r\n',
      'utf8',
    );
  } else {
    const executablePath = path.join(directory, 'claude');
    writeFileSync(executablePath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, 'utf8');
    chmodSync(executablePath, 0o755);
  }

  return directory;
}

/**
 * operation получает `receivedArguments()` — argv, который реально дошёл до
 * поддельного CLI. Без этого тест проходит и при аргументе, обрезанном
 * cmd.exe: многострочная схема ревью доходит до него как «{».
 */
export async function withFakeClaude(source, operation) {
  const directory = fakeClaudeScript(source);
  const argumentsPath = path.join(directory, 'received-argv.json');
  const originalPath = process.env.PATH;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ''}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';

  try {
    return await operation({
      receivedArguments: () => JSON.parse(readFileSync(argumentsPath, 'utf8')),
    });
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Временное дерево проекта: карта «путь через слеш → содержимое».
 *
 * Тест подделки control plane работает с настоящими файлами на диске, а корень
 * доверенного набора — это корень проекта, куда набор поставлен. Тест, который
 * пишет файлы туда, правит и удаляет чужие исходники, поэтому дерево живёт во
 * временном каталоге. Вызывающий удаляет его сам.
 */
export function temporaryProjectTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-project-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(root, ...relativePath.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  return root;
}

/**
 * Конфигурация прогона, где доверенными считаются только переданные файлы.
 *
 * Хеши считает та же функция, что и `loadConfig`, поэтому подделка файла из
 * временного дерева останавливает сессию там же, где подделка файла проекта.
 * Файлы проекта из карты убраны: тест отвечает за один файл, а правка любого
 * другого файла набора, сделанная в это же время, роняла бы его чужой ошибкой.
 */
export function configTrustingOnly(trustedFiles, overrides = {}) {
  return {
    ...loadConfig(),
    ...overrides,
    trustedControlFileHashes: new Map(trustedFiles.map((file) => [file, trustedFileHash(file)])),
  };
}

export function context(overrides = {}) {
  const { config: configOverrides, ...rest } = overrides;
  return {
    mode: '--run',
    // config сливается с базовым, чтобы тест переопределял одно поле, а не
    // повторял весь набор.
    config: {
      branch: 'feature/test',
      milestone: 'Test milestone',
      maxIterations: 5,
      ...configOverrides,
    },
    repository: 'owner/repository',
    milestone: { number: 7, title: 'Test milestone' },
    repositoryState: { currentBranch: 'feature/test', clean: true },
    rules: 'test rules',
    ...rest,
  };
}

export function actions(overrides = {}) {
  return {
    clearIssueCompletionState: () => {},
    closeMilestone: () => {},
    issueState: () => 'CLOSED',
    openIssues: () => [],
    refreshIssue: (_repository, _issueNumber, issue) => ({
      ...issue,
      state: 'OPEN',
    }),
    printCheck: () => {},
    runPreflight: () => {},
    runAgentOnIssue: async () => {},
    createPullRequest: () => ({ number: 10, headRefOid: 'head-1' }),
    runMilestoneReview: async () => ({ verdict: 'pass', summary: 'ok', findings: [] }),
    createOrReopenReviewIssues: () => [],
    verifyReviewedPullRequestHead: () => {},
    workingTreeStatus: () => '',
    ...overrides,
  };
}

export const ralphConfigPath = fileURLToPath(
  new URL('../../.agents/ralph.config.json', import.meta.url),
);

/**
 * Проверка настроек на изменённом конфиге — без записи на диск.
 *
 * Правка идёт в памяти, потому что файл конфигурации принадлежит проекту, а не
 * тесту: параллельный тестовый файл считает его контрольную сумму ровно в
 * момент подмены, а тест, упавший до восстановления, оставляет проекту чужие
 * настройки. `prepareConfig` — это и есть весь разбор конфигурации: `loadConfig`
 * добавляет к нему только чтение файла и `applyRuntimeSettings`, которая правит
 * глобальные таймауты процесса и в проверке настроек не нужна.
 *
 * Ключ со значением `undefined` означает «ключа в файле нет»: запись на диск
 * такие ключи отбрасывала, и проверки «поля нет» опираются на это.
 */
export function withPatchedRalphConfig(patch, assertConfig) {
  const candidate = { ...JSON.parse(readFileSync(ralphConfigPath, 'utf8')), ...patch };
  for (const [field, value] of Object.entries(candidate)) {
    if (value === undefined) delete candidate[field];
  }
  assertConfig(prepareConfig(candidate));
}

let cachedControlPlane = null;

// Доверенный control plane — это пара: карта хешей и набор файлов инструкций.
// Фикстура обязана нести обе части, иначе проверка неизменности видит
// несуществующее расхождение набора.
function controlPlane() {
  cachedControlPlane ??= loadConfig();
  return cachedControlPlane;
}

export function trustedControlFileHashes() {
  return controlPlane().trustedControlFileHashes;
}

export function trustedAgentInstructionFiles() {
  return controlPlane().agentInstructionFiles;
}

/**
 * Поддельный `gh` на PATH.
 *
 * Логика подделки пишется CommonJS-телом: ему доступны `ghArguments` — argv без
 * служебных элементов — и стандартные require. На POSIX подделку запускает
 * shell-шим. На Windows цикл ищет именно `gh.exe`, и текстовый шим CreateProcess
 * не исполнит, поэтому gh.exe — копия node.exe, а тело подключается через
 * NODE_OPTIONS --require и в чужих процессах node узнаёт чужое имя и молчит.
 */
export async function withFakeGh(logicBody, operation) {
  const directory = mkdtempSync(path.join(executableTempDirectory, '.ralph-fake-gh-'));
  const logicPath = path.join(directory, 'fake-gh-logic.cjs');
  writeFileSync(
    logicPath,
    `
const ghExecutableName = require('node:path').basename(process.execPath).toLowerCase();
const invokedAsGh = ghExecutableName === 'gh.exe' || ghExecutableName === 'gh';
const invokedAsScript = process.argv[1] === __filename;
if (invokedAsGh || invokedAsScript) {
  // Node абсолютизирует argv[1], приняв первый аргумент за путь скрипта:
  // «pr» приезжает как «C:\\...\\pr». Возвращаем ему исходный вид.
  const ghArguments = invokedAsScript
    ? process.argv.slice(2)
    : [require('node:path').basename(process.argv[1] ?? ''), ...process.argv.slice(2)];
  ${logicBody}
  process.exit(0);
}
`,
    'utf8',
  );
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, path.join(directory, 'gh.exe'));
  } else {
    const executablePath = path.join(directory, 'gh');
    writeFileSync(executablePath, `#!/bin/sh\nexec node "${logicPath}" "$@"\n`, 'utf8');
    chmodSync(executablePath, 0o755);
  }

  const savedPath = process.env.PATH;
  const savedNodeOptions = process.env.NODE_OPTIONS;
  process.env.PATH = `${directory}${path.delimiter}${savedPath ?? ''}`;
  if (process.platform === 'win32') {
    process.env.NODE_OPTIONS = `${savedNodeOptions ?? ''} --require ${logicPath}`.trim();
  }

  try {
    return await operation({ directory, logicPath });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
    rmSync(directory, { recursive: true, force: true });
  }
}
