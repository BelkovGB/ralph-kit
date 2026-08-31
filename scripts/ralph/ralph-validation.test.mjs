import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './ralph-config.mjs';
import { summarizeCommandFailure } from './ralph-failure-summary.mjs';
import { run } from './ralph-process-runner.mjs';
import {
  assertValidationDependenciesCommitted,
  createTrustedValidationDependencySnapshot,
  createValidationWorkspaceSnapshot,
  ensureValidationImage,
  failedValidationScript,
  hasValidationAttestation,
  hostValidationEnvironment,
  hostWorkingTreeHash,
  readValidationAttestations,
  recordValidationAttestation,
  runConfiguredScripts,
  validationAttestationKey,
  validationContainerRunArgs,
  validationImageForSnapshot,
} from './ralph-validation-runner.mjs';
import {
  ralphConfigPath,
  trustedAgentInstructionFiles,
  trustedControlFileHashes,
  withPatchedRalphConfig,
} from './ralph-test-support.mjs';

/**
 * Есть ли файл в HEAD этого репозитория.
 *
 * Проверки, которые сравнивают снимок с закоммиченными байтами, без этого
 * условия не выполнимы: в проекте, куда набор скопировали, но ещё не
 * закоммитили, сравнивать не с чем, и тест падал бы на устройстве репозитория
 * вместо проверяемого свойства.
 */
function committedInHead(gitPath) {
  const listed = run('git', ['ls-tree', '--name-only', 'HEAD', '--', gitPath], {
    allowFailure: true,
  });
  return listed.status === 0 && listed.stdout.trim() !== '';
}

test('validation dependency image is built from committed inputs, not the mutable workspace', (t) => {
  const dependency = 'scripts/ralph/ralph-validation-entrypoint.sh';
  if (!committedInHead(dependency)) {
    t.skip(`${dependency} не закоммичен: сравнивать снимок не с чем. Закоммитьте набор.`);
    return;
  }
  const dependencyPath = new URL(`../../${dependency}`, import.meta.url);
  const originalDependency = readFileSync(dependencyPath, 'utf8');
  let snapshot;

  try {
    writeFileSync(dependencyPath, '#!/bin/sh\necho attacker-controlled\n', 'utf8');
    snapshot = createTrustedValidationDependencySnapshot({});
    const committed = run('git', ['show', `HEAD:${dependency}`]).stdout;
    assert.equal(readFileSync(path.join(snapshot, ...dependency.split('/')), 'utf8'), committed);
  } finally {
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
    writeFileSync(dependencyPath, originalDependency, 'utf8');
  }
});

test('validation image cache is invalidated when trusted dependency inputs change', () => {
  const firstSnapshot = mkdtempSync(path.join(tmpdir(), 'ralph-validation-lock-first-'));
  const secondSnapshot = mkdtempSync(path.join(tmpdir(), 'ralph-validation-lock-second-'));
  const config = { validationContainer: { image: 'ralph-validation:test' } };

  try {
    writeFileSync(path.join(firstSnapshot, 'dependencies.lock'), 'shared\n');
    writeFileSync(path.join(secondSnapshot, 'dependencies.lock'), 'shared\n');
    writeFileSync(path.join(firstSnapshot, 'manifest'), 'first\n');
    writeFileSync(path.join(secondSnapshot, 'manifest'), 'second\n');

    const firstImage = validationImageForSnapshot(config, firstSnapshot);
    const secondImage = validationImageForSnapshot(config, secondSnapshot);

    assert.match(firstImage, /^ralph-validation:test-inputs-[a-f0-9]{16}$/);
    assert.notEqual(firstImage, secondImage);
  } finally {
    rmSync(firstSnapshot, { recursive: true, force: true });
    rmSync(secondSnapshot, { recursive: true, force: true });
  }
});

