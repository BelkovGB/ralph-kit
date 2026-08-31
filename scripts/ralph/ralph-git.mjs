import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { controlPlaneExcludePathspec, fail } from './ralph-scope.mjs';
import { run, runNetwork } from './ralph-process-runner.mjs';
import { activeStateStore } from './ralph-state-store.mjs';
import { clearedFailure } from './ralph-failure-summary.mjs';

/**
 * Работа с Git-репозиторием: ветки, commit, push и восстановление после сбоя.
 */

// Пути выводятся здесь заново, как в `ralph-process-runner.mjs`.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function commitTrailerForIssue(issue) {
  return `Ralph-Issue: #${issue.number}`;
}

// Бюджет подобран по наблюдаемой цене альтернативы: без diff ревьюер Claude
// запускается с Read, Glob и Grep и без оболочки, то есть получить изменения
// сам не может вовсе и восстанавливает область правки чтением файлов целиком —
// это десятки лишних шагов на каждое ревью. Diff на 60 000 символов дешевле.
const reviewDiffCharacterBudget = 60_000;

export function verifyConfiguredGitHubOrigin(config, dependencies = {}) {
  if (config.githubAccount == null) return null;
  const execute = dependencies.run ?? run;
  const origin = execute('git', ['remote', 'get-url', 'origin']).stdout;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = null;
  }
  const validPath = /^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?\/?$/u;
  if (
    parsed === null ||
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !validPath.test(parsed.pathname)
  ) {
    fail(
      'При заданном githubAccount origin должен быть HTTPS-адресом GitHub без credentials: ' +
        'https://github.com/owner/repository.git. Текущее значение скрыто, потому что может ' +
        'содержать credentials.',
    );
  }
  const pinned = `${parsed.origin}${parsed.pathname.replace(/\/$/u, '')}`;
  config.githubRemoteUrl = pinned;
  return pinned;
}

function networkRemote(config) {
  if (config.githubAccount == null) return 'origin';
  if (typeof config.githubRemoteUrl !== 'string') {
    fail('HTTPS origin не закреплён перед сетевой командой Git. Запустите проверку репозитория.');
  }
  return config.githubRemoteUrl;
}

function fetchRemoteBranchArguments(config, branch) {
  if (config.githubAccount == null) return ['origin', branch];
  return [
    networkRemote(config),
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ];
}

/**
 * Файлы, чей построчный diff не показывают ревьюеру.
 *
 * Список задаёт проект через `reviewDiffExcludedPaths` в конфигурации:
 * сгенерированный файл вроде lock-файла меняется на сотни строк от одной
 * зависимости и вытесняет из бюджета продуктовый код. Исключённый файл остаётся
 * в списке изменений и в статистике; исчезает только его построчный diff.
 * По умолчанию список пуст.
 */
function reviewDiffExcludePathspec(excludedPaths = []) {
  return excludedPaths.map((excludedPath) => `:(exclude)${excludedPath}`);
}

/**
 * Все commit этой issue, новейший первым.
 *
 * Оркестратор требует один commit на прогон, а не на issue: после отказа ревью
 * состояние очищается, следующая итерация стартует с нового HEAD и добавляет
 * второй commit с тем же trailer. Номер issue уникален в репозитории, поэтому
 * совпадение trailer однозначно и ограничивать поиск по истории не нужно.
 */
export function issueCommits(issue, head, execute = run) {
  const found = execute(
    'git',
    ['log', '--format=%H', '--fixed-strings', '--grep', commitTrailerForIssue(issue), head],
    { allowFailure: true },
  );
  if (found.status !== 0) return [];

  return found.stdout.split(/\r?\n/).filter((line) => /^[0-9a-f]{40}$/i.test(line));
}

/**
 * Файлы, изменённые между двумя коммитами. Нужно, чтобы отличить «ветка ушла
 * вперёд по чужим файлам» от «ветка ушла вперёд по тем же, что правит агент».
 */
