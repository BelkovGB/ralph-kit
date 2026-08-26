import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail } from './ralph-scope.mjs';
import { applyRuntimeSettings, defaultRuntimeSettings } from './ralph-process-runner.mjs';
import { agentClis, reasoningEffortsFor } from './ralph-agent-backends.mjs';

/**
 * Чтение `ralph.config.json`, его проверка и сбор доверенного control plane.
 *
 * `loadConfig` выполняет этапы в том же порядке, в каком они шли одной
 * процедурой: набор значений по умолчанию для контейнера и review идёт после
 * чтения snapshots, потому что на этом порядке держатся сообщения об ошибках.
 */

// Пути выводятся здесь заново, как в `ralph-process-runner.mjs`: импорт из
// оркестратора дал бы цикл.
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..', '..');
/**
 * Где лежат project-local skills. Каталог зависит от CLI: Codex читает
 * `.agents/skills`, Claude Code — `.claude/skills`, и проверяются оба, потому
 * что невалидный frontmatter не роняет сессию — агент молча теряет skill и
 * пишет `failed to load skill`, что видно только в логе.
 */
const skillsDirectories = [
  path.join(projectRoot, '.agents', 'skills'),
  path.join(projectRoot, '.claude', 'skills'),
];

export const configPath = path.join(projectRoot, '.agents', 'ralph.config.json');

const approvedIssueSnapshotsHash =
  'c0e278f489ab9e9b20c7d21232b9bb50e1e268eed0ba338966091da84777701e';

export function parseJson(value, source) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`Некорректный JSON от ${source}: ${error.message}`);
  }
}

function resolveProjectFile(file, field) {
  if (typeof file !== 'string' || file.trim() === '') {
    fail(`Поле "${field}" должно быть непустой строкой.`);
  }

  const resolved = path.resolve(projectRoot, file);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`Поле "${field}" должно указывать файл внутри проекта.`);
  }

  return resolved;
}

export function trustedFileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const ignoredAgentInstructionDirectories = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
]);

/**
 * Файлы `.claude/**`, которые ведёт сам инструмент, а не человек.
 *
 * Они не инструкция и ничьё поведение не описывают: Claude Code переписывает их
 * когда ему нужно, в том числе пока идёт прогон Ralph. В доверенном наборе они
 * означали бы остановку с «AFK-сессия изменила доверенный файл» от постороннего
 * события — обвинялась бы сессия агента, которая этот файл не открывала.
 * Список закрытый и перечисляет только машинные файлы: всё, что может нести
 * инструкцию — агенты, скиллы, настройки, хуки, — остаётся доверенным.
 */
const toolManagedClaudeFiles = new Set(['scheduled_tasks.lock']);

/**
 * Имена файлов инструкций, которые агент читает сам, где бы они ни лежали.
 * `AGENTS.md` читает Codex, `CLAUDE.md` — Claude Code, и оба управляют будущей
 * сессией одинаково, поэтому и защищены одинаково.
 */
const instructionFileNames = new Set(['AGENTS.md', 'CLAUDE.md']);

export function agentInstructionFiles(directory = projectRoot, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredAgentInstructionDirectories.has(entry.name)) {
        files.push(...agentInstructionFiles(path.join(directory, entry.name), root));
      }
      continue;
    }
    // Хеш-карта доверенных файлов структурно не видит добавленный файл, поэтому
    // набор инструкций собирается заново. `.claude/**` входит целиком: Claude
    // Code читает оттуда агентов, скиллы, настройки и хуки, то есть любой файл
    // там меняет поведение будущей сессии, а не только файл с известным именем.
    if (instructionFileNames.has(entry.name) || isClaudeInstructionDirectory(directory, root)) {
      if (!toolManagedClaudeFiles.has(entry.name)) {
        files.push(path.join(directory, entry.name));
      }
    }
  }
  return files.sort();
}

