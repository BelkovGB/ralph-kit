import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  hostHomeDirectory,
  hostValidationEnvironment,
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
  assert.equal(calls.length, 2);
  if (process.platform === 'win32') assert.equal(calls[0].command, 'cmd');
  assert.equal(calls[0].options.env.DATABASE_URL, 'postgres://validation');
  assert.equal(calls[0].options.env.CI, 'true');
  assert.equal(calls[0].options.env.CODEX_HOME, undefined);
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

test('артефакты прошлых проверок удаляются перед прогоном', () => {
  const root = artifactProject({
    'apps/web/output/report/index.html': '<html></html>',
    'apps/web/output/trace.zip': 'zip',
    'apps/web/src/page.tsx': 'code',
  });

  try {
    const removed = removeValidationArtifacts(
      { validationArtifactPaths: ['apps/web/output', 'apps/web/missing'] },
      { projectRoot: root, run: () => ({ status: 0, stdout: '', stderr: '' }) },
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

  try {
    assert.throws(
      () =>
        removeValidationArtifacts(
          { validationArtifactPaths: ['docs'] },
          {
            projectRoot: root,
            run: () => ({ status: 0, stdout: 'docs/plan.md\0', stderr: '' }),
          },
        ),
      /validationArtifactPaths.*docs.*Git/su,
    );
    assert.equal(existsSync(path.join(root, 'docs', 'plan.md')), true);
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
  const order = [];

  try {
    runConfiguredValidation(
      hostValidationConfig({
        validationArtifactPaths: ['output'],
        preflightScripts: ['generate'],
        validationScripts: ['lint'],
      }),
      {
        projectRoot: root,
        run: (command, args) => {
          if (command === 'git') return { status: 0, stdout: '', stderr: '' };
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