export function filesChangedBetween(from, to, execute = run) {
  const changed = execute('git', ['diff', '--name-only', from, to], { allowFailure: true });
  if (changed.status !== 0) return null;

  return changed.stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * Является ли commit предком другого. Нужно там, где ветка законно ушла вперёд
 * и точное совпадение HEAD спрашивать не за что.
 */
export function isAncestorCommit(ancestor, descendant, execute = run) {
  if (!ancestor || !descendant) return false;

  return (
    execute('git', ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true })
      .status === 0
  );
}

/**
 * Разбор `git status --porcelain` в записи `{index, worktree, path}`.
 *
 * Формат — `XY <путь>`, где X описывает индекс, Y рабочее дерево, а
 * переименование записано как `старый -> новый`, и нужен последний.
 *
 * Колонки разбираются, а не отбрасываются: от них зависит, надо ли путь вообще
 * стадировать. Файл, удалённый через `git rm`, стоит как `D ` — его нет ни в
 * дереве, ни в индексе, и `git add` по такому пути отвечает `did not match any
 * files` с кодом 128, обрывая прогон на уже сделанной работе.
 *
 * Отрезать ровно три символа нельзя: `run` обрезает пробелы по краям вывода, и
 * первая строка приходит без ведущего пробела статуса, поэтому такой срез съел
 * бы первый символ её пути — `src/app/...` превратился бы в `rc/app/...`.
 */