function isClaudeInstructionDirectory(directory, root) {
  const relative = path.relative(root, directory).replaceAll('\\', '/');
  return relative === '.claude' || relative.startsWith('.claude/');
}

// Codex загружает project-local skills по YAML frontmatter. Невалидный
// frontmatter не останавливает сессию: агент просто теряет skill и пишет
// `failed to load skill`, поэтому проблему нужно ловить до запуска.
export function parseSkillFrontmatter(content) {
  const errors = [];
  const fields = new Map();
  const lines = String(content ?? '')
    // BOM записан escape-последовательностью: литеральный символ невидим в
    // редакторе и в diff, и его легко потерять при правке регулярного выражения.
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);

  if (lines[0]?.trim() !== '---') {
    return { fields, errors: ['файл должен начинаться со строки `---`'] };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closingIndex === -1) {
    return { fields, errors: ['frontmatter не закрыт строкой `---`'] };
  }

  let lastKey = null;
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    // Продолжение многострочного значения YAML.
    if (lastKey && /^\s/.test(line)) continue;

    const tabSeparated = /^([A-Za-z0-9_-]+)\t/.exec(line);
    if (tabSeparated) {
      errors.push(
        `строка ${index + 1}: поле "${tabSeparated[1]}" отделено табуляцией; ` +
          'YAML требует `' +
          tabSeparated[1] +
          ': значение`',
      );
      lastKey = tabSeparated[1];
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!pair) {
      errors.push(`строка ${index + 1}: ожидалась пара \`ключ: значение\``);
      continue;
    }
    lastKey = pair[1];
    fields.set(pair[1], (pair[2] ?? '').trim());
  }

  for (const required of ['name', 'description']) {
    if (!fields.has(required)) {
      if (!errors.some((message) => message.includes(`"${required}"`))) {
        errors.push(`отсутствует обязательное поле "${required}"`);
      }
    } else if (fields.get(required) === '') {
      errors.push(`поле "${required}" пустое`);
    }
  }

  return { fields, errors };
}

export function agentSkillFiles(directories = skillsDirectories) {
  const roots = Array.isArray(directories) ? directories : [directories];

  return roots
    .filter((directory) => existsSync(directory))
    .flatMap((directory) =>
      readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(directory, entry.name, 'SKILL.md'))
        .filter((file) => existsSync(file)),
    )
    .sort();
}

export function verifyAgentSkills(dependencies = {}) {
  const files = dependencies.files ?? agentSkillFiles(dependencies.directory);
  const readFile = dependencies.readFile ?? ((file) => readFileSync(file, 'utf8'));
  const problems = [];
  for (const file of files) {
    const { errors } = parseSkillFrontmatter(readFile(file));
    if (errors.length > 0) {
      problems.push(`${path.relative(projectRoot, file)}: ${errors.join('; ')}`);
    }
  }
  if (problems.length > 0) {
    fail(
      'Невалидный frontmatter project-local skills; Codex не загрузит их:\n  ' +
        problems.join('\n  '),
    );
  }
  return files;
}

export function phasePlanId(phases) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        phases.map(({ milestone, branch, baseBranch }) => ({ milestone, branch, baseBranch })),
      ),
    )
    .digest('hex');
}

export function normalizePhases(config) {
  const source = config.phases ?? null;

  if (!Array.isArray(source) || source.length === 0) {
    fail(`Добавьте непустой массив "phases" в ${configPath}.`);
  }

  const phases = source.map((phase, index) => {
    if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
      fail(`Поле "phases[${index}]" должно быть объектом.`);
    }
    for (const field of ['milestone', 'branch']) {
      if (typeof phase[field] !== 'string' || phase[field].trim() === '') {
        fail(`Поле "phases[${index}].${field}" должно быть непустой строкой.`);
      }
    }
    const baseBranch = phase.baseBranch ?? config.baseBranch;
    if (typeof baseBranch !== 'string' || baseBranch.trim() === '') {
      fail(`Поле "phases[${index}].baseBranch" должно быть непустой строкой.`);
    }
    if (phase.branch === baseBranch) {
      fail(`В phases[${index}] рабочая ветка не должна совпадать с baseBranch.`);
    }
    return {
      milestone: phase.milestone.trim(),
      branch: phase.branch.trim(),
      baseBranch: baseBranch.trim(),
    };
  });

  for (const field of ['milestone', 'branch']) {
    const values = phases.map((phase) =>
      field === 'branch' ? phase[field].toLowerCase() : phase[field],
    );
    if (new Set(values).size !== values.length) {
      fail(`Поле "phases" не должно содержать повторяющиеся значения "${field}".`);
    }
  }

  return phases;
}

