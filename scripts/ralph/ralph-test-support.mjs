import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './ralph-config.mjs';

/**
 * Общие фикстуры тестов Ralph: те, которыми пользуется больше одного файла.
 */

export const executableTempDirectory = fileURLToPath(
  new URL('../../node_modules/', import.meta.url),
);

export function fakeCodexScript(source) {
  // Validation deliberately mounts /tmp with noexec. Keep fake executables in
  // the executable workspace instead; node_modules is ignored and writable in
  // both local and isolated test runs.
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
    // npm-установка Claude Code кладёт именно .cmd.
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
 * поддельного CLI. Без этого тесты проходили бы при аргументе, обрезанном
 * cmd.exe: именно так многострочная схема ревью доходила как «{».
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

export function withPatchedRalphConfig(patch, assertConfig) {
  const original = readFileSync(ralphConfigPath, 'utf8');
  const candidate = { ...JSON.parse(original), ...patch };
  writeFileSync(ralphConfigPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  try {
    assertConfig(loadConfig());
  } finally {
    writeFileSync(ralphConfigPath, original, 'utf8');
  }
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