export function workingTreeEntries(status) {
  const entries = new Map();
  for (const line of String(status ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    // После двух колонок статуса porcelain всегда ставит ровно один пробел.
    // Если на третьей позиции его нет, значит обрезка съела ведущий пробел
    // первой строки и колонка индекса пуста.
    const restored = line[2] === ' ' ? line : ` ${line}`;
    const filePath = restored.slice(2).trim().split(' -> ').at(-1);
    if (filePath) {
      entries.set(filePath, { index: restored[0], worktree: restored[1], path: filePath });
    }
  }
  return [...entries.values()];
}

export function workingTreePaths(status) {
  return workingTreeEntries(status).map((entry) => entry.path);
}

/**
 * Полный набор изменений issue одним объектом: список файлов, статистика и
 * ограниченный diff.
 *
 * Показываются именно коммиты этой issue, по одному, в хронологическом
 * порядке. Диапазон `first^..last` был бы короче, но он втягивает всё, что
 * легло в ветку между ними: чужие коммиты и правки control plane, сделанные
 * оператором между прогонами, и ревьюер получает чужую работу под видом
 * реализации задачи.
 *
 * `git show` принимает список коммитов и печатает их подряд, поэтому вызовов
 * три, а не три на коммит.
 */
export function issueChangeInventory(issue, commit, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const excluded = reviewDiffExcludePathspec(dependencies.excludedPaths);
  const commits = issueCommits(issue, commit, execute);
  // issueCommits отдаёт новейший первым; ревьюеру нужен порядок появления.
  const reviewed = commits.length > 0 ? [...commits].reverse() : [commit];
  const inspect = (flags, pathspecs = []) =>
    execute('git', ['show', '--format=', ...flags, ...reviewed, ...pathspecs]).stdout;
  const patch = inspect(['--patch', '--unified=3'], ['--', '.', ...excluded]);
  const truncated = patch.length > reviewDiffCharacterBudget;

  const nameStatus = inspect(['--name-status']);

  return {
    commit,
    commits: commits.length > 0 ? commits : [commit],
    // Пути разбираются здесь, у источника: `git diff --name-status` печатает
    // статус, табуляцию и путь, а для переименования — два пути, из которых
    // нужен последний.
    paths: nameStatus
      .split(/\r?\n/)
      .map((line) => line.split('\t').at(-1)?.trim())
      .filter(Boolean),
    nameStatus,
    stat: inspect(['--stat']),
    // Обрезанный diff полезнее отсутствующего: ревьюер видит начало изменений и
    // знает, что остаток надо дочитать сам.
    diff: truncated ? patch.slice(0, reviewDiffCharacterBudget) : patch,
    truncated,
  };
}

/**
 * Изменения всей ветки против базы — то же, что видит milestone-ревью.
 *
 * Диапазон с тремя точками: сравнивать нужно с точкой расхождения, иначе в diff
 * попадёт всё, что уехало в базовую ветку после ответвления, и ревьюер получит
 * чужую работу под видом своей области.
 *
 * Control plane исключён pathspec'ом: milestone-ревью и так запрещено сообщать
 * о нём замечания, а в diff ветки он занимает бо́льшую часть бюджета символов.
 */
export function branchChangeInventory(baseRef, head, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const range = `${baseRef}...${head}`;
  const inspect = (flags) =>
    execute('git', ['diff', ...flags, range, '--', '.', ...controlPlaneExcludePathspec], {
      allowFailure: true,
    });
  const commits = execute(
    'git',
    ['log', '--format=%h %s', range, '--', '.', ...controlPlaneExcludePathspec],
    { allowFailure: true },
  );
  const patch = inspect(['--patch', '--unified=3']);
  // Отсутствие базы — не повод ронять ревью: оно идёт без инвентаря изменений.
  if (patch.status !== 0) return null;
  const truncated = patch.stdout.length > reviewDiffCharacterBudget;

  return {
    range,
    commits: commits.status === 0 ? commits.stdout : '',
    nameStatus: inspect(['--name-status']).stdout,
    stat: inspect(['--stat']).stdout,
    diff: truncated ? patch.stdout.slice(0, reviewDiffCharacterBudget) : patch.stdout,
    truncated,
  };
}

export function commitStagedChanges(commitMessage, issue, timeoutMs, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const emptyHooksDirectory = mkdtempSync(path.join(tmpdir(), 'ralph-empty-hooks-'));
  try {
    return execute(
      'git',
      [
        '-c',
        `core.hooksPath=${emptyHooksDirectory}`,
        'commit',
        '-m',
        commitMessage,
        '-m',
        commitTrailerForIssue(issue),
      ],
      { echoOutput: true, timeoutMs },
    );
  } finally {
    rmSync(emptyHooksDirectory, { recursive: true, force: true });
  }
}

// Обе ветки восстановления сверяют результат одинаково: parent, tree и trailer
// должны совпасть с тем, что Ralph собирался закоммитить. Иначе это чужой
// commit, и автоматический reset запрещён.
function validateRecoveredCommit(storedIssue, currentHead) {
  const commitCount = Number(
    run('git', ['rev-list', '--count', `${storedIssue.startingCommit}..${currentHead}`]).stdout,
  );
  const parent = run('git', ['show', '-s', '--format=%P', currentHead]).stdout;
  const tree = run('git', ['rev-parse', `${currentHead}^{tree}`]).stdout;
  const trailer = run('git', [
    'show',
    '-s',
    '--format=%(trailers:key=Ralph-Issue,valueonly)',
    currentHead,
  ]).stdout;
  if (
    commitCount !== 1 ||
    parent !== storedIssue.startingCommit ||
    !storedIssue.expectedTree ||
    tree !== storedIssue.expectedTree ||
    trailer !== `#${storedIssue.number}`
  ) {
    fail(
      `Issue #${storedIssue.number}: HEAD изменился во время staging, но новый commit не совпал ` +
        'с сохранёнными parent/tree/trailer. Автоматический reset запрещён.',
    );
  }
  return currentHead;
}

export function reconcileStateAfterCrash(config, stateStore = activeStateStore()) {
  const storedIssue = stateStore?.issue;
  if (!storedIssue || storedIssue.phase !== 'staging') return;

  const currentHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const changes = run('git', ['status', '--porcelain']).stdout;
  if (currentHead !== storedIssue.startingCommit) {
    if (changes !== '') {
      fail(
        `Issue #${storedIssue.number}: после crash найден новый commit и дополнительные изменения. ` +
          'Ralph не будет автоматически смешивать или сбрасывать их.',
      );
    }
    const commit = validateRecoveredCommit(storedIssue, currentHead);
    stateStore.updateIssue({ phase: 'committed', commit, ...clearedFailure });
    console.log(`Issue #${storedIssue.number}: распознан commit ${commit} после crash.`);
    return;
  }

  if (!storedIssue.expectedTree || !storedIssue.commitMessage) return;
  const indexTree = run('git', ['write-tree']).stdout;
  const unstaged = run('git', ['diff', '--quiet'], { allowFailure: true });
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard']).stdout;
  if (indexTree !== storedIssue.expectedTree || unstaged.status !== 0 || untracked !== '') {
    return;
  }

  commitStagedChanges(storedIssue.commitMessage, storedIssue, config.runtime.validationTimeoutMs);
  const commit = validateRecoveredCommit(storedIssue, run('git', ['rev-parse', 'HEAD']).stdout);
  stateStore.updateIssue({ phase: 'committed', commit, ...clearedFailure });
  console.log(`Issue #${storedIssue.number}: staging завершён commit ${commit} после crash.`);
}

export function verifyRepository(config, requireClean) {
  const repositoryRoot = path.resolve(run('git', ['rev-parse', '--show-toplevel']).stdout);
  if (repositoryRoot.toLowerCase() !== path.resolve(projectRoot).toLowerCase()) {
    fail(`Скрипт ожидает Git-репозиторий ${projectRoot}, но нашёл ${repositoryRoot}.`);
  }
  verifyConfiguredGitHubOrigin(config);

  run('git', ['check-ref-format', '--branch', config.branch]);
  let currentBranch = run('git', ['branch', '--show-current']).stdout;
  const changes = run('git', ['status', '--porcelain']).stdout;
  const currentHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const recoveryAllowed = activeStateStore()?.allowsDirtyRecovery(currentBranch, currentHead);
  if (requireClean && changes !== '' && !recoveryAllowed) {
    fail(
      'Рабочее дерево не чистое. Закоммитьте или уберите текущие изменения перед запуском Ralph Loop.',
    );
  }
  if (changes !== '' && recoveryAllowed) {
    console.log(
      `Найдена незавершённая работа Ralph для issue #${activeStateStore().issue.number}; ` +
        'AFK продолжит существующий diff без сброса.',
    );
  }

  if (currentBranch !== config.branch) {
    if (!requireClean) {
      fail(
        `Текущая ветка "${currentBranch}", а в конфиге указана "${config.branch}". ` +
          'Режим --check не переключает ветки.',
      );
    }

    const localBranchExists =
      run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${config.branch}`], {
        allowFailure: true,
      }).status === 0;

    if (localBranchExists) {
      run('git', ['switch', config.branch], { inherit: true });
    } else {
      const remoteBranchExists =
        runNetwork('git', [
          'ls-remote',
          '--exit-code',
          '--heads',
          networkRemote(config),
          config.branch,
        ], {
          allowedExitCodes: [2],
        }).status === 0;

      if (remoteBranchExists) {
        runNetwork('git', ['fetch', ...fetchRemoteBranchArguments(config, config.branch)], {
          echoOutput: true,
        });
        run('git', ['switch', '--track', '-c', config.branch, `origin/${config.branch}`], {
          inherit: true,
        });
      } else {
        runNetwork('git', ['fetch', ...fetchRemoteBranchArguments(config, config.baseBranch)], {
          echoOutput: true,
        });
        run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${config.baseBranch}`]);
        run('git', ['switch', '-c', config.branch, `origin/${config.baseBranch}`], {
          inherit: true,
        });
      }
    }

    currentBranch = run('git', ['branch', '--show-current']).stdout;
    if (currentBranch !== config.branch) {
      fail(`Не удалось перейти на ветку "${config.branch}".`);
    }
  }

  return { currentBranch, clean: changes === '' };
}