export function configForPhase(config, phaseIndex) {
  if (!Number.isInteger(phaseIndex) || phaseIndex < 0 || phaseIndex >= config.phases.length) {
    fail(`Некорректный индекс фазы ${phaseIndex}. Всего фаз: ${config.phases.length}.`);
  }
  return {
    ...config,
    ...config.phases[phaseIndex],
    phaseIndex,
    phaseCount: config.phases.length,
    phasePlanId: config.phasePlanId,
  };
}

function requirePromptTemplate(config) {
  if (typeof config.prompt !== 'string' || config.prompt.trim() === '') {
    fail(`Заполните строковое поле "prompt" в ${configPath}.`);
  }
}

function applyLoopDefaults(config) {
  config.baseBranch ??= 'main';
  config.phases = normalizePhases(config);
  config.phasePlanId = phasePlanId(config.phases);
  ({
    milestone: config.milestone,
    branch: config.branch,
    baseBranch: config.baseBranch,
  } = config.phases[0]);
  config.draftPullRequest ??= true;
  config.stopAfterFirstIssue ??= false;
  // Разработка всегда идёт на актуальной базе: перед фазой её база вливается в
  // рабочую ветку, и результат проверяется полным набором. Выключать имеет
  // смысл только там, где базу двигают намеренно и знают, что ветка обязана
  // остаться на прежней.
  config.syncBaseBranch ??= true;
  config.agentCli ??= 'codex';
  config.maxIterations ??= 20;
  config.maxTurns ??= 50;
  config.maxTestFixAttempts ??= 5;
  // Сколько раз подряд ревью может отклонить одну issue, прежде чем она уйдёт
  // из очереди прогона. Меньше, чем у тестов: провал теста называет конкретную
  // строку, а отказ ревью — суждение, и повтор суждения сходится хуже.
  config.maxReviewFixAttempts ??= 3;
  // Важность, ниже которой замечание не отклоняет работу и не заводит задачу.
  // Оно остаётся в отчёте ревью и в комментарии к PR — меняется не видимость,
  // а право останавливать цикл.
  //
  // По умолчанию порог не действует: блокирует всё, вплоть до P3. Значение P1
  // держалось один раз, на фазе 8, где цикл иначе не сходился, — и оказалось
  // непригодным как умолчание: следующая фаза молча отложила бы семь настоящих
  // замечаний. Поднимать порог имеет смысл осознанно и на время.
  config.reviewSeverityFloor ??= 'P3';
  config.runtime ??= {};
  // Значения живут в ralph-process-runner.mjs: тот же набор действует до
  // loadConfig, и раздвоение дефолтов расходилось бы молча.
  // validationTimeoutMs — бюджет docker build, validationRunTimeoutMs — бюджет
  // прогона всего набора в одном контейнере.
  for (const [field, value] of Object.entries(defaultRuntimeSettings)) {
    config.runtime[field] ??= value;
  }
  // Незнакомый ключ отклоняется, а не игнорируется: переименование
  // codexTimeoutMs в agentTimeoutMs оставило в конфиге мёртвую настройку,
  // которую можно было править без всякого эффекта.
  const unknownRuntimeFields = Object.keys(config.runtime).filter(
    (field) => !Object.hasOwn(defaultRuntimeSettings, field),
  );
  if (unknownRuntimeFields.length > 0) {
    fail(
      `Неизвестные поля в "runtime": ${unknownRuntimeFields.join(', ')}. ` +
        `Допустимы: ${Object.keys(defaultRuntimeSettings).join(', ')}.`,
    );
  }
  config.developmentModel ??= 'gpt-5.6-terra';
  config.developmentEffort ??= 'medium';
  config.rulesFile ??= '.agents/ralph-rules.md';
  config.autoApproveConfiguredIssues ??= true;
  config.trustedIssueAuthors ??= [];
  config.approvedIssueSnapshotsFile ??= 'scripts/ralph/approved-issues.json';
}