test('validation image cache hit returns the existing image without rebuilding it', () => {
  const snapshot = mkdtempSync(path.join(tmpdir(), 'ralph-validation-cache-hit-'));
  const config = { validationContainer: { image: 'ralph-validation:test' } };
  const calls = [];

  try {
    writeFileSync(snapshot + path.sep + 'dependencies.lock', 'shared\n');
    const expectedImage = validationImageForSnapshot(config, snapshot);
    const image = ensureValidationImage(config, snapshot, {
      run: (command, args) => {
        calls.push([command, args]);
        assert.deepEqual(args, ['image', 'inspect', expectedImage]);
        return { status: 0, stdout: '' };
      },
    });

    assert.equal(image, expectedImage);
    assert.deepEqual(calls, [['docker', ['image', 'inspect', expectedImage]]]);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
});

/**
 * Сборка образа с подставленным `docker`: каждая запись `attempts` — исход
 * очередного вызова `docker build`.
 *
 * Снимок у каждого вызова свой: тег образа считается от его содержимого, а
 * собранные теги раннер запоминает на процесс, и общий снимок сделал бы второй
 * тест попаданием в кеш первого.
 */
function buildValidationImage(marker, attempts, dependencies = {}) {
  const snapshot = mkdtempSync(path.join(tmpdir(), 'ralph-validation-build-'));
  // Журналы принадлежат вызывающему: сборка, исчерпавшая попытки, бросает
  // исключение, и вернуть их из функции она уже не может.
  const delays = dependencies.delays ?? [];
  const builds = dependencies.builds ?? [];

  try {
    writeFileSync(path.join(snapshot, 'dependencies.lock'), `${marker}\n`);
    const image = ensureValidationImage(
      { validationContainer: { image: 'ralph-validation:test' }, ...dependencies.config },
      snapshot,
      {
        run: (command, args, options) => {
          if (args[0] === 'image') return { status: 1, stdout: '' };
          builds.push({ command, args, options });
          const outcome = attempts[builds.length - 1];
          if (outcome instanceof Error) throw outcome;
          return { status: 0, stdout: '' };
        },
        wait: (delay) => delays.push(delay),
      },
    );
    return { image, builds, delays };
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function interruptedBuild() {
  // Форма настоящего отказа: docker отдаёт ненулевой код, а причину обрыва
  // называет вывод шага установки зависимостей.
  return Object.assign(new Error('Команда docker build завершилась с кодом 1.'), {
    code: 'RALPH_COMMAND_FAILED',
    status: 1,
    stdout: '',
    stderr: 'npm error code EIDLETIMEOUT\nnpm error network Idle timeout reached',
  });
}

test('an interrupted image build is retried instead of stopping the run', () => {
  // Сборка — единственный шаг валидации с сетью, и обрыв на слое зависимостей
  // не означает, что проект сломан.
  const { builds, delays } = buildValidationImage('retry', [interruptedBuild(), null], {
    config: {
      runtime: { validationTimeoutMs: 5_000, networkRetryAttempts: 3, networkRetryBaseDelayMs: 50 },
    },
  });

  assert.equal(builds.length, 2);
  assert.deepEqual(delays, [50]);
  assert.deepEqual(builds[0].args.slice(0, 2), ['build', '--file']);
});

test('a build that fails for its own reason is not retried', () => {
  // Повтор ошибки в Dockerfile проекта только умножает ожидание: результат у
  // неё тот же самый.
  const brokenBuild = Object.assign(new Error('Команда docker build завершилась с кодом 1.'), {
    code: 'RALPH_COMMAND_FAILED',
    status: 1,
    stdout: '',
    stderr: 'ERROR: failed to solve: process "/bin/sh -c pip install ." exit code: 1',
  });
  const builds = [];

  assert.throws(
    () =>
      buildValidationImage('no-retry', [brokenBuild, brokenBuild], {
        builds,
        config: {
          runtime: {
            validationTimeoutMs: 5_000,
            networkRetryAttempts: 3,
            networkRetryBaseDelayMs: 50,
          },
        },
      }),
    /завершилась с кодом 1/u,
  );
  assert.equal(builds.length, 1);
});

test('the last interrupted build stops the run instead of retrying forever', () => {
  // Число попыток — то же, что у остальных сетевых команд: причина отказа общая,
  // и отдельное поле означало бы два места для одного решения.
  const builds = [];

  assert.throws(
    () =>
      buildValidationImage(
        'exhausted',
        [interruptedBuild(), interruptedBuild(), interruptedBuild()],
        {
          builds,
          config: {
            runtime: {
              validationTimeoutMs: 5_000,
              networkRetryAttempts: 2,
              networkRetryBaseDelayMs: 50,
            },
          },
        },
      ),
    /завершилась с кодом 1/u,
  );
  assert.equal(builds.length, 2);
});

// The Ralph suite does not pay for a full repository copy per case.
function withStubbedValidationSnapshots(body) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-validation-stub-'));
  let created = 0;
  const factory = (kind) => () => {
    created += 1;
    const snapshotPath = path.join(directory, `${kind}-${created}`);
    mkdirSync(snapshotPath, { recursive: true });
    writeFileSync(path.join(snapshotPath, 'content'), kind, 'utf8');
    return snapshotPath;
  };
  try {
    return body({
      createWorkspaceSnapshot: factory('workspace'),
      createDependencySnapshot: factory('dependencies'),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validationConfig(overrides = {}) {
  return {
    validationMode: 'container',
    validationEnvironment: [],
    preflightScripts: ['echo preflight'],
    validationScripts: ['npm run lint', 'npm run build', 'npm test'],
    runtime: { validationTimeoutMs: 5_000, validationRunTimeoutMs: 9_000 },
    trustedControlFileHashes: trustedControlFileHashes(),
    agentInstructionFiles: trustedAgentInstructionFiles(),
    validationContainer: {
      image: 'ralph-validation:single',
      dockerfilePath: fileURLToPath(new URL('./Dockerfile.validation', import.meta.url)),
    },
    ...overrides,
  };
}

function hostValidationConfig(overrides = {}) {
  return {
    validationMode: 'host',
    validationEnvironment: ['CI=true', 'DATABASE_URL=postgres://validation'],
    preflightScripts: ['pnpm db:migrate'],
    validationScripts: ['pnpm check'],
    runtime: { validationRunTimeoutMs: 9_000 },
    trustedControlFileHashes: trustedControlFileHashes(),
    agentInstructionFiles: trustedAgentInstructionFiles(),
    ...overrides,
  };
}

test('validation container mounts configured writable volumes', () => {
  const args = validationContainerRunArgs(
    {
      validationContainer: {
        image: 'ralph-validation:test',
        writableVolumes: ['/opt/pnpm-store'],
      },
    },
    ['pnpm check'],
    'C:\\Temp\\ralph-validation-snapshot',
  );
  const volumeIndex = args.indexOf('type=volume,target=/opt/pnpm-store');

  assert.notEqual(volumeIndex, -1);
  assert.equal(args[volumeIndex - 1], '--mount');
  assert.equal(args.at(-1), 'pnpm check');
});

function unchangedHostTreeRun(calls = []) {
  return (command, args, options) => {
    if (command === 'git') {
      return { status: 0, stdout: 'scripts/ralph/README.md\0', stderr: '' };
    }
    calls.push({ command, args, options });
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('host validation runs preflight and checks in the project without Docker', () => {
  const calls = [];
  const result = runConfiguredScripts(hostValidationConfig(), ['pnpm check'], 'Validation', {
    run: unchangedHostTreeRun(calls),
    environmentSource: {
      PATH: process.env.PATH,
      CODEX_HOME: 'must-not-leak',
    },
  });

  assert.equal(result.mode, 'host');
  assert.deepEqual(result.scripts, ['pnpm db:migrate', 'pnpm check']);
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.command === 'docker'), false);
  if (process.platform === 'win32') assert.equal(calls[0].command, 'cmd');
  assert.equal(calls[0].options.env.DATABASE_URL, 'postgres://validation');
  assert.equal(calls[0].options.env.CI, 'true');
  assert.equal(calls[0].options.env.CODEX_HOME, undefined);
});

test('host validation rejects a check that changes project files', () => {
  let hashes = 0;
  const execute = (command) => {
    if (command !== 'git') return { status: 0, stdout: '', stderr: '' };
    hashes += 1;
    return {
      status: 0,
      stdout: `${hashes === 1 ? 'scripts/ralph/README.md' : 'README.md'}\0`,
      stderr: '',
    };
  };

  assert.throws(
    () =>
      runConfiguredScripts(hostValidationConfig({ preflightScripts: [] }), ['pnpm check'], 'Validation', {
        run: execute,
      }),
    /изменили отслеживаемые или новые файлы проекта/u,
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
        stdout: `${gitCalls === 1 ? 'scripts/ralph/README.md' : 'README.md'}\0`,
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
      assert.equal(error.code, 'RALPH_VALIDATION_FAILED');
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
      CI: 'true',
      DATABASE_URL: 'postgres://validation',
    },
  );
});

test('a validation set runs in one container instead of one per script', () => {
  const calls = [];
  withStubbedValidationSnapshots((snapshots) =>
    runConfiguredScripts(
      validationConfig(),
      ['npm run lint', 'npm run build', 'npm test'],
      'Validation',
      {
        ...snapshots,
        run: (command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0, stdout: '' };
        },
      },
    ),
  );

  const runs = calls.filter((call) => call.args[0] === 'run');
  assert.equal(runs.length, 1, 'exactly one docker run for the whole set');
  assert.deepEqual(
    runs[0].args.slice(-4),
    ['echo preflight', 'npm run lint', 'npm run build', 'npm test'],
    'preflight precedes the validation commands inside the same container',
  );
  assert.equal(runs[0].options.timeoutMs, 9_000, 'the run budget, not the per-command budget');
  assert.equal(
    calls.filter((call) => call.args[0] === 'build').length,
    0,
    'an existing image is not rebuilt',
  );
  // Image resolution and the digest probe happen once per run, not once per
  // command: a set of four commands must not produce four image inspections.
  assert.equal(calls.filter((call) => call.args[0] === 'image').length, 2);
});

test('preflight also collapses into a single container without the validation scripts', () => {
  const calls = [];
  withStubbedValidationSnapshots((snapshots) =>
    runConfiguredScripts(validationConfig(), ['echo preflight'], 'Preflight', {
      ...snapshots,
      includePreflight: false,
      run: (command, args) => {
        calls.push(args);
        return { status: 0, stdout: '' };
      },
    }),
  );

  const runs = calls.filter((args) => args[0] === 'run');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].slice(-1), ['echo preflight']);
});

test('an empty script list still starts no container', () => {
  let started = false;
  runConfiguredScripts(validationConfig(), [], 'Validation', {
    run: () => {
      started = true;
      return { status: 0, stdout: '' };
    },
  });
  assert.equal(started, false);
});

test('the failing script is recovered from the entrypoint marker', () => {
  const output = [
    'RALPH_VALIDATION_SCRIPT=echo preflight',
    'RALPH_VALIDATION_SCRIPT=npm run lint',
    '',
    '/workspace/src/page.ts',
    "  12:3  error  'x' is not defined  no-undef",
  ].join(String.fromCharCode(10));

  assert.equal(failedValidationScript({ stdout: output, stderr: '' }), 'npm run lint');
  assert.equal(failedValidationScript({ stdout: '', stderr: '' }), null);
});

test('a failed validation set reports the failing script, not the whole list', () => {
  const output = [
    'RALPH_VALIDATION_SCRIPT=echo preflight',
    'RALPH_VALIDATION_SCRIPT=npm run lint',
    'RALPH_VALIDATION_SCRIPT=npm test',
    '  1) src/example.test.ts:42:5 > returns the stored value',
  ].join(String.fromCharCode(10));

  assert.throws(
    () =>
      withStubbedValidationSnapshots((snapshots) =>
        runConfiguredScripts(validationConfig(), ['npm run lint', 'npm test'], 'Validation', {
          ...snapshots,
          run: (command, args) => {
            if (args[0] !== 'run') return { status: 0, stdout: '' };
            throw Object.assign(new Error('Команда docker run завершилась с кодом 1.'), {
              code: 'RALPH_COMMAND_FAILED',
              status: 1,
              stdout: output,
              stderr: '',
            });
          },
        }),
      ),
    (error) => {
      assert.equal(error.code, 'RALPH_VALIDATION_FAILED');
      assert.equal(error.script, 'npm test');
      assert.equal(summarizeCommandFailure(error).command, 'npm test');
      return true;
    },
  );
});

test('a validation timeout keeps its own error code and names the whole set', () => {
  assert.throws(
    () =>
      withStubbedValidationSnapshots((snapshots) =>
        runConfiguredScripts(validationConfig(), ['npm run lint', 'npm run build'], 'Validation', {
          ...snapshots,
          run: (command, args) => {
            if (args[0] !== 'run') return { status: 0, stdout: '' };
            throw Object.assign(new Error('timeout'), { code: 'RALPH_COMMAND_TIMEOUT' });
          },
        }),
      ),
    (error) => {
      assert.equal(error.code, 'RALPH_COMMAND_TIMEOUT');
      assert.equal(error.script, 'echo preflight, npm run lint, npm run build');
      return true;
    },
  );
});

test('the validation entrypoint snapshots the workspace once and marks every command', () => {
  const entrypoint = readFileSync(
    fileURLToPath(new URL('./ralph-validation-entrypoint.sh', import.meta.url)),
    'utf8',
  );
  assert.match(entrypoint, /set -eu/);
  assert.match(entrypoint, /echo "RALPH_VALIDATION_SCRIPT=\$validation_command"/);
  assert.match(entrypoint, /cp -R \/source\/\. \/workspace\//);
  assert.match(entrypoint, /git commit --quiet --message "validation snapshot"/);
  assert.ok(
    entrypoint.indexOf('git commit') < entrypoint.indexOf('for validation_command in'),
    'снимок коммитится до первой команды набора',
  );
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
function withAttestationHarness(body) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-attestations-'));
  const attestationsPath = path.join(directory, 'validation-attestations.json');
  const sources = { workspace: 'source v1', dependencies: 'lockfile v1' };
  let created = 0;

  const snapshotFactory = (kind) => () => {
    created += 1;
    const snapshotPath = path.join(directory, `${kind}-${created}`);
    mkdirSync(snapshotPath, { recursive: true });
    writeFileSync(path.join(snapshotPath, 'content'), sources[kind], 'utf8');
    return snapshotPath;
  };

  const dockerCalls = [];
  const validate = (scripts, overrides = {}) =>
    runConfiguredScripts(
      validationConfig(overrides.config),
      scripts,
      overrides.label ?? 'Validation',
      {
        attestationsPath,
        createWorkspaceSnapshot: snapshotFactory('workspace'),
        createDependencySnapshot: snapshotFactory('dependencies'),
        run:
          overrides.run ??
          ((command, args, options) => {
            dockerCalls.push({ command, args, options });
            if (args[0] === 'image') {
              return { status: 0, stdout: overrides.digest ?? `sha256:${'a'.repeat(64)}` };
            }
            return { status: 0, stdout: '' };
          }),
        ...(overrides.includePreflight === undefined
          ? {}
          : { includePreflight: overrides.includePreflight }),
      },
    );

  const containerRuns = () => dockerCalls.filter((call) => call.args[0] === 'run').length;

  try {
    return body({ attestationsPath, sources, validate, containerRuns, dockerCalls });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('an identical source, script list, and image reuse the recorded PASS', () => {
  withAttestationHarness(({ attestationsPath, validate, containerRuns }) => {
    validate(['npm run lint', 'npm run build']);
    assert.equal(containerRuns(), 1);
    assert.equal(readValidationAttestations(attestationsPath).length, 1);

    validate(['npm run lint', 'npm run build']);
    assert.equal(
      containerRuns(),
      1,
      'the second validation of an unchanged tree must not start a container',
    );
  });
});

test('a changed source byte invalidates the attestation', () => {
  withAttestationHarness(({ sources, validate, containerRuns }) => {
    validate(['npm run lint']);
    assert.equal(containerRuns(), 1);

    sources.workspace = 'source v2';
    validate(['npm run lint']);
    assert.equal(containerRuns(), 2, 'one changed byte must force a new run');
  });
});

test('changed dependencies, scripts, or image digest invalidate the attestation', () => {
  withAttestationHarness(({ sources, validate, containerRuns }) => {
    validate(['npm run lint']);
    assert.equal(containerRuns(), 1);

    sources.dependencies = 'dependencies v2';
    validate(['npm run lint']);
    assert.equal(containerRuns(), 2, 'a dependency change must force a new run');

    validate(['npm run lint', 'npm run build']);
    assert.equal(containerRuns(), 3, 'a longer script list must force a new run');

    validate(['npm run lint'], { digest: `sha256:${'b'.repeat(64)}` });
    assert.equal(containerRuns(), 4, 'a rebuilt image under the same tag must force a new run');
  });
});

test('the preflight set and the validation set hold separate attestations', () => {
  withAttestationHarness(({ validate, containerRuns }) => {
    validate(['echo preflight'], { includePreflight: false, label: 'Preflight' });
    assert.equal(containerRuns(), 1);

    validate(['npm run lint']);
    assert.equal(containerRuns(), 2, 'preflight PASS must not satisfy the validation set');

    validate(['echo preflight'], { includePreflight: false, label: 'Preflight' });
    assert.equal(containerRuns(), 2, 'the preflight set itself is still reused');
  });
});

test('a failed validation records no attestation', () => {
  withAttestationHarness(({ attestationsPath, validate }) => {
    assert.throws(() =>
      validate(['npm run lint'], {
        run: (command, args) => {
          if (args[0] === 'image') return { status: 0, stdout: `sha256:${'c'.repeat(64)}` };
          throw Object.assign(new Error('failed'), { code: 'RALPH_COMMAND_FAILED', status: 1 });
        },
      }),
    );
    assert.deepEqual(readValidationAttestations(attestationsPath), []);
  });
});

test('an unresolvable image digest disables attestation instead of trusting a mutable tag', () => {
  withAttestationHarness(({ attestationsPath, validate, containerRuns }) => {
    validate(['npm run lint'], { digest: '' });
    validate(['npm run lint'], { digest: '' });

    assert.deepEqual(readValidationAttestations(attestationsPath), []);
    assert.equal(containerRuns(), 2, 'without a digest every validation must execute');
  });
});

test('a tampered trusted control file stops validation before it runs', () => {
  withAttestationHarness(({ validate }) => {
    const orchestratorPath = fileURLToPath(new URL('./ralph-loop.mjs', import.meta.url));
    const tamperedHashes = new Map(validationConfig().trustedControlFileHashes);
    assert.equal(tamperedHashes.has(orchestratorPath), true);
    tamperedHashes.set(orchestratorPath, 'not-the-real-hash');

    assert.throws(
      () => validate(['npm run lint'], { config: { trustedControlFileHashes: tamperedHashes } }),
      /изменила доверенный файл/,
    );
  });
});

test('a changed instruction-file set stops validation before it runs', () => {
  withAttestationHarness(({ validate }) => {
    // Пустой ожидаемый набор против непустого текущего — так выглядит файл
    // инструкций, добавленный во время сессии: хеш-карта его не видит.
    assert.throws(
      () => validate(['npm run lint'], { config: { agentInstructionFiles: [] } }),
      /изменила набор доверенных файлов инструкций/,
    );
  });
});

test('the attestation store is bounded and keeps the newest entries', () => {
  withAttestationHarness(({ attestationsPath }) => {
    for (let index = 0; index < 40; index += 1) {
      recordValidationAttestation(`key-${index}`, { label: 'Validation' }, attestationsPath);
    }
    const entries = readValidationAttestations(attestationsPath);
    assert.equal(entries.length, 32);
    assert.equal(entries[0].key, 'key-39');
    assert.equal(hasValidationAttestation('key-0', attestationsPath), false);
    assert.equal(hasValidationAttestation('key-39', attestationsPath), true);
  });
});

test('the attestation key covers every declared input', () => {
  const inputs = {
    workspaceHash: 'w',
    dependencyHash: 'd',
    imageDigest: 'i',
    scripts: ['npm run lint', 'npm run build'],
    writableVolumes: ['/opt/pnpm-store'],
  };
  const base = validationAttestationKey(inputs);

  for (const changed of [
    { ...inputs, workspaceHash: 'w2' },
    { ...inputs, dependencyHash: 'd2' },
    { ...inputs, imageDigest: 'i2' },
    { ...inputs, scripts: ['npm run build', 'npm run lint'] },
    { ...inputs, scripts: ['npm run lint'] },
    { ...inputs, writableVolumes: ['/pnpm-store'] },
  ]) {
    assert.notEqual(validationAttestationKey(changed), base);
  }
  assert.equal(validationAttestationKey({ ...inputs }), base);
});

test('a dependency changed only in the working tree stops the run before the container', () => {
  // Образ ставит зависимости по HEAD — намеренно, потому что сборка образа
  // единственный шаг с сетью. Значит зависимость, добавленную агентом в рабочее
  // дерево, контейнер физически не увидит, и проверка упадёт на «нет модуля».
  // Агент это не чинит: коммитить ему нельзя, HEAD не двигается, тег образа
  // считается по тем же HEAD-байтам, поэтому все maxTestFixAttempts уходят на
  // один и тот же отказ. Причина обязана называться до контейнера.
  const calls = [];
  const driftedRun = (name, args) => {
    calls.push([name, args[0], args[1]]);
    return {
      status: 0,
      stdout:
        'scripts/ralph/ralph-validation-entrypoint.sh\nscripts/ralph/ralph-validation-docker-shim.sh\n',
      stderr: '',
    };
  };

  assert.throws(
    () => assertValidationDependenciesCommitted(validationConfig(), { run: driftedRun }),
    (error) => {
      assert.match(error.message, /ralph-validation-entrypoint\.sh/);
      assert.match(error.message, /ralph-validation-docker-shim\.sh/);
      // Сообщение обязано назвать и причину, и выход, иначе оператор увидит
      // только «модуль не найден» пять раз подряд.
      assert.match(error.message, /HEAD/);
      assert.match(error.message, /Закоммитьте/);
      return true;
    },
  );
  assert.deepEqual(calls, [['git', 'diff', '--name-only']]);

  // Совпадающее дерево проходит молча.
  assertValidationDependenciesCommitted(validationConfig(), {
    run: () => ({ status: 0, stdout: '', stderr: '' }),
  });
});


test('снимок повторяет рабочее дерево, а не индекс: удалённый файл его не роняет', () => {
  // Отслеживаемый файл, удалённый в рабочем дереве, git ls-files по-прежнему
  // перечисляет. Дословная копия этого списка падала бы с ENOENT, и issue,
  // требующая удалить файл, была бы невыполнима в принципе.
  const victim = path.join('scripts', 'ralph', 'README.md');
  const absolute = path.join(process.cwd(), victim);
  const original = readFileSync(absolute);
  let snapshot;

  try {
    rmSync(absolute);
    snapshot = createValidationWorkspaceSnapshot();

    assert.equal(existsSync(path.join(snapshot, victim)), false);
    // Снимок собран целиком, а не оборван на удалённом файле.
    assert.equal(existsSync(path.join(snapshot, 'README.md')), true);
  } finally {
    writeFileSync(absolute, original);
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
  }
});