/**
 * Приводит ветку фазы к актуальной базе перед работой.
 *
 * Ветка фазы создаётся от базы один раз, и дальше база живёт своей жизнью:
 * родительская фаза дорабатывается по замечаниям своего ревью, база принимает
 * чужие merge. Пока ветка этого не видит, агент строит поверх устаревшего кода
 * и не знает об этом: две ветки независимо реализуют одно и то же — один и тот
 * же идентификатор, каждая по-своему, — и свести их приходится вручную.
 * `verifyBaseHistory` такое не ловит: общий предок у разошедшихся веток
 * остаётся, и проверка проходит молча.
 *
 * Возвращает true, только если слияние действительно принесло коммиты:
 * вызывающий обязан заново проверить дерево, потому что база могла разойтись с
 * работой фазы, и цена такой поломки — чужая ошибка в руках у агента, который
 * её не вносил.
 */
export function syncPhaseBranchWithBase(config, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const executeNetwork = dependencies.runNetwork ?? runNetwork;
  const contains = dependencies.isAncestorCommit ?? isAncestorCommit;

  executeNetwork('git', ['fetch', ...fetchRemoteBranchArguments(config, config.baseBranch)], {
    echoOutput: true,
  });
  const baseRef = `origin/${config.baseBranch}`;
  execute('git', ['show-ref', '--verify', '--quiet', `refs/remotes/${baseRef}`]);

  if (contains(baseRef, 'HEAD', execute)) {
    return false;
  }

  // Незавершённая работа в дереве — это восстановление после сбоя: слияние
  // поверх неё смешало бы чужие изменения с diff, который агент ещё не
  // закончил. База подождёт до следующей фазы этой же issue.
  if (execute('git', ['status', '--porcelain']).stdout !== '') {
    console.log(
      `База ${baseRef} ушла вперёд, но в дереве есть незавершённая работа: ` +
        'слияние отложено до чистого дерева.',
    );
    return false;
  }

  console.log(`\n=== Слияние базы ${baseRef} в ветку ${config.branch} ===\n`);
  const merge = execute('git', ['merge', '--no-edit', baseRef], {
    allowFailure: true,
    echoOutput: true,
  });
  if (merge.status !== 0) {
    // Конфликт разрешает человек. Автоматическое разрешение выбирало бы между
    // двумя реализациями вслепую, а именно этот выбор и есть содержание
    // конфликта.
    execute('git', ['merge', '--abort'], { allowFailure: true });
    fail(
      `Ветка ${config.branch} конфликтует с базой ${baseRef}. ` +
        'Слияние отменено, дерево не тронуто. Разрешите конфликт вручную и запустите Ralph заново.',
    );
  }

  console.log(`База ${baseRef} влита в ${config.branch}.`);
  return true;
}