function readApprovedIssueSnapshots(config) {
  const approvedIssueSnapshotsPath = resolveProjectFile(
    config.approvedIssueSnapshotsFile,
    'approvedIssueSnapshotsFile',
  );
  if (!existsSync(approvedIssueSnapshotsPath)) {
    fail(`Файл одобренных snapshots issue не найден: ${approvedIssueSnapshotsPath}`);
  }
  if (trustedFileHash(approvedIssueSnapshotsPath) !== approvedIssueSnapshotsHash) {
    fail(
      'Файл одобренных snapshots issue не совпадает с защищённым контрольным SHA-256. ' +
        'Проверьте изменение и обновите контрольную сумму вместе с одобрением snapshots.',
    );
  }
  config.approvedIssueSnapshots = parseJson(
    readFileSync(approvedIssueSnapshotsPath, 'utf8'),
    approvedIssueSnapshotsPath,
  );
  config.approvedIssueSnapshotsPath = approvedIssueSnapshotsPath;
}

function applyValidationAndReviewDefaults(config) {
  config.validationContainer ??= {
    image: 'video-meetings-ralph-validation:latest',
    dockerfile: 'scripts/ralph/Dockerfile.validation',
  };
  config.preflightScripts ??= [];
  config.validationScripts ??= ['format:check', 'lint', 'build'];
  // Сокращение набора по области изменения. Выключается, когда набор проверок
  // не соответствует карте областей в ralph-scope.mjs и оператору нужен
  // гарантированно полный прогон на каждой issue.
  config.scopedValidation ??= true;
  // Дешёвая дорожка для правок, не тронувших ни одного токена кода: комментарии
  // и Markdown проходят format:check, lint и build без тестов и без базы.
  // Замечание уровня «переформулируй комментарий» перестаёт стоить полного
  // e2e-прогона; поведение программы такой правкой не меняется по построению.
  config.commentOnlyValidation ??= true;
  config.review ??= {
    enabled: true,
    model: 'gpt-5.6-terra',
    schemaFile: '.agents/review.schema.json',
    outputFile: '.agents/last-review.json',
  };
  config.review.model ??= 'gpt-5.6-terra';
  config.milestoneReview ??= {
    enabled: true,
    model: 'gpt-5.6-sol',
    maxTurns: config.maxTurns,
    schemaFile: '.agents/review.schema.json',
    outputFile: '.agents/last-milestone-review.json',
  };
  config.milestoneReview.maxTurns ??= config.maxTurns;
  config.milestoneReview.maxFindings ??= 10;
  // Инкрементальное milestone-ревью: со второго круга проверяются только
  // коммиты после уже отревьюенного head плюс закрытие прежних findings, а не
  // весь накопленный diff заново. Выключается для гарантированно полного
  // повторного аудита каждого круга.
  config.milestoneReview.incremental ??= true;
}

