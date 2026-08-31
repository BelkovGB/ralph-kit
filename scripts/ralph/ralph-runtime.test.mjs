import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireRunLock,
  initializePersistentLog,
  logDetail,
  logDetailError,
  rotatePersistentLog,
  isTransientFailure,
  readJsonFile,
  retryDelayMs,
  retryTransientOperation,
  writeJsonAtomic,
} from './ralph-runtime.mjs';
import {
  applyGitHubAccount,
  commandSpec,
  githubAccountEnvironment,
  githubGitEnvironment,
  removeTemporaryDirectory,
  resolveWindowsExecutable,
  windowsSafeCommandEnvironment,
} from './ralph-process-runner.mjs';
import { runReviewWithRetries } from './ralph-agent-session.mjs';

test('temporary cleanup retries Windows locks and never crashes the run', () => {
  let removalOptions;
  const warnings = [];
  const removed = removeTemporaryDirectory('C:\\Temp\\ralph-session', {
    rmSync: (_directory, options) => {
      removalOptions = options;
      throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    },
    warn: (message) => warnings.push(message),
  });

  assert.equal(removed, false);
  assert.equal(removalOptions.maxRetries, 5);
  assert.equal(removalOptions.retryDelay, 100);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /не удалил временный каталог/u);
});

function withTemporaryDirectory(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ralph-runtime-test-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('configured GitHub account supplies a token only to gh environment', (t) => {
  applyGitHubAccount('codex-ai-Goo');
  t.after(() => applyGitHubAccount(null));
  const calls = [];
  const source = {
    PATH: 'tools',
    GITHUB_TOKEN: 'wrong-account-token',
    GH_ENTERPRISE_TOKEN: 'enterprise-token',
  };

  const environment = githubAccountEnvironment(source, {
    readToken: (account) => {
      calls.push(account);
      return 'selected-account-token';
    },
  });
  const cached = githubAccountEnvironment(source, {
    readToken: () => assert.fail('токен выбранного аккаунта должен кэшироваться'),
  });

  assert.deepEqual(calls, ['codex-ai-Goo']);
  assert.equal(environment.GH_TOKEN, 'selected-account-token');
  assert.equal(environment.GH_HOST, 'github.com');
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(environment.PATH, source.PATH);
  assert.equal(cached.GH_TOKEN, 'selected-account-token');
  assert.equal(source.GITHUB_TOKEN, 'wrong-account-token');
});

test('missing GitHub account keeps the caller environment unchanged', (t) => {
  applyGitHubAccount(null);
  t.after(() => applyGitHubAccount(null));
  const source = { GH_TOKEN: 'active-account-token' };

  assert.equal(githubAccountEnvironment(source), source);
});

test('configured GitHub account authenticates git without putting token in argv', (t) => {
  applyGitHubAccount('codex-ai-Goo');
  t.after(() => applyGitHubAccount(null));
  const source = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.autocrlf',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_TRACE_CURL: '1',
    Git_Trace_Redact: '0',
  };

  const environment = githubGitEnvironment(source, {
    readToken: () => 'selected-account-token',
  });
  const encoded = environment.GIT_CONFIG_VALUE_1.replace('AUTHORIZATION: basic ', '');

  assert.equal(environment.GIT_CONFIG_COUNT, '3');
  assert.equal(environment.GIT_CONFIG_KEY_0, source.GIT_CONFIG_KEY_0);
  assert.equal(environment.GIT_CONFIG_KEY_1, 'http.https://github.com/.extraheader');
  assert.equal(environment.GIT_CONFIG_KEY_2, 'core.hooksPath');
  assert.deepEqual(readdirSync(environment.GIT_CONFIG_VALUE_2), []);
  assert.equal(environment.GIT_TRACE_CURL, undefined);
  assert.equal(environment.Git_Trace_Redact, undefined);
  assert.equal(
    Buffer.from(encoded, 'base64').toString('utf8'),
    'x-access-token:selected-account-token',
  );
  assert.equal(source.GIT_CONFIG_COUNT, '1');
  assert.equal(source.GIT_TRACE_CURL, '1');
  assert.equal(source.Git_Trace_Redact, '0');
});