export function verifyBaseHistory(config) {
  runNetwork('git', ['fetch', ...fetchRemoteBranchArguments(config, config.baseBranch)], {
    echoOutput: true,
  });
  const baseRef = `origin/${config.baseBranch}`;
  run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/${baseRef}`]);
  const mergeBase = run('git', ['merge-base', 'HEAD', baseRef], {
    allowFailure: true,
  });
  if (mergeBase.status !== 0 || mergeBase.stdout === '') {
    fail(
      `Ветка ${config.branch} не имеет общей истории с ${baseRef}. ` +
        `Исправьте baseBranch до запуска реализации или создания PR.`,
    );
  }

  return mergeBase.stdout;
}

export function commitMessageFromAgent(lastAgentMessage, issue) {
  const marker = lastAgentMessage.match(/^COMMIT_MESSAGE:\s*(.+)$/im)?.[1]?.trim();
  if (
    marker &&
    marker.length <= 120 &&
    /^(feat|fix|docs|test|refactor|perf|build|ci|chore): [^\r\n]+$/.test(marker)
  ) {
    return marker;
  }

  return `chore: complete issue #${issue.number}`;
}

export function alreadyFixedCommitFromAgent(lastAgentMessage) {
  return (
    String(lastAgentMessage ?? '')
      .trimEnd()
      .match(/(?:^|\r?\n)ALREADY_FIXED:\s*([0-9a-f]{7,40})\s*$/i)?.[1] ?? null
  );
}