function validateLoopFields(config) {
  if (typeof config.active !== 'boolean') {
    fail('Поле "active" должно быть true или false.');
  }
  if (typeof config.draftPullRequest !== 'boolean') {
    fail('Поле "draftPullRequest" должно быть true или false.');
  }
  if (typeof config.stopAfterFirstIssue !== 'boolean') {
    fail('Поле "stopAfterFirstIssue" должно быть true или false.');
  }
  if (typeof config.syncBaseBranch !== 'boolean') {
    fail('Поле "syncBaseBranch" должно быть true или false.');
  }
  if (!agentClis.includes(config.agentCli)) {
    fail(`Поле "agentCli" должно быть одним из: ${agentClis.join(', ')}.`);
  }
  if (typeof config.autoApproveConfiguredIssues !== 'boolean') {
    fail('Поле "autoApproveConfiguredIssues" должно быть true или false.');
  }
  if (!Number.isInteger(config.maxIterations) || config.maxIterations < 1) {
    fail('Поле "maxIterations" должно быть целым числом больше 0.');
  }
  if (!Number.isInteger(config.maxTurns) || config.maxTurns < 1) {
    fail('Поле "maxTurns" должно быть целым числом больше 0.');
  }
  if (!Number.isInteger(config.maxReviewFixAttempts) || config.maxReviewFixAttempts < 1) {
    fail('Поле "maxReviewFixAttempts" должно быть целым числом больше 0.');
  }
  if (!Number.isInteger(config.maxTestFixAttempts) || config.maxTestFixAttempts < 1) {
    fail('Поле "maxTestFixAttempts" должно быть целым числом больше 0.');
  }
  if (
    !Array.isArray(config.trustedIssueAuthors) ||
    config.trustedIssueAuthors.some(
      (author) => typeof author !== 'string' || !/^[a-zA-Z0-9-]+$/.test(author),
    )
  ) {
    fail('Поле "trustedIssueAuthors" должно содержать GitHub логины доверенных авторов.');
  }
  const normalizedTrustedAuthors = config.trustedIssueAuthors.map((author) => author.toLowerCase());
  if (new Set(normalizedTrustedAuthors).size !== normalizedTrustedAuthors.length) {
    fail('Поле "trustedIssueAuthors" не должно содержать одинаковые логины с разным регистром.');
  }
  config.trustedIssueAuthors = normalizedTrustedAuthors;
}

function validateApprovedIssueSnapshots(config) {
  if (
    typeof config.approvedIssueSnapshots !== 'object' ||
    config.approvedIssueSnapshots === null ||
    Array.isArray(config.approvedIssueSnapshots)
  ) {
    fail('Поле "approvedIssueSnapshots" должно быть объектом с неизменяемыми snapshots issue.');
  }
  for (const [number, snapshot] of Object.entries(config.approvedIssueSnapshots)) {
    if (!/^[1-9][0-9]*$/.test(number)) {
      fail('Ключи "approvedIssueSnapshots" должны быть положительными номерами GitHub issue.');
    }
    if (
      typeof snapshot !== 'object' ||
      snapshot === null ||
      Array.isArray(snapshot) ||
      typeof snapshot.title !== 'string' ||
      typeof snapshot.body !== 'string'
    ) {
      fail(`Snapshot issue #${number} должен содержать строковые поля "title" и "body".`);
    }
  }
}

function prepareValidationContainer(config) {
  if (typeof config.validationContainer !== 'object' || config.validationContainer === null) {
    fail('Поле "validationContainer" должно быть объектом.');
  }
  // Набор символов ограничен не ради опечаток: на Windows commandSpec
  // запускает codex, claude, npm и npx через `cmd.exe /d /s /c <name>.cmd`,
  // то есть через настоящий shell, который заново разбирает аргументы. Тот же
  // довод действует для имён моделей ниже — они попадают в argv агента.
  for (const field of ['image', 'dockerfile']) {
    if (
      typeof config.validationContainer[field] !== 'string' ||
      config.validationContainer[field].trim() === '' ||
      !/^[a-zA-Z0-9._/:-]+$/.test(config.validationContainer[field])
    ) {
      fail(`Поле "validationContainer.${field}" должно содержать безопасное значение.`);
    }
  }
  config.validationContainer.dockerfilePath = resolveProjectFile(
    config.validationContainer.dockerfile,
    'validationContainer.dockerfile',
  );
  if (!existsSync(config.validationContainer.dockerfilePath)) {
    fail(`Dockerfile изоляции валидации не найден: ${config.validationContainer.dockerfilePath}`);
  }
}

