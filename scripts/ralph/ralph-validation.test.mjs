import { validateIssueWorkingTree } from './ralph-loop.mjs';
import { prepareConfig } from './ralph-config.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  hostHomeDirectory,
  hostValidationEnvironment,
  validatedLisaPathDirectories,
  hostWorkingTreeHash,
  removeValidationArtifacts,
  runConfiguredScripts,
  runConfiguredValidation,
  runPreflight,
} from './ralph-validation-runner.mjs';
import {
  ralphConfigPath,
  trustedAgentInstructionFiles,
  trustedControlFileHashes,
  withPatchedRalphConfig,
} from './ralph-test-support.mjs';
import { createStateStore, setActiveStateStore } from './ralph-state-store.mjs';

function hostValidationConfig(overrides = {}) {
  return {
    validationEnvironment: ['CI=true', 'DATABASE_URL=postgres://validation'],
    preflightScripts: ['pnpm db:migrate'],
    validationScripts: ['pnpm check'],
    runtime: { validationRunTimeoutMs: 9_000 },
    trustedControlFileHashes: trustedControlFileHashes(),
    agentInstructionFiles: trustedAgentInstructionFiles(),
    ...overrides,
  };
}

function unchangedHostTreeRun(calls = []) {
  return (command, args, options) => {
    if (command === 'git') {
      return { status: 0, stdout: 'scripts/ralph/README.md\0', stderr: '' };
    }
    calls.push({ command, args, options });
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('idle watchdog failure retains its cause through host validation', () => {
  const ordinary = unchangedHostTreeRun();
  assert.throws(() => runConfiguredScripts(hostValidationConfig(), ['pnpm check'], 'Validation', {
    run(command, args, options) {
      if (command === 'git') return ordinary(command, args, options);
      throw Object.assign(new Error('silent command'), { code: 'RALPH_COMMAND_IDLE_TIMEOUT' });
    },
  }), error => error.code === 'RALPH_COMMAND_IDLE_TIMEOUT');
});

test('проверки идут в проекте: preflight, затем набор, с окружением из конфига', () => {
  const calls = [];
  const result = runConfiguredScripts(hostValidationConfig(), ['pnpm check'], 'Validation', {
    run: unchangedHostTreeRun(calls),
    environmentSource: {
      PATH: process.env.PATH,
      CODEX_HOME: 'must-not-leak',
    },
  });

  assert.deepEqual(result.scripts, ['pnpm db:migrate', 'pnpm check']);
  assert.deepEqual(result.timings.map(({ stage, passed }) => [stage, passed]), [
    ['preflight', true], ['check', true],
  ]);
  assert.equal(calls.length, 2);
  if (process.platform === 'win32') assert.equal(calls[0].command, 'cmd');
  assert.equal(calls[0].options.env.DATABASE_URL, 'postgres://validation');
  assert.equal(calls[0].options.env.CI, 'true');
  assert.equal(calls[0].options.env.CODEX_HOME, undefined);
});

test('issue and phase validation use separate project commands and a scoped base commit', () => {
  const baseCommit = 'a'.repeat(40);
  const config = hostValidationConfig({
    preflightScripts: ['prepare-once'],
    validationProfiles: {
      issue: ['check-issue'],
      phase: ['check-phase'],
      baseSync: ['check-base-sync'],
    },
  });
  for (const [scope, expected] of [
    ['issue', 'check-issue'],
    ['phase', 'check-phase'],
    ['baseSync', 'check-base-sync'],
  ]) {
    const calls = [];
    const result = runConfiguredValidation(config, {
      scope,
      baseCommit,
      skipPreflight: true,
      run: unchangedHostTreeRun(calls),
    });
    assert.deepEqual(result.scripts, [expected]);
    assert.equal(calls[0].options.env.RALPH_VALIDATION_SCOPE, scope);
    assert.equal(calls[0].options.env.RALPH_VALIDATION_BASE_COMMIT, baseCommit);
  }
});

test('browser commands run for approved UI work and the final phase only', () => {
  const baseCommit = 'a'.repeat(40);
  const config = hostValidationConfig({
    preflightScripts: [],
    validationProfiles: { issue: ['check-issue'], phase: ['check-phase'], baseSync: ['check-base'] },
    browserValidationScripts: ['check-browser'],
    approvedIssueSnapshots: {
      12: { body: '<!-- ralph-process: ui-change -->\nCheck the updated flow.' },
      13: { body: 'Ordinary issue.' },
    },
    review: { enabled: true },
  });
  for (const [scope, issueNumber, expected] of [
    ['issue', 12, ['check-issue', 'check-browser']],
    ['issue', 13, ['check-issue']],
    ['phase', undefined, ['check-phase', 'check-browser']],
    ['baseSync', undefined, ['check-base']],
  ]) {
    const calls = [];
    const result = runConfiguredValidation(config, {
      scope, baseCommit, issueNumber, run: unchangedHostTreeRun(calls),
    });
    assert.deepEqual(result.scripts, expected);
    assert.equal(calls.length, expected.length);
  }
});

test('browser commands use the same configuration constraints as ordinary checks', () => {
  const config = JSON.parse(readFileSync(ralphConfigPath, 'utf8'));
  const prepare = (browserValidationScripts) => prepareConfig(
    { ...structuredClone(config), browserValidationScripts }, { captureControlPlane: false },
  );
  assert.deepEqual(prepare(['node check-browser.mjs']).browserValidationScripts, ['node check-browser.mjs']);
  assert.throws(() => prepare('node check-browser.mjs'), /browserValidationScripts/);
  assert.throws(() => prepare(['check-browser | echo PASS']), /операторы/);
});

test('Lisa can append an installed tool directory to validation PATH without changing config', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-lisa-path-'));
  try {
    const accepted = validatedLisaPathDirectories([directory]);
    assert.deepEqual(accepted, [realpathSync(directory)]);
    const environment = hostValidationEnvironment(
      hostValidationConfig({ validationEnvironment: ['PATH=original'] }),
      { PATH: 'operator-path' }, accepted,
    );
    assert.equal(environment.PATH, `original${path.delimiter}${realpathSync(directory)}`);
    assert.throws(() => validatedLisaPathDirectories(['relative/path']), /абсолютных/);
    assert.throws(() => validatedLisaPathDirectories([`${directory}\nother`]), /абсолютных/);
    assert.throws(() => validatedLisaPathDirectories([`${directory}${path.delimiter}other`]), /абсолютных/);
    assert.throws(() => validatedLisaPathDirectories([path.dirname(fileURLToPath(import.meta.url))]), /внутри проекта/);
    assert.deepEqual(
      validatedLisaPathDirectories(
        [path.dirname(fileURLToPath(import.meta.url)), directory],
        { ignoreProjectDirectories: true },
      ),
      [realpathSync(directory)],
    );
    assert.throws(() => validatedLisaPathDirectories(['relative/path'],
      { ignoreProjectDirectories: true }), /абсолютных/);
    assert.throws(() => validatedLisaPathDirectories([path.join(directory, 'missing')],
      { ignoreProjectDirectories: true }), /каталог/);
    assert.throws(() => validatedLisaPathDirectories([path.join(directory, 'missing')]), /каталог/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('saved Lisa PATH reaches validation after a process restart', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-lisa-path-'));
  const statePath = path.join(directory, 'state.json');
  const toolsDirectory = path.join(directory, 'tools');
  mkdirSync(toolsDirectory);
  const stateConfig = { branch: 'test', baseBranch: 'main', milestone: 'One' };
  try {
    const first = createStateStore(stateConfig, '--run', statePath);
    first.setValidationPathDirectories(validatedLisaPathDirectories([toolsDirectory]));
    setActiveStateStore(createStateStore(stateConfig, '--run', statePath));
    const calls = [];
    runConfiguredScripts(hostValidationConfig(), ['pnpm check'], 'Validation', {
      run: unchangedHostTreeRun(calls),
      environmentSource: { PATH: 'original' },
    });
    assert.equal(calls[0].options.env.PATH, `original${path.delimiter}${realpathSync(toolsDirectory)}`);
  } finally {
    setActiveStateStore(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('host validation rejects a check that changes project files', () => {
  // Один снимок дерева — два вызова git: изменённые отслеживаемые файлы и новые.
  let gitCalls = 0;
  const execute = (command) => {
    if (command !== 'git') return { status: 0, stdout: '', stderr: '' };
    gitCalls += 1;
    return {
      status: 0,
      stdout: `${gitCalls <= 2 ? 'scripts/ralph/README.md' : 'README.md'}\0`,
      stderr: '',
    };
  };

  assert.throws(
    () =>
      runConfiguredScripts(hostValidationConfig({ preflightScripts: [] }), ['pnpm check'], 'Validation', {
        run: execute,
      }),
    (error) => {
      assert.equal(error.code, 'RALPH_VALIDATION_MUTATED');
      assert.match(error.message, /изменили отслеживаемые или новые файлы проекта/u);
      assert.match(error.expectedTreeHash, /^[a-f0-9]{64}$/u);
      assert.match(error.observedTreeHash, /^[a-f0-9]{64}$/u);
      assert.notEqual(error.expectedTreeHash, error.observedTreeHash);
      return true;
    },
  );
});

test('host validation names the command that failed', () => {
  let shellCalls = 0;
  const execute = (command) => {
    if (command === 'git') {
      return { status: 0, stdout: 'scripts/ralph/README.md\0', stderr: '' };
    }
    shellCalls += 1;
    if (shellCalls === 2) {
      throw Object.assign(new Error('failed'), { code: 'RALPH_COMMAND_FAILED' });
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.throws(
    () => runConfiguredScripts(hostValidationConfig(), ['pnpm check'], 'Validation', { run: execute }),
    (error) => {
      assert.equal(error.code, 'RALPH_VALIDATION_FAILED');
      assert.equal(error.script, 'pnpm check');
      return true;
    },
  );
});

test('host: подделка доверенного control-файла останавливает проверки до первой команды', () => {
  const calls = [];
  const orchestratorPath = fileURLToPath(new URL('./ralph-loop.mjs', import.meta.url));
  const tamperedHashes = new Map(hostValidationConfig().trustedControlFileHashes);
  assert.equal(tamperedHashes.has(orchestratorPath), true);
  tamperedHashes.set(orchestratorPath, 'not-the-real-hash');

  assert.throws(
    () =>
      runConfiguredScripts(
        hostValidationConfig({ trustedControlFileHashes: tamperedHashes }),
        ['pnpm check'],
        'Validation',
        { run: unchangedHostTreeRun(calls) },
      ),
    /изменила доверенный файл/u,
  );
  assert.deepEqual(calls, [], 'ни одна команда проверки не выполняется после подделки');
});

test('host: изменённый набор файлов инструкций останавливает проверки до первой команды', () => {
  const calls = [];

  assert.throws(
    () =>
      runConfiguredScripts(
        hostValidationConfig({ agentInstructionFiles: [] }),
        ['pnpm check'],
        'Validation',
        { run: unchangedHostTreeRun(calls) },
      ),
    /изменила набор доверенных файлов инструкций/u,
  );
  assert.deepEqual(calls, []);
});

test('host: общий бюджет прогона обрывает набор своим кодом, а не провалом проверки', () => {
  // Бюджет считается от реальных часов внутри runner, подменить их нечем,
  // поэтому поддельная команда честно занимает время: 40 мс против бюджета
  // в 25 мс делают исход детерминированным на любой машине.
  const budgetMs = 25;
  const calls = [];
  const execute = (command, args, options) => {
    if (command === 'git') {
      return { status: 0, stdout: 'scripts/ralph/README.md\0', stderr: '' };
    }
    calls.push({ command, args, options });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.throws(
    () =>
      runConfiguredScripts(
        hostValidationConfig({ runtime: { validationRunTimeoutMs: budgetMs } }),
        ['pnpm check'],
        'Validation',
        { run: execute },
      ),
    (error) => {
      assert.equal(error.code, 'RALPH_COMMAND_TIMEOUT');
      assert.match(error.message, new RegExp(`общий лимит ${budgetMs} ms исчерпан`, 'u'));
      assert.equal(error.script, 'pnpm check');
      return true;
    },
  );
  assert.deepEqual(
    calls.map((call) => call.args.at(-1)),
    ['pnpm db:migrate'],
    'команда после исчерпания бюджета не запускается',
  );
});

test('host: пустой набор команд не берёт снимок дерева и не трогает доверенные файлы', () => {
  const calls = [];
  const result = runConfiguredScripts(
    hostValidationConfig({ preflightScripts: [], trustedControlFileHashes: new Map() }),
    [],
    'Validation',
    { run: unchangedHostTreeRun(calls) },
  );

  assert.deepEqual(result, { ran: false, scripts: [] });
  assert.deepEqual(calls, []);
});

test('host validation reports both a failed command and its file mutation', () => {
  let gitCalls = 0;
  const commandFailure = Object.assign(new Error('native command failed'), {
    code: 'RALPH_COMMAND_FAILED',
  });
  const execute = (command) => {
    if (command === 'git') {
      gitCalls += 1;
      return {
        status: 0,
        stdout: `${gitCalls <= 2 ? 'scripts/ralph/README.md' : 'README.md'}\0`,
        stderr: '',
      };
    }
    throw commandFailure;
  };

  assert.throws(
    () =>
      runConfiguredScripts(
        hostValidationConfig({ preflightScripts: [] }),
        ['pnpm check'],
        'Validation',
        { run: execute },
      ),
    (error) => {
      assert.equal(error.code, 'RALPH_VALIDATION_MUTATED');
      assert.equal(error.script, 'pnpm check');
      assert.match(error.message, /изменили отслеживаемые или новые файлы/u);
      assert.match(error.message, /native command failed/u);
      assert.equal(error.cause, commandFailure);
      return true;
    },
  );
});

test('host validation hashes files without copying the workspace', () => {
  const hash = hostWorkingTreeHash({
    run: () => ({ status: 0, stdout: 'scripts/ralph/README.md\0', stderr: '' }),
  });
  assert.match(hash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    hostValidationEnvironment(hostValidationConfig(), {
      PATH: 'safe-path',
      CODEX_HOME: 'secret-path',
    }),
    {
      PATH: 'safe-path',
      // Домашний каталог выдаёт Ralph: без него инструменты не находят кэш, а
      // профиль оператора хранит credentials.
      HOME: hostHomeDirectory,
      USERPROFILE: hostHomeDirectory,
      APPDATA: path.join(hostHomeDirectory, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(hostHomeDirectory, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(hostHomeDirectory, '.config'),
      XDG_CACHE_HOME: path.join(hostHomeDirectory, '.cache'),
      CI: 'true',
      DATABASE_URL: 'postgres://validation',
    },
  );
});

function isInsideDirectory(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

test('host validation home stays outside the project workspace and outside shared temp', () => {
  // Путь выводится из пути проекта, то есть известен заранее. В общем temp
  // (на POSIX это 1777) сосед по машине создал бы его первым и положил туда
  // свой .gitconfig или .npmrc, а Ralph отдал бы этот каталог командам
  // проверок как HOME — чужой код выполнился бы с правами оператора.
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

  assert.equal(isInsideDirectory(projectRoot, hostHomeDirectory), false);
  assert.equal(isInsideDirectory(tmpdir(), hostHomeDirectory), false);
  assert.equal(isInsideDirectory(homedir(), hostHomeDirectory), true);
  // Сам профиль оператора командам всё равно не достаётся: HOME указывает на
  // подкаталог, а не на домашний каталог.
  assert.notEqual(path.resolve(hostHomeDirectory), path.resolve(homedir()));
});

test('путь оператора внутри рабочей папки отвергается', () => {
  // Абсолютный путь проверку проходил, а созданные в нём файлы попадали в
  // отпечаток дерева: прогон останавливался как на подделке, и цикл сам из
  // этого состояния не выходил.
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

  assert.throws(
    () =>
      hostValidationEnvironment(
        hostValidationConfig({
          validationEnvironment: [`XDG_CACHE_HOME=${path.join(projectRoot, '.cache')}`],
        }),
        { PATH: 'safe-path' },
      ),
    /XDG_CACHE_HOME.*рабочей папки/u,
  );
});

test('отказ подготовки каталогов останавливает прогон, а не уходит агенту как провал проверок', () => {
  // Каталог на разделе только для чтения — беда окружения. Провал проверок
  // отправляет агента чинить код, и все попытки уходят на ошибку, которую
  // правка репозитория не устраняет.
  const failingMkdir = () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  };
  const commands = [];

  assert.throws(
    () =>
      runConfiguredScripts(hostValidationConfig(), ['pnpm check'], 'Validation', {
        run: (command, args) => {
          commands.push(args.at(-1));
          return { status: 0, stdout: '', stderr: '' };
        },
        mkdir: failingMkdir,
      }),
    (error) => {
      assert.equal(error.code, 'RALPH_VALIDATION_ENVIRONMENT');
      assert.match(error.message, /EACCES/u);
      return true;
    },
  );
  assert.deepEqual(commands, [], 'ни одна команда проверок не запускается');
});

test('the per-run validation budget is validated and defaults when omitted', () => {
  // Значение по умолчанию проверяется на конфиге без этого поля, а не на
  // значении из файла проекта: проект вправе задать своё, и тест, сверяющий
  // умолчание с настройкой проекта, ловил бы её, а не поведение кода.
  const original = JSON.parse(readFileSync(ralphConfigPath, 'utf8'));
  const { validationRunTimeoutMs, ...runtimeWithoutBudget } = original.runtime;
  withPatchedRalphConfig({ runtime: runtimeWithoutBudget }, (config) => {
    assert.equal(config.runtime.validationRunTimeoutMs, 3_600_000);
  });

  assert.throws(
    () =>
      withPatchedRalphConfig(
        { runtime: { ...original.runtime, validationRunTimeoutMs: 0 } },
        () => {
          throw new Error('loadConfig should have failed');
        },
      ),
    /Поле "runtime\.validationRunTimeoutMs" должно быть целым числом больше 0\./,
  );
});

// snapshots whose bytes they control directly.
test('host-проверка получает свой домашний каталог вместо профиля оператора', () => {
  // Без HOME цепочки Go, Rust, JVM и npm падают на поиске кэша ещё до команды
  // проекта, а профиль оператора отдавать нельзя: в нём лежат credentials.
  const environment = hostValidationEnvironment(hostValidationConfig(), {
    PATH: 'safe-path',
    CODEX_HOME: 'secret-path',
    USERPROFILE: 'C:\Users\operator',
    HOME: '/home/operator',
  });

  assert.equal(environment.CODEX_HOME, undefined);
  assert.equal(environment.HOME, hostHomeDirectory);
  assert.equal(environment.USERPROFILE, environment.HOME);
  assert.equal(environment.APPDATA, path.join(environment.HOME, 'AppData', 'Roaming'));
  assert.equal(environment.LOCALAPPDATA, path.join(environment.HOME, 'AppData', 'Local'));
  assert.equal(environment.XDG_CONFIG_HOME, path.join(environment.HOME, '.config'));
  assert.equal(environment.XDG_CACHE_HOME, path.join(environment.HOME, '.cache'));

  const overridden = hostValidationEnvironment(
    hostValidationConfig({ validationEnvironment: ['HOME=/custom/home'] }),
    { PATH: 'safe-path' },
  );
  assert.equal(overridden.HOME, '/custom/home');
  assert.equal(overridden.USERPROFILE, '/custom/home');
  assert.equal(overridden.XDG_CONFIG_HOME, path.join('/custom/home', '.config'));
});

test('отдельный прогон preflight не считает подготовку правкой дерева', () => {
  // runPreflight в начале фазы выполняет команды подготовки, и по контракту
  // они вправе менять дерево: миграции и генерация кода для того и существуют.
  // Снимок дерева обязан браться после них, иначе прогон падает на собственной
  // подготовке ещё до первой issue.
  let prepared = false;
  const calls = [];
  const execute = (command, args, options) => {
    if (command === 'git') {
      return {
        status: 0,
        stdout: `${prepared ? 'package-lock.json' : 'scripts/ralph/README.md'} `,
        stderr: '',
      };
    }
    calls.push({ command, args, options });
    prepared = true;
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = runPreflight(hostValidationConfig({ preflightScripts: ['npm ci'] }), {
    run: execute,
  });

  assert.deepEqual(result.scripts, ['npm ci']);
  assert.equal(calls.length, 1);
});

test('host: preflight готовит окружение до снимка дерева, проверки — после', () => {
  // Preflight по контракту меняет дерево: генерация кода и миграции для того и
  // существуют. Снимок до него останавливал бы прогон на собственной
  // подготовке, и следующий запуск повторял бы её с тем же исходом.
  const log = [];
  let listing = 'README.md\0';
  const execute = (command, args) => {
    if (command === 'git') {
      log.push('git');
      return { status: 0, stdout: listing, stderr: '' };
    }
    log.push(args.at(-1));
    if (args.at(-1) === 'pnpm db:migrate') listing = 'README.md\0CHANGELOG.md\0';
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = runConfiguredScripts(hostValidationConfig(), ['pnpm check'], 'Validation', {
    run: execute,
  });

  assert.equal(result.ran, true);
  // Два вызова git на снимок: изменённые отслеживаемые файлы и новые.
  assert.deepEqual(log, ['pnpm db:migrate', 'git', 'git', 'pnpm check', 'git', 'git']);
});

test('остановка host-проверки называет изменённые файлы', () => {
  // Оператор получает задание вернуть прежний diff. Без списка файлов он не
  // знает, что именно вернуть, а хеш дерева ему ничего не говорит.
  let gitCalls = 0;
  const execute = (command) => {
    if (command === 'git') {
      gitCalls += 1;
      return {
        status: 0,
        stdout: gitCalls <= 2 ? 'README.md\0' : 'README.md\0CHANGELOG.md\0',
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.throws(
    () =>
      runConfiguredScripts(
        hostValidationConfig({ preflightScripts: [] }),
        ['pnpm check'],
        'Validation',
        { run: execute },
      ),
    (error) => {
      assert.equal(error.code, 'RALPH_VALIDATION_MUTATED');
      assert.deepEqual(error.mutatedPaths, ['CHANGELOG.md']);
      assert.match(error.message, /CHANGELOG\.md/u);
      return true;
    },
  );
});

test('пустой и относительный путь домашнего каталога отвергаются, а не создаются в проекте', () => {
  // `validationEnvironment` принимает `HOME=` и `HOME=.ralph-home`: первое
  // роняло прогон на ENOENT внутри mkdir, второе создавало домашний каталог в
  // рабочей папке — то есть ровно там, откуда его выносили, да ещё и меняло
  // дерево, что останавливает проверку как подделку.
  const empty = hostValidationEnvironment(
    hostValidationConfig({ validationEnvironment: ['HOME='] }),
    { PATH: 'safe-path' },
  );
  assert.equal(empty.HOME, hostHomeDirectory);

  assert.throws(
    () =>
      hostValidationEnvironment(hostValidationConfig({ validationEnvironment: ['HOME=.ralph-home'] }), {
        PATH: 'safe-path',
      }),
    /HOME.*абсолютн/u,
  );
});

/**
 * Артефакты прошлого прогона.
 *
 * В host-режиме проверки идут в рабочей папке, и отчёт, оставленный браузерным
 * набором, попадает под следующий линтер. Ralph убирает названные пути перед
 * проверками, но только те, которых нет в Git: удалить отслеживаемый файл
 * значит потерять работу, а не прибраться.
 */
function artifactProject(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-artifacts-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return root;
}

function artifactGit(root) {
  return (command, args) => ({
    stdout: execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim(),
  });
}

test('конфиг на Windows отклоняет регистровый вариант .git с указанием пути', {
  skip: process.platform !== 'win32',
}, () => {
  const config = JSON.parse(readFileSync(ralphConfigPath, 'utf8'));
  config.validationArtifactPaths = ['.GIT/objects'];

  assert.throws(() => prepareConfig(config), /validationArtifactPaths.*\.GIT\/objects/u);
});

test('на Windows .GIT останавливает уборку до удаления в checkout и linked worktree', {
  skip: process.platform !== 'win32',
}, () => {
  const root = artifactProject({ 'checkout/report.txt': 'report' });
  const checkout = path.join(root, 'checkout');
  const linked = path.join(root, 'linked');
  const run = artifactGit(checkout);

  try {
    run('git', ['init', '--quiet']);
    run('git', ['-c', 'user.name=Ralph test', '-c', 'user.email=ralph@example.test',
      'commit', '--allow-empty', '--quiet', '-m', 'test: create worktree fixture']);
    run('git', ['worktree', 'add', '--quiet', '--detach', linked]);
    writeFileSync(path.join(linked, 'report.txt'), 'report');

    for (const worktree of [checkout, linked]) {
      const gitMarker = path.join(worktree, '.git');
      const report = path.join(worktree, 'report.txt');
      const git = artifactGit(worktree);
      const head = git('git', ['rev-parse', 'HEAD']).stdout;

      assert.throws(
        () => removeValidationArtifacts(
          { validationArtifactPaths: ['report.txt', '.GIT'] },
          { projectRoot: worktree, run: git },
        ),
        /validationArtifactPaths.*\.GIT.*Git/u,
      );
      assert.equal(readFileSync(report, 'utf8'), 'report');
      assert.equal(existsSync(gitMarker), true);
      assert.equal(git('git', ['rev-parse', 'HEAD']).stdout, head);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('артефакт не удаляет отдельный служебный каталог Git или его родителя', () => {
  const root = artifactProject({ 'report.txt': 'report' });
  const metadata = path.join(root, 'storage', 'metadata');
  const run = artifactGit(root);

  try {
    mkdirSync(path.dirname(metadata));
    run('git', ['init', '--quiet', '--separate-git-dir', metadata]);

    for (const artifact of ['storage/metadata', 'storage/metadata/objects', 'storage']) {
      assert.throws(
        () => removeValidationArtifacts(
          { validationArtifactPaths: ['report.txt', artifact] },
          { projectRoot: root, run },
        ),
        /validationArtifactPaths.*Git/u,
      );
    }
    assert.equal(readFileSync(path.join(root, 'report.txt'), 'utf8'), 'report');
    assert.equal(existsSync(path.join(metadata, 'HEAD')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('артефакты прошлых проверок удаляются перед прогоном', () => {
  const root = artifactProject({
    'apps/web/output/report/index.html': '<html></html>',
    'apps/web/output/trace.zip': 'zip',
    'apps/web/src/page.tsx': 'code',
  });
  const run = artifactGit(root);

  try {
    run('git', ['init', '--quiet']);
    const removed = removeValidationArtifacts(
      { validationArtifactPaths: ['apps/web/output', 'apps/web/missing'] },
      { projectRoot: root, run },
    );

    assert.deepEqual(removed, ['apps/web/output']);
    assert.equal(existsSync(path.join(root, 'apps', 'web', 'output')), false);
    // Отсутствующий путь — не ошибка: первый прогон начинается без артефактов.
    assert.equal(existsSync(path.join(root, 'apps', 'web', 'src', 'page.tsx')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('отслеживаемый путь Ralph не удаляет, а останавливает прогон', () => {
  const root = artifactProject({ 'docs/plan.md': 'план' });
  const run = artifactGit(root);

  try {
    run('git', ['init', '--quiet']);
    run('git', ['add', '--', 'docs/plan.md']);
    assert.throws(
      () =>
        removeValidationArtifacts(
          { validationArtifactPaths: ['docs'] },
          { projectRoot: root, run },
        ),
      /validationArtifactPaths.*docs.*Git/su,
    );
    assert.equal(existsSync(path.join(root, 'docs', 'plan.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('на Windows уборка сохраняет отслеживаемый путь после смены регистра', {
  skip: process.platform !== 'win32',
}, () => {
  const root = artifactProject({ ' Report.txt': 'report', 'Results/check.txt': 'check' });
  const run = artifactGit(root);

  try {
    run('git', ['init', '--quiet']);
    run('git', ['add', '--', ' Report.txt', 'Results/check.txt']);
    const intermediate = path.join(root, 'intermediate');
    for (const [before, after] of [[' Report.txt', ' report.txt'], ['Results', 'results']]) {
      renameSync(path.join(root, before), intermediate);
      renameSync(intermediate, path.join(root, after));
      for (const artifact of [before, after]) {
        assert.throws(
          () => removeValidationArtifacts(
            { validationArtifactPaths: [artifact] }, { projectRoot: root, run },
          ),
          /validationArtifactPaths.*отслеживается Git/u,
        );
        assert.equal(existsSync(path.join(root, after)), true);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('путь артефактов не выводит за пределы проекта', () => {
  const root = artifactProject({});
  const outside = mkdtempSync(path.join(tmpdir(), 'ralph-outside-'));

  try {
    for (const artifactPath of ['..', '../soseD', outside, '.git', '.git/objects', '.']) {
      assert.throws(
        () =>
          removeValidationArtifacts(
            { validationArtifactPaths: [artifactPath] },
            { projectRoot: root, run: () => ({ status: 0, stdout: '', stderr: '' }) },
          ),
        /validationArtifactPaths/u,
        `путь ${artifactPath} должен быть отклонён`,
      );
    }
    assert.equal(existsSync(outside), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('уборка идёт до preflight, а не после него', () => {
  // Preflight создаёт то, что нужно проверкам: генерация кода и миграции. Убор
  // после него снёс бы собственную подготовку прогона.
  const root = artifactProject({ 'output/old-report.html': 'прошлый прогон' });
  const git = artifactGit(root);
  const order = [];

  try {
    git('git', ['init', '--quiet']);
    runConfiguredValidation(
      hostValidationConfig({
        validationArtifactPaths: ['output'],
        preflightScripts: ['generate'],
        validationScripts: ['lint'],
      }),
      {
        projectRoot: root,
        run: (command, args) => {
          if (command === 'git') {
            return args[0] === '-C' ? git(command, args) : { status: 0, stdout: '', stderr: '' };
          }
          order.push(args.at(-1));
          if (args.at(-1) === 'generate') {
            mkdirSync(path.join(root, 'output'), { recursive: true });
            writeFileSync(path.join(root, 'output', 'schema.ts'), 'export {}', 'utf8');
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    assert.deepEqual(order, ['generate', 'lint']);
    assert.equal(existsSync(path.join(root, 'output', 'old-report.html')), false);
    // То, что подготовил preflight, уборка не трогает: она прошла раньше.
    assert.equal(existsSync(path.join(root, 'output', 'schema.ts')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('prepared callback observes generated files before guarded validation', () => {
  const events = [];
  runConfiguredScripts(hostValidationConfig(), ['pnpm check'], 'Validation', {
    run: (command, args, options) => {
      if (command !== 'git') events.push(args.at(-1));
      return unchangedHostTreeRun()(command, args, options);
    },
    onPrepared: () => events.push('prepared'),
  });
  assert.deepEqual(events, ['pnpm db:migrate', 'prepared', 'pnpm check']);
});


test('issue staging includes generated files and preserves foreign paths', () => {
  let status = ' M source.js';
  const entries = validateIssueWorkingTree({}, new Set(['operator.txt']), {
    workingTreeStatus: () => status,
    runConfiguredValidation: (_config, options) => {
      status = ' M source.js\n M generated.html\n?? generated-new.html\n M operator.txt';
      options.onPrepared();
    },
  });
  assert.deepEqual(entries.map(entry => entry.path), ['source.js', 'generated.html', 'generated-new.html']);
});

test('issue staging rejects mutations after preparation', () => {
  let status = ' M source.js';
  assert.throws(() => validateIssueWorkingTree({}, new Set(), {
    workingTreeStatus: () => status,
    runConfiguredValidation: (_config, options) => {
      options.onPrepared();
      status += '\n?? test-created.txt';
    },
  }), /Validation changed/);
});

test('committed recovery retries a connection failure once before escalation', () => {
  let attempts = 0;
  const first = Object.assign(new Error('command failed'), {
    code: 'RALPH_COMMAND_FAILED', stderr: 'ConnectionAbortedError: [WinError 10053] connection aborted',
  });
  assert.throws(() => runConfiguredValidation(hostValidationConfig({ preflightScripts: [] }), {
    retryConnectionFailure: true,
    run(command, args, options) {
      if (command === 'git') return unchangedHostTreeRun()(command, args, options);
      if (++attempts === 1) throw first;
      return { status: 0, stdout: '', stderr: '' };
    },
  }), error => error.code === 'RALPH_VALIDATION_UNSTABLE' && error.cause === first);
  assert.equal(attempts, 2);
});

test('project validation exit codes distinguish environment and existing failures', () => {
  for (const [status, code] of [
    [75, 'RALPH_VALIDATION_ENVIRONMENT'],
    [76, 'RALPH_VALIDATION_UNSTABLE'],
    [78, 'RALPH_VALIDATION_PREEXISTING'],
    [79, 'RALPH_VALIDATION_SCOPE_UNKNOWN'],
  ]) {
    assert.throws(() => runConfiguredValidation(hostValidationConfig({ preflightScripts: [] }), {
      run(command, args, options) {
        if (command === 'git') return unchangedHostTreeRun()(command, args, options);
        throw Object.assign(new Error(`check exited ${status}`), {
          code: 'RALPH_COMMAND_FAILED', status,
        });
      },
    }), error => error.code === code && error.status === status);
  }
});


function connectionError(code = 'RALPH_COMMAND_FAILED', text = 'Error: read ECONNRESET') {
  return Object.assign(new Error(text), { code });
}

for (const output of [
  { stdout: 'PASS handles ECONNRESET correctly', stderr: 'FAIL total: expected 42, received 41' },
  { stdout: '', stderr: 'PASS handles ECONNRESET correctly\nFAIL total: expected 42, received 41' },
  { stdout: 'Error: read ECONNRESET', stderr: '' },
  { stdout: 'AssertionError: expected 42', stderr: 'Error: read ECONNRESET' },
]) {
  test(`connection retry ignores non-diagnostic output ${JSON.stringify(output)}`, () => {
    let attempts = 0;
    const error = Object.assign(connectionError('RALPH_COMMAND_FAILED',
      `Command failed\n${output.stdout}\n${output.stderr}`), output);
    assert.throws(() => runConfiguredValidation(hostValidationConfig({ preflightScripts: [] }), {
      retryConnectionFailure: true,
      run(command, args, options) {
        if (command === 'git') return unchangedHostTreeRun()(command, args, options);
        attempts += 1;
        throw error;
      },
    }), observed => observed === error);
    assert.equal(attempts, 1);
  });
}

for (const scenario of ['disabled', 'assertion', 'timeout', 'preflight']) {
  test(`connection retry excludes ${scenario}`, () => {
    let attempts = 0;
    const error = connectionError(
      scenario === 'timeout' ? 'RALPH_COMMAND_TIMEOUT' : 'RALPH_COMMAND_FAILED',
      scenario === 'assertion' ? 'AssertionError: expected ECONNRESET' : 'Error: read ECONNRESET',
    );
    assert.throws(() => runConfiguredValidation(hostValidationConfig({
      preflightScripts: scenario === 'preflight' ? ['prepare'] : [],
    }), {
      retryConnectionFailure: scenario !== 'disabled',
      run(command, args, options) {
        if (command === 'git') return unchangedHostTreeRun()(command, args, options);
        attempts += 1;
        throw error;
      },
    }), observed => observed === error);
    assert.equal(attempts, 1);
  });
}

test('second connection failure escalates with the original cause', () => {
  let attempts = 0;
  const first = connectionError();
  const second = connectionError();
  assert.throws(() => runConfiguredValidation(hostValidationConfig({ preflightScripts: [] }), {
    retryConnectionFailure: true,
    run(command, args, options) {
      if (command === 'git') return unchangedHostTreeRun()(command, args, options);
      throw ++attempts === 1 ? first : second;
    },
  }), error => error === second && error.cause === first && error.code === 'RALPH_VALIDATION_FAILED');
  assert.equal(attempts, 2);
});

test('retry budget is shared across all validation commands', () => {
  const calls = [];
  assert.throws(() => runConfiguredValidation(hostValidationConfig({
    preflightScripts: [], validationScripts: ['first', 'second'],
  }), {
    retryConnectionFailure: true,
    run(command, args, options) {
      if (command === 'git') return unchangedHostTreeRun()(command, args, options);
      calls.push(args.at(-1));
      if (calls.length !== 2) throw connectionError();
      return { status: 0, stdout: '', stderr: '' };
    },
  }), /ECONNRESET/u);
  assert.deepEqual(calls, ['first', 'first', 'second']);
});

test('a connection failure that changes the tree is never retried', () => {
  let attempts = 0;
  assert.throws(() => runConfiguredValidation(hostValidationConfig({ preflightScripts: [] }), {
    retryConnectionFailure: true,
    run(command) {
      if (command === 'git') return {
        status: 0, stdout: attempts ? 'README.md\0CHANGELOG.md\0' : 'README.md\0', stderr: '',
      };
      attempts += 1;
      throw connectionError();
    },
  }), error => error.code === 'RALPH_VALIDATION_MUTATED');
  assert.equal(attempts, 1);
});

test('connection retry cannot reset the total validation deadline', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  let attempts = 0;
  assert.throws(() => runConfiguredValidation(hostValidationConfig({ preflightScripts: [] }), {
    retryConnectionFailure: true,
    run(command, args, options) {
      if (command === 'git') return unchangedHostTreeRun()(command, args, options);
      attempts += 1;
      now = 9001;
      throw connectionError();
    },
  }), error => error.code === 'RALPH_COMMAND_TIMEOUT' && error.cause?.message.includes('ECONNRESET'));
  assert.equal(attempts, 1);
});