test('retryTransientOperation повторяет временные ошибки и возвращает результат', () => {
  const attempts = [];
  const delays = [];
  const retries = [];

  const result = retryTransientOperation(
    (attempt) => {
      attempts.push(attempt);
      if (attempt === 1) {
        const error = new Error('connection reset by peer');
        error.code = 'ECONNRESET';
        throw error;
      }
      if (attempt === 2) throw new Error('GitHub returned HTTP 503');
      return 'ready';
    },
    {
      attempts: 4,
      baseDelayMs: 10,
      wait: (delay) => delays.push(delay),
      onRetry: (_error, attempt, delay) => retries.push({ attempt, delay }),
    },
  );

  assert.equal(result, 'ready');
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(retries, [
    { attempt: 1, delay: 10 },
    { attempt: 2, delay: 20 },
  ]);
  assert.equal(isTransientFailure({ code: 'RALPH_COMMAND_TIMEOUT' }), true);
  assert.equal(
    isTransientFailure({ stderr: 'Patch "https://api.github.com/issues/65": EOF' }),
    true,
  );
});

test('retryTransientOperation останавливается после исчерпания попыток', () => {
  const expected = new Error('secondary rate limit (429)');
  let operationCalls = 0;
  const delays = [];

  assert.throws(
    () =>
      retryTransientOperation(
        () => {
          operationCalls += 1;
          throw expected;
        },
        {
          attempts: 3,
          baseDelayMs: 5,
          wait: (delay) => delays.push(delay),
        },
      ),
    (error) => error === expected,
  );

  assert.equal(operationCalls, 3);
  assert.deepEqual(delays, [5, 10]);
});

test('retryTransientOperation не повторяет постоянную ошибку', () => {
  const expected = new Error('validation failed');
  let operationCalls = 0;
  let waitCalls = 0;

  assert.throws(
    () =>
      retryTransientOperation(
        () => {
          operationCalls += 1;
          throw expected;
        },
        {
          attempts: 5,
          wait: () => {
            waitCalls += 1;
          },
        },
      ),
    (error) => error === expected,
  );

  assert.equal(operationCalls, 1);
  assert.equal(waitCalls, 0);
  assert.equal(isTransientFailure(expected), false);
});

test('acquireRunLock не перехватывает lock живого процесса', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'run.lock');
    const existing = {
      pid: 1234,
      token: 'live-owner',
      startedAt: '2026-08-14T00:00:00.000Z',
    };
    writeFileSync(lockPath, `${JSON.stringify(existing)}\n`, 'utf8');

    assert.throws(
      () =>
        acquireRunLock(lockPath, {}, { isProcessAlive: () => true, pid: 5678, token: 'new-owner' }),
      /Ralph Loop уже запущен \(PID 1234/,
    );
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), existing);
  });
});

test('acquireRunLock заменяет lock завершившегося процесса', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'run.lock');
    writeFileSync(lockPath, `${JSON.stringify({ pid: 1234, token: 'stale-owner' })}\n`, 'utf8');

    const release = acquireRunLock(
      lockPath,
      { mode: '--run' },
      { isProcessAlive: () => false, pid: 5678, token: 'new-owner' },
    );
    const current = JSON.parse(readFileSync(lockPath, 'utf8'));

    assert.equal(current.pid, 5678);
    assert.equal(current.token, 'new-owner');
    assert.equal(current.mode, '--run');
    assert.match(current.startedAt, /^\d{4}-\d{2}-\d{2}T/);

    release();
    assert.equal(existsSync(lockPath), false);
    release();
  });
});