function validateScriptNames(config) {
  if (
    !Array.isArray(config.preflightScripts) ||
    !Array.isArray(config.validationScripts) ||
    [...config.preflightScripts, ...config.validationScripts].some(
      (script) =>
        typeof script !== 'string' || script.trim() === '' || !/^[a-zA-Z0-9:_-]+$/.test(script),
    )
  ) {
    fail(
      'Поля "preflightScripts" и "validationScripts" должны быть массивами безопасных имён npm scripts.',
    );
  }
  if (!['P0', 'P1', 'P2', 'P3'].includes(config.reviewSeverityFloor)) {
    fail('Поле "reviewSeverityFloor" должно быть одним из: P0, P1, P2, P3.');
  }
  if (typeof config.scopedValidation !== 'boolean') {
    fail('Поле "scopedValidation" должно быть true или false.');
  }
  if (typeof config.commentOnlyValidation !== 'boolean') {
    fail('Поле "commentOnlyValidation" должно быть true или false.');
  }
}

function validateRuntimeSettings(config) {
  if (typeof config.runtime !== 'object' || config.runtime === null) {
    fail('Поле "runtime" должно быть объектом.');
  }
  for (const field of [
    'commandTimeoutMs',
    'validationTimeoutMs',
    'validationRunTimeoutMs',
    'agentTimeoutMs',
    'networkRetryBaseDelayMs',
  ]) {
    if (!Number.isInteger(config.runtime[field]) || config.runtime[field] < 1) {
      fail(`Поле "runtime.${field}" должно быть целым числом больше 0.`);
    }
  }
  // Пределы разные, потому что попытка стоит разного. Повтор сетевой команды —
  // это секунды ожидания, и щедрость здесь оправдана: 17 августа трёх попыток
  // с паузами 2 и 4 секунды не хватило на мигающий GitHub, и это стоило трёх
  // прогонов, каждый из которых уже сделал всю дорогую работу. Повтор ревью —
  // это целая сессия агента: минуты и сотни тысяч токенов за попытку.
  if (
    !Number.isInteger(config.runtime.networkRetryAttempts) ||
    config.runtime.networkRetryAttempts < 1 ||
    config.runtime.networkRetryAttempts > 60
  ) {
    fail('Поле "runtime.networkRetryAttempts" должно быть целым числом от 1 до 60.');
  }
  if (
    !Number.isInteger(config.runtime.reviewRetryAttempts) ||
    config.runtime.reviewRetryAttempts < 1 ||
    config.runtime.reviewRetryAttempts > 5
  ) {
    fail('Поле "runtime.reviewRetryAttempts" должно быть целым числом от 1 до 5.');
  }
  if (
    !Number.isInteger(config.runtime.maxPages) ||
    config.runtime.maxPages < 1 ||
    config.runtime.maxPages > 100
  ) {
    fail('Поле "runtime.maxPages" должно быть целым числом от 1 до 100.');
  }
}