export function linkedCommitForIssue(issue, execute = run) {
  const issueUpdatedAt = Date.parse(issue.updatedAt ?? '');
  if (!Number.isFinite(issueUpdatedAt)) return null;

  const candidate = execute(
    'git',
    [
      'log',
      '-1',
      '--format=%H%x09%cI',
      '--fixed-strings',
      '--grep',
      commitTrailerForIssue(issue),
      'HEAD',
    ],
    { allowFailure: true },
  );
  if (candidate.status !== 0 || candidate.stdout === '') return null;

  const [commit, committedAtText] = candidate.stdout.split('\t');
  const committedAt = Date.parse(committedAtText);
  if (!/^[0-9a-f]{40}$/i.test(commit) || !Number.isFinite(committedAt)) return null;

  // Старый trailer не должен автоматически закрывать issue, которую позднее
  // переоткрыли или дополнили новым review-контекстом.
  if (committedAt <= issueUpdatedAt) return null;

  const trailer = execute('git', [
    'show',
    '-s',
    '--format=%(trailers:key=Ralph-Issue,valueonly)',
    commit,
  ]).stdout;
  return trailer === `#${issue.number}` ? commit : null;
}

export function verifiedIssueCommit(commit, issue) {
  const resolved = run('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
    allowFailure: true,
  });
  if (resolved.status !== 0 || !/^[0-9a-f]{40}$/.test(resolved.stdout)) {
    fail(`Issue #${issue.number}: commit ${commit} не найден.`);
  }

  const ancestor = run('git', ['merge-base', '--is-ancestor', resolved.stdout, 'HEAD'], {
    allowFailure: true,
  });
  if (ancestor.status !== 0) {
    fail(`Issue #${issue.number}: commit ${resolved.stdout} не принадлежит текущей ветке.`);
  }
  return resolved.stdout;
}

export function verifyPushedHead(config, expectedHead) {
  const currentBranch = run('git', ['branch', '--show-current']).stdout;
  const localHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const changes = run('git', ['status', '--porcelain']).stdout;
  const remote = runNetwork('git', [
    'ls-remote',
    '--heads',
    networkRemote(config),
    `refs/heads/${config.branch}`,
  ]).stdout;
  const remoteHead = remote.split(/\s+/)[0] ?? '';
  if (
    currentBranch !== config.branch ||
    localHead !== expectedHead ||
    remoteHead !== expectedHead ||
    changes !== ''
  ) {
    fail(
      `Проверка pushed HEAD не прошла: branch=${currentBranch}, local=${localHead}, ` +
        `remote=${remoteHead || 'пусто'}, expected=${expectedHead}, dirty=${changes !== ''}.`,
    );
  }
  return expectedHead;
}

export function pushBranchAndVerify(config, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const executeNetwork = dependencies.runNetwork ?? runNetwork;
  const verify = dependencies.verifyPushedHead ?? verifyPushedHead;
  const localHead = execute('git', ['rev-parse', 'HEAD']).stdout;
  const pushArguments =
    config.githubAccount == null
      ? ['push', '--set-upstream', 'origin', config.branch]
      : [
          'push',
          '--no-verify',
          networkRemote(config),
          `HEAD:refs/heads/${config.branch}`,
        ];
  try {
    executeNetwork('git', pushArguments, {
      echoOutput: true,
    });
  } catch (pushError) {
    try {
      verify(config, localHead);
      console.log(
        `Push вернул ошибку, но remote уже содержит ${localHead}; продолжаем идемпотентно.`,
      );
    } catch {
      throw pushError;
    }
  }
  return verify(config, localHead);
}