test('release lock не удаляет lock с токеном нового владельца', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'run.lock');
    const release = acquireRunLock(
      lockPath,
      {},
      { isProcessAlive: () => false, pid: 1234, token: 'original-owner' },
    );
    const replacement = { pid: 5678, token: 'replacement-owner' };
    writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`, 'utf8');

    release();

    assert.equal(existsSync(lockPath), true);
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), replacement);
  });
});

test('acquireRunLock отклоняет повреждённый lock', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'run.lock');
    writeFileSync(lockPath, 'not-json\n', 'utf8');

    assert.throws(
      () => acquireRunLock(lockPath, {}, { isProcessAlive: () => false, token: 'new-owner' }),
      /Lock Ralph повреждён или ещё создаётся/,
    );
    assert.equal(readFileSync(lockPath, 'utf8'), 'not-json\n');
  });
});

test('writeJsonAtomic создаёт и атомарно обновляет JSON', () => {
  withTemporaryDirectory((directory) => {
    const filePath = path.join(directory, 'state', 'state.json');
    const fallback = { missing: true };

    assert.equal(readJsonFile(filePath, fallback), fallback);

    writeJsonAtomic(filePath, { count: 1, phase: 'started' });
    assert.deepEqual(readJsonFile(filePath), { count: 1, phase: 'started' });
    assert.match(readFileSync(filePath, 'utf8'), /\n$/);

    writeJsonAtomic(filePath, { count: 2, phase: 'complete' });
    assert.deepEqual(readJsonFile(filePath), { count: 2, phase: 'complete' });
    assert.deepEqual(readdirSync(path.dirname(filePath)), ['state.json']);
  });
});

test('initializePersistentLog отделяет журнал прогона и восстанавливает console', () => {
  withTemporaryDirectory((directory) => {
    const logPath = path.join(directory, 'run.log');
    const originalLog = console.log;
    const originalError = console.error;
    writeFileSync(logPath, 'previous run\n', 'utf8');

    let restore;
    try {
      restore = initializePersistentLog(logPath, { mode: '--run' });
      assert.notEqual(console.log, originalLog);
      assert.notEqual(console.error, originalError);
      console.log('iteration %d', 2);
      console.error('failure: %s', 'temporary');
    } finally {
      restore?.();
    }

    assert.equal(console.log, originalLog);
    assert.equal(console.error, originalError);

    const log = readFileSync(logPath, 'utf8');
    // Журнал прошлого прогона уезжает в архив, а не дописывается: иначе файл
    // растёт неограниченно и после падения его нечем открыть.
    assert.doesNotMatch(log, /previous run/);
    assert.match(log, /^\S+ INFO Ralph process started .*"mode":"--run"/);
    assert.match(log, /INFO iteration 2/);
    assert.match(log, /ERROR failure: temporary/);

    const archived = readdirSync(directory).filter((name) => /^run-.*\.log$/.test(name));
    assert.equal(archived.length, 1);
    assert.equal(readFileSync(path.join(directory, archived[0]), 'utf8'), 'previous run\n');
  });
});

test('every run starts a fresh run.log and keeps a bounded history', () => {
  withTemporaryDirectory((directory) => {
    const logPath = path.join(directory, 'run.log');

    // Восемь прогонов подряд: run.log должен содержать только последний, а
    // прошлые — лежать рядом в ограниченном количестве.
    for (let run = 1; run <= 8; run += 1) {
      const restore = initializePersistentLog(logPath, { mode: '--run', run });
      console.log(`marker for run ${run}`);
      restore();
    }

    const current = readFileSync(logPath, 'utf8');
    assert.match(current, /marker for run 8/);
    assert.doesNotMatch(current, /marker for run 7/);

    const archived = readdirSync(directory)
      .filter((name) => name.startsWith('run-') && name.endsWith('.log'))
      .sort();
    assert.equal(archived.length, 5);
    // Сохраняются именно последние: прогон 2 уже вытеснен, прогон 7 ещё здесь.
    const kept = archived.map((name) => readFileSync(path.join(directory, name), 'utf8')).join('');
    assert.match(kept, /marker for run 7/);
    assert.doesNotMatch(kept, /marker for run 2/);
  });
});

test('retention keeps the newest runs even when every rotation shares one timestamp', () => {
  withTemporaryDirectory((directory) => {
    const logPath = path.join(directory, 'run.log');
    // Метка задаётся явно, а не берётся с часов: восемь ротаций укладываются в
    // одну миллисекунду на tmpfs контейнера и не укладываются на диске Windows,
    // поэтому только явная метка воспроизводит этот случай на любой машине.
    const stamp = '2026-08-16T17:41:21.721Z';

    for (let run = 1; run <= 8; run += 1) {
      writeFileSync(logPath, `marker for run ${run}\n`, 'utf8');
      rotatePersistentLog(logPath, stamp);
    }

    const archived = readdirSync(directory)
      .filter((name) => /^run-.*\.log$/.test(name))
      .sort();
    assert.equal(archived.length, 5);
    // Порядок задаёт порядковый номер в имени: со случайным суффиксом
    // сортировка удаляла бы произвольные архивы, а не самые старые.
    assert.deepEqual(
      archived.map((name) => readFileSync(path.join(directory, name), 'utf8').trim()),
      [4, 5, 6, 7, 8].map((run) => `marker for run ${run}`),
    );
  });
});

test('two rotations within the same millisecond keep both archives', () => {
  withTemporaryDirectory((directory) => {
    const logPath = path.join(directory, 'run.log');
    // Метка времени одна и та же для обеих ротаций: на tmpfs контейнера восемь
    // ротаций укладываются в одну миллисекунду. Имя архива уникально по
    // построению: иначе вторая ротация переименовала бы файл поверх первого
    // архива и уничтожила его.
    const stamp = '2026-08-16T13:45:51.316Z';

    writeFileSync(logPath, 'first run\n', 'utf8');
    rotatePersistentLog(logPath, stamp);
    writeFileSync(logPath, 'second run\n', 'utf8');
    rotatePersistentLog(logPath, stamp);

    const archived = readdirSync(directory)
      .filter((name) => /^run-.*\.log$/.test(name))
      .sort();
    assert.equal(archived.length, 2);
    assert.deepEqual(
      archived.map((name) => readFileSync(path.join(directory, name), 'utf8')).sort(),
      ['first run\n', 'second run\n'],
    );
  });
});

// Порядок PATHEXT задаётся явно: на Linux сравнение имён регистрозависимо, и
// без фиксированного регистра тест проверял бы разные вещи на разных системах.
const windowsPathExtensions = '.COM;.EXE;.BAT;.CMD';

test('a windows command resolves by PATH order first and extension order second', () => {
  withTemporaryDirectory((root) => {
    const native = path.join(root, 'native');
    const npm = path.join(root, 'npm');
    for (const directory of [native, npm]) {
      mkdirSync(directory, { recursive: true });
    }

    writeFileSync(path.join(native, 'claude.EXE'), '', 'utf8');
    writeFileSync(path.join(npm, 'claude.CMD'), '', 'utf8');

    const resolve = (directories) =>
      resolveWindowsExecutable('claude', {
        PATH: directories.join(path.delimiter),
        PATHEXT: windowsPathExtensions,
      });

    // Ровно этот случай ронял бы каждую Claude-сессию: рабочий claude.exe лежит
    // раньше в PATH, а подстановка сломанного npm-шима claude.cmd убивает запуск.
    assert.equal(resolve([native, npm]), path.join(native, 'claude.EXE'));
    // Каталог сильнее расширения: шим побеждает, если стоит раньше.
    assert.equal(resolve([npm, native]), path.join(npm, 'claude.CMD'));
    // Установка только через npm остаётся рабочей.
    assert.equal(resolve([npm]), path.join(npm, 'claude.CMD'));
    assert.equal(resolve([path.join(root, 'empty')]), null);

    // Элемент PATH в кавычках законен, и Windows кавычки снимает. Без этого
    // установленный CLI выглядит как отсутствующий, а отсутствие команды
    // здесь — жёсткая ошибка запуска.
    assert.equal(
      resolveWindowsExecutable('claude', {
        PATH: `"${native}"`,
        PATHEXT: windowsPathExtensions,
      }),
      path.join(native, 'claude.EXE'),
    );
  });
});

test('a batch shim is protected from a same-named file in the working directory', () => {
  // cmd.exe ищет команду в текущем каталоге раньше PATH, а текущий каталог
  // сессии — корень репозитория, куда агент пишет с полным доступом. Передать
  // вместо имени абсолютный путь нельзя: `cmd /d /s /c "C:\dir with space\x.cmd"`
  // разбирается по пробелу. Значит, единственная защита — эта переменная.
  assert.deepEqual(
    windowsSafeCommandEnvironment,
    process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {},
  );
});

test('a review is not retried when the failure cannot change between attempts', async () => {
  const config = { runtime: { reviewRetryAttempts: 3, networkRetryBaseDelayMs: 1 } };

  for (const code of [
    'RALPH_AGENT_AUTH',
    'RALPH_AGENT_TIMEOUT',
    'RALPH_MAX_TURNS',
    'RALPH_COMMAND_NOT_FOUND',
  ]) {
    let calls = 0;
    await assert.rejects(
      runReviewWithRetries(
        config,
        () => {
          calls += 1;
          const error = new Error(code);
          error.code = code;
          throw error;
        },
        'review',
      ),
      (error) => error.code === code,
    );
    // Ни prompt, ни состояние репозитория между попытками не меняются, поэтому
    // повтор воспроизводит тот же отказ. Дороже всех RALPH_AGENT_TIMEOUT: три
    // попытки по agentTimeoutMs — это 4,5 часа до первого сообщения оператору.
    assert.equal(calls, 1, code);
  }

  // Технический сбой запуска повторяется.
  let attempts = 0;
  const result = await runReviewWithRetries(
    config,
    () => {
      attempts += 1;
      if (attempts < 3) throw new Error('spawn EAGAIN');
      return 'ok';
    },
    'review',
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test(
  'commandSpec spawns a native executable directly and keeps cmd.exe for batch shims',
  // Ветка целиком windows-only: в Linux-контейнере валидации проверять нечего.
  { skip: process.platform !== 'win32' ? 'windows-only' : false },
  () => {
    withTemporaryDirectory((root) => {
      const native = path.join(root, 'native');
      const npm = path.join(root, 'npm');
      for (const directory of [native, npm]) {
        mkdirSync(directory, { recursive: true });
      }
      writeFileSync(path.join(native, 'claude.exe'), '', 'utf8');
      writeFileSync(path.join(npm, 'claude.cmd'), '', 'utf8');
      const originalPath = process.env.PATH;
      // Регистр берётся из PATHEXT машины, а сравнение имён на Windows от
      // регистра не зависит: сравниваем так же.
      const same = (actual, expected) => assert.equal(actual.toLowerCase(), expected.toLowerCase());

      try {
        process.env.PATH = [native, npm].join(path.delimiter);
        const direct = commandSpec('claude', ['-p']);
        same(direct.command, path.join(native, 'claude.exe'));
        // Без cmd.exe исчезает и обрезка командной строки на переводе строки.
        assert.deepEqual(direct.commandArgs, ['-p']);

        process.env.PATH = npm;
        const shim = commandSpec('claude', ['-p']);
        assert.match(shim.command, /cmd\.exe$/i);
        assert.deepEqual(shim.commandArgs.slice(0, 3), ['/d', '/s', '/c']);
        same(shim.commandArgs[3], 'claude.cmd');
        assert.deepEqual(shim.commandArgs.slice(4), ['-p']);

        // Отсутствие обеих установок обязано быть громкой ошибкой, а не
        // командой, которая не запустится.
        process.env.PATH = path.join(root, 'empty');
        assert.throws(
          () => commandSpec('claude', ['-p']),
          (error) => {
            assert.equal(error.code, 'RALPH_COMMAND_NOT_FOUND');
            return true;
          },
        );
      } finally {
        process.env.PATH = originalPath;
      }
    });
  },
);

test('подробности идут в журнал, а объёмный повтор — ссылкой', () => {
  withTemporaryDirectory((directory) => {
    const logPath = path.join(directory, 'run.log');
    const printed = [];
    // Вывод контейнера длиннее порога: именно такие куски и повторяются.
    const containerOutput = `RALPH_VALIDATION_SCRIPT=lint\n${'x'.repeat(600)}`;

    let restore;
    try {
      restore = initializePersistentLog(logPath, { mode: '--run' });
      // Перехват ставится поверх журнального: если подробности всё же уйдут в
      // консоль, они окажутся здесь.
      console.log = (...args) => printed.push(args.join(' '));
      console.error = (...args) => printed.push(args.join(' '));
      logDetail(containerOutput);
      logDetail(containerOutput);
      logDetailError('короткая строка ошибки');
    } finally {
      restore?.();
    }

    const log = readFileSync(logPath, 'utf8');
    // Консоль не получила ничего: за ходом прогона в ней видно шаги, а не
    // десятки тысяч строк вывода контейнера.
    assert.deepEqual(printed, []);
    assert.match(log, /RALPH_VALIDATION_SCRIPT=lint/);
    assert.match(log, /ERROR короткая строка ошибки/);

    const digest = log.match(/<сообщение ([0-9a-f]{12})>/)?.[1];
    assert.ok(digest, 'первое появление обязано получить метку');
    // Второй раз тот же текст занимает строку вместо шестисот символов, но
    // остаётся в хронологии и находится поиском по той же метке.
    assert.equal(log.match(/x{600}/g)?.length, 1);
    assert.match(log, new RegExp(`<повтор сообщения ${digest} от `));
  });
});

test('вне прогона подробности всё же попадают в консоль', () => {
  // `--check` и тесты работают без журнала: единственный доступный вывод —
  // консоль, и молчание там означало бы потерю сообщения.
  const printed = [];
  const original = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  try {
    logDetail('вывод без журнала');
  } finally {
    console.log = original;
  }

  assert.deepEqual(printed, ['вывод без журнала']);
});

test('пауза между повторами удваивается и упирается в тридцать секунд', () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((attempt) => retryDelayMs(2_000, attempt)),
    [2_000, 4_000, 8_000, 16_000],
  );
  assert.equal(retryDelayMs(2_000, 10), 30_000);
  // Базовая задержка в тридцать секунд упирается в потолок сразу, поэтому все
  // паузы становятся одинаковыми: удвоение перестаёт работать.
  assert.equal(retryDelayMs(30_000, 1), 30_000);
  assert.equal(retryDelayMs(30_000, 5), 30_000);
});