function validateAgentRoles(config) {
  if (typeof config.review !== 'object' || config.review === null) {
    fail('Поле "review" должно быть объектом.');
  }
  if (typeof config.review.enabled !== 'boolean') {
    fail('Поле "review.enabled" должно быть true или false.');
  }
  config.review.effort ??= 'medium';
  for (const [field, value] of [
    ['developmentModel', config.developmentModel],
    ['review.model', config.review.model],
  ]) {
    if (typeof value !== 'string' || value.trim() === '' || !/^[a-zA-Z0-9._-]+$/.test(value)) {
      fail(`Поле "${field}" должно содержать безопасное имя модели.`);
    }
  }
  if (typeof config.milestoneReview !== 'object' || config.milestoneReview === null) {
    fail('Поле "milestoneReview" должно быть объектом.');
  }
  if (typeof config.milestoneReview.enabled !== 'boolean') {
    fail('Поле "milestoneReview.enabled" должно быть true или false.');
  }
  config.milestoneReview.effort ??= 'high';
  for (const [field, value] of [
    ['developmentEffort', config.developmentEffort],
    ['review.effort', config.review.effort],
    ['milestoneReview.effort', config.milestoneReview.effort],
  ]) {
    const efforts = reasoningEffortsFor(config.agentCli);
    if (typeof value !== 'string' || !efforts.includes(value)) {
      fail(
        `Поле "${field}" при agentCli=${config.agentCli} должно быть одним из: ${efforts.join(', ')}.`,
      );
    }
  }
  if (
    typeof config.milestoneReview.model !== 'string' ||
    config.milestoneReview.model.trim() === '' ||
    !/^[a-zA-Z0-9._-]+$/.test(config.milestoneReview.model)
  ) {
    fail('Поле "milestoneReview.model" должно содержать безопасное имя модели.');
  }
  if (!Number.isInteger(config.milestoneReview.maxTurns) || config.milestoneReview.maxTurns < 1) {
    fail('Поле "milestoneReview.maxTurns" должно быть целым числом больше 0.');
  }
  if (typeof config.milestoneReview.incremental !== 'boolean') {
    fail('Поле "milestoneReview.incremental" должно быть true или false.');
  }
  if (
    !Number.isInteger(config.milestoneReview.maxFindings) ||
    config.milestoneReview.maxFindings < 1 ||
    config.milestoneReview.maxFindings > 50
  ) {
    fail('Поле "milestoneReview.maxFindings" должно быть целым числом от 1 до 50.');
  }
}

function resolveControlPlanePaths(config) {
  config.rulesPath = resolveProjectFile(config.rulesFile, 'rulesFile');
  if (!existsSync(config.rulesPath)) {
    fail(`Файл правил не найден: ${config.rulesPath}`);
  }

  if (config.review.enabled) {
    config.review.schemaPath = resolveProjectFile(config.review.schemaFile, 'review.schemaFile');
    config.review.outputPath = resolveProjectFile(config.review.outputFile, 'review.outputFile');
    if (!existsSync(config.review.schemaPath)) {
      fail(`Схема review не найдена: ${config.review.schemaPath}`);
    }
    parseJson(readFileSync(config.review.schemaPath, 'utf8'), config.review.schemaPath);
  }

  if (config.milestoneReview.enabled) {
    config.milestoneReview.schemaPath = resolveProjectFile(
      config.milestoneReview.schemaFile,
      'milestoneReview.schemaFile',
    );
    config.milestoneReview.outputPath = resolveProjectFile(
      config.milestoneReview.outputFile,
      'milestoneReview.outputFile',
    );
    if (!existsSync(config.milestoneReview.schemaPath)) {
      fail(`Схема milestone review не найдена: ${config.milestoneReview.schemaPath}`);
    }
    parseJson(
      readFileSync(config.milestoneReview.schemaPath, 'utf8'),
      config.milestoneReview.schemaPath,
    );
  }
}

function collectTrustedControlFileHashes(config) {
  const trustedControlFiles = [
    configPath,
    config.rulesPath,
    config.approvedIssueSnapshotsPath,
    config.validationContainer.dockerfilePath,
    // Модули перечислены поимённо, а не сканированием каталога: сканирование
    // приняло бы в доверенный набор любой подложенный файл. Тест требует, чтобы
    // каждый .mjs из scripts/ralph был в этом списке.
    path.join(scriptDirectory, 'ralph-agent-backends.mjs'),
    path.join(scriptDirectory, 'ralph-agent-session.mjs'),
    path.join(scriptDirectory, 'ralph-claude-session.mjs'),
    path.join(scriptDirectory, 'ralph-codex-session.mjs'),
    path.join(scriptDirectory, 'ralph-command-runner.mjs'),
    path.join(scriptDirectory, 'ralph-config.mjs'),
    path.join(scriptDirectory, 'ralph-failure-summary.mjs'),
    path.join(scriptDirectory, 'ralph-git.mjs'),
    path.join(scriptDirectory, 'ralph-github-client.mjs'),
    path.join(scriptDirectory, 'ralph-issue-contract.mjs'),
    path.join(scriptDirectory, 'ralph-loop.mjs'),
    path.join(scriptDirectory, 'ralph-milestone-review.mjs'),
    path.join(scriptDirectory, 'ralph-process-runner.mjs'),
    path.join(scriptDirectory, 'ralph-prompts.mjs'),
    path.join(scriptDirectory, 'ralph-run-metrics.mjs'),
    path.join(scriptDirectory, 'ralph-runtime.mjs'),
    path.join(scriptDirectory, 'ralph-scope.mjs'),
    path.join(scriptDirectory, 'ralph-state-store.mjs'),
    path.join(scriptDirectory, 'ralph-validation-docker-shim.sh'),
    path.join(scriptDirectory, 'ralph-validation-entrypoint.sh'),
    path.join(scriptDirectory, 'ralph-validation-runner.mjs'),
    path.join(projectRoot, '.agents', 'RALPH.md'),
    ...agentInstructionFiles(),
  ];
  if (config.review.enabled) trustedControlFiles.push(config.review.schemaPath);
  if (config.milestoneReview.enabled) trustedControlFiles.push(config.milestoneReview.schemaPath);
  return new Map(
    [...new Set(trustedControlFiles)].map((file) => {
      if (!existsSync(file)) {
        fail(`Доверенный control-plane файл недоступен: ${file}`);
      }
      return [file, trustedFileHash(file)];
    }),
  );
}

export function loadConfig() {
  const config = parseJson(readFileSync(configPath, 'utf8'), configPath);

  requirePromptTemplate(config);
  applyLoopDefaults(config);
  readApprovedIssueSnapshots(config);
  applyValidationAndReviewDefaults(config);
  validateLoopFields(config);
  validateApprovedIssueSnapshots(config);
  prepareValidationContainer(config);
  validateScriptNames(config);
  validateRuntimeSettings(config);
  validateAgentRoles(config);
  resolveControlPlanePaths(config);
  Object.assign(config, controlPlaneSnapshot(config));

  applyRuntimeSettings(config.runtime);
  return config;
}

/**
 * Слепок контрольного контура на момент вызова: набор файлов инструкций и хеши
 * доверенных файлов.
 *
 * Набор сохраняется целиком, а не восстанавливается по имени файла. Пока
 * проверка выводила его фильтром `basename === 'AGENTS.md'`, правило «что
 * считается инструкцией» жило в двух местах, и расширение набора на `.claude/**`
 * рассогласовало их: файл попадал в текущий набор и не попадал в ожидаемый.
 *
 * Функция отдельная, потому что снимок берётся дважды. Смысл проверки —
 * «AFK-сессия изменила контрольный контур», значит слепок обязан описывать
 * дерево в тот момент, когда цикл закончил его готовить. Единственное, чем цикл
 * готовит дерево, — переключение на ветку фазы в `verifyRepository`, и оно
 * происходит уже после `loadConfig`. Слепок, снятый только при загрузке
 * конфигурации, описывал бы дерево до переключения: файлы, которые чекаут
 * принёс или унёс, выглядели бы правкой сессии, которая ещё не начиналась.
 */
export function controlPlaneSnapshot(config) {
  return {
    agentInstructionFiles: agentInstructionFiles(),
    trustedControlFileHashes: collectTrustedControlFileHashes(config),
  };
}

export function loadRalphRules(config) {
  const rules = readFileSync(config.rulesPath, 'utf8').trim();
  if (rules === '') {
    fail(`Файл правил пуст: ${config.rulesPath}`);
  }

  return rules;
}
