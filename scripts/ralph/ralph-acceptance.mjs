/**
 * Хранение кейсов и прогонов приёмки: разбор трёх форматов Markdown, сводка по
 * кейсам и расчёт задетых модулей по diff. Форматы задаёт набор, поэтому разбор
 * строгий: пропущенный кейс в сводке выглядит как «не гонялся», и это ложь.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { run } from './ralph-process-runner.mjs';

export const acceptanceStatuses = ['PASS', 'FAIL', 'BLOCKED', 'SKIPPED'];

const moduleNamePattern = /^[a-z0-9-]+$/u;
// ID делится по последнему дефису: имя модуля само может содержать дефис.
const caseIdPattern = /^([A-Z0-9-]+)-(\d{3,})$/u;
const caseHeadingPattern = /^## ([A-Z0-9-]+-\d{3,})\. (.+)$/u;

export function acceptanceError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

export function caseIdPrefix(id) {
  return caseIdPattern.exec(id)?.[1] ?? null;
}

function tableCells(line) {
  return line
    .slice(1, line.endsWith('|') ? -1 : undefined)
    .split('|')
    .map((cell) => cell.trim());
}

function isSeparatorRow(line) {
  return /^\|\s*:?-+/u.test(line);
}

// Строки таблицы, начиная с указанной: шапка и разделитель пропускаются,
// разбор останавливается на первой строке, которая не начинается с `|`.
function tableRows(lines, startIndex) {
  const rows = [];
  let index = startIndex;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (!lines[index]?.startsWith('|')) return { rows, next: index };
  index += 1; // шапка
  if (isSeparatorRow(lines[index] ?? '')) index += 1;
  while (index < lines.length && lines[index].startsWith('|')) {
    rows.push({ cells: tableCells(lines[index]), line: index + 1 });
    index += 1;
  }
  return { rows, next: index };
}

export function parseModules(text, file) {
  const lines = text.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => line.startsWith('|'));
  if (headerIndex === -1) throw acceptanceError(`${file}: нет таблицы модулей.`);
  const { rows } = tableRows(lines, headerIndex);
  const modules = rows.map(({ cells, line }) => {
    const [name = '', casesFile = '', pathList = ''] = cells;
    if (!moduleNamePattern.test(name)) {
      throw acceptanceError(
        `${file}:${line}: имя модуля «${name}» не по формату: латиница в нижнем регистре, цифры и дефис.`,
      );
    }
    if (casesFile === '') throw acceptanceError(`${file}:${line}: у модуля «${name}» не назван файл кейсов.`);
    const paths = pathList
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return { name, casesFile, paths, line };
  });
  const seen = new Set();
  for (const module of modules) {
    if (seen.has(module.name)) throw acceptanceError(`${file}:${module.line}: модуль «${module.name}» назван дважды.`);
    seen.add(module.name);
  }
  return modules;
}

export function parseCases(text, file, moduleName) {
  const expectedPrefix = moduleName.toUpperCase();
  const lines = text.split(/\r?\n/u);
  const cases = [];
  lines.forEach((line, index) => {
    if (line.startsWith('## ')) {
      const match = caseHeadingPattern.exec(line);
      if (!match) {
        throw acceptanceError(
          `${file}:${index + 1}: заголовок кейса не по формату «## <ID>. <название>»: ${line}`,
        );
      }
      const [, id, title] = match;
      if (caseIdPrefix(id) !== expectedPrefix) {
        throw acceptanceError(
          `${file}:${index + 1}: кейс ${id} не принадлежит модулю «${moduleName}»: ожидался префикс ${expectedPrefix}.`,
        );
      }
      cases.push({ id, title: title.trim(), retired: false, line: index + 1 });
      return;
    }
    if (line.startsWith('**Снят**') && cases.length > 0) cases.at(-1).retired = true;
  });
  const seen = new Set();
  for (const item of cases) {
    if (seen.has(item.id)) throw acceptanceError(`${file}:${item.line}: кейс ${item.id} встречается дважды.`);
    seen.add(item.id);
  }
  return cases;
}

export function parseRun(text, file) {
  const lines = text.split(/\r?\n/u);
  const heading = lines.findIndex((line) => /^## Результаты\s*$/u.test(line));
  if (heading === -1) throw acceptanceError(`${file}: нет раздела «## Результаты».`);
  const { rows } = tableRows(lines, heading + 1);
  if (rows.length === 0) throw acceptanceError(`${file}: таблица результатов пуста.`);
  const results = rows.map(({ cells, line }) => {
    const [id = '', status = '', comment = ''] = cells;
    if (!caseIdPattern.test(id)) throw acceptanceError(`${file}:${line}: «${id}» не похоже на ID кейса.`);
    if (!acceptanceStatuses.includes(status)) {
      throw acceptanceError(
        `${file}:${line}: статус «${status}» у ${id} не из списка ${acceptanceStatuses.join(', ')}.`,
      );
    }
    return { id, status, comment, line };
  });
  // Повтор ID в одной таблице результатов даёт кейсу две записи в истории за
  // один прогон, и «последние пять прогонов» перестают быть пятью прогонами.
  const seen = new Set();
  for (const result of results) {
    if (seen.has(result.id)) {
      throw acceptanceError(`${file}:${result.line}: кейс ${result.id} встречается в прогоне дважды.`);
    }
    seen.add(result.id);
  }
  return results;
}

export const historyLimit = 5;
const statusLetter = { PASS: 'P', FAIL: 'F', BLOCKED: 'B', SKIPPED: 'S' };

const diskFiles = {
  exists: (file) => existsSync(file),
  readFile: (file) => readFileSync(file, 'utf8'),
  readDirectory: (directory) => (existsSync(directory) ? readdirSync(directory) : []),
};

function joinPath(...parts) {
  return parts.join('/');
}

// Второй прогон с тем же именем в тот же день получает суффикс `-2`, третий —
// `-3` и так далее (конвенция набора). Простой `.sort()` по строке ставит
// суффикс раньше расширения: «-» (0x2D) меньше «.» (0x2E) в ASCII, поэтому
// «…-cart-2.md» встаёт перед «…-cart.md», а история кейса — задом наперёд.
// Сортируем по основе имени без расширения и без хвоста повтора, а сам номер
// повтора сравниваем как число, а не как строку — иначе «-10» встанет перед
// «-2».
const repeatSuffixPattern = /^(.*)-(\d+)$/u;

function runSortKey(name) {
  const stem = name.slice(0, -'.md'.length);
  const match = repeatSuffixPattern.exec(stem);
  return match ? { base: match[1], repeat: Number(match[2]) } : { base: stem, repeat: 1 };
}

function compareRunNames(a, b) {
  const left = runSortKey(a);
  const right = runSortKey(b);
  if (left.base !== right.base) return left.base < right.base ? -1 : 1;
  return left.repeat - right.repeat;
}

export function readAcceptance(directory, files = diskFiles) {
  const modulesFile = joinPath(directory, 'modules.md');
  if (!files.exists(modulesFile)) {
    throw acceptanceError(`Нет реестра модулей: ожидался ${modulesFile}. Его ведёт проект, формат — в scripts/ralph/README.md.`);
  }
  const modules = parseModules(files.readFile(modulesFile), modulesFile).map((module) => {
    const casesFile = joinPath(directory, module.casesFile);
    // Модуль без файла кейсов — нормальное состояние до первой приёмки: он уже
    // в реестре, чтобы impact знал его пути.
    const cases = files.exists(casesFile) ? parseCases(files.readFile(casesFile), casesFile, module.name) : [];
    return { ...module, cases };
  });
  const runsDirectory = joinPath(directory, 'runs');
  const runs = files
    .readDirectory(runsDirectory)
    .filter((name) => name.endsWith('.md'))
    .sort(compareRunNames)
    .map((name) => ({ name, results: parseRun(files.readFile(joinPath(runsDirectory, name)), joinPath('runs', name)) }));
  return { directory, modules, runs };
}

export function buildStatus(acceptance) {
  const known = new Map();
  for (const module of acceptance.modules) {
    for (const item of module.cases) known.set(item.id, { ...item, module: module.name, history: [] });
  }
  const warnings = [];
  for (const run of acceptance.runs) {
    for (const result of run.results) {
      const item = known.get(result.id);
      if (!item) {
        warnings.push(`runs/${run.name}: кейс ${result.id} не найден ни в одном файле кейсов — его удалили вместо пометки «снят»?`);
        continue;
      }
      item.history.push({ run: `runs/${run.name}`, status: result.status });
    }
  }
  const counts = { total: 0, PASS: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0, never: 0 };
  const modules = acceptance.modules.map((module) => ({
    name: module.name,
    casesFile: module.casesFile,
    rows: module.cases
      .filter((item) => !item.retired)
      .map((item) => {
        const history = known.get(item.id).history;
        const last = history.at(-1) ?? null;
        counts.total += 1;
        if (last) counts[last.status] += 1;
        else counts.never += 1;
        return {
          id: item.id,
          title: item.title,
          status: last?.status ?? null,
          run: last?.run ?? null,
          history: history.slice(-historyLimit).map((entry) => statusLetter[entry.status]),
        };
      }),
  }));
  return { counts, modules, warnings };
}

// Диалект глоба набора: `**/` — ноль и более каталогов, `**` — любая глубина
// (в том числе внутри сегмента), одиночная `*` не перескакивает через `/`.
// Остальные символы экранируются, иначе путь со скобками или точкой в имени
// модуля даёт неверное совпадение через спецсимволы регулярных выражений.
export function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 2;
    } else if (glob.startsWith('**', index)) {
      source += '.*';
      index += 1;
    } else if (glob[index] === '*') {
      source += '[^/]*';
    } else {
      source += glob[index].replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

// Русское склонение слова «кейс» при числе: 1 кейс, 2-4 кейса, 5-20 кейсов —
// с исключением для «11-14», которые не подчиняются правилу «2-4».
function countByRussianCases(count) {
  const tail = count % 10;
  const teen = count % 100 >= 11 && count % 100 <= 14;
  if (tail === 1 && !teen) return `${count} кейс`;
  if (tail >= 2 && tail <= 4 && !teen) return `${count} кейса`;
  return `${count} кейсов`;
}

// Задетые модули по diff: модуль считается задетым, если хоть один изменённый
// путь совпал с одним из его шаблонов. Снятые кейсы не считаются кейсами
// модуля — задетый ими модуль попадает в «без кейсов», а не в «с кейсами».
export function computeImpact(acceptance, changedPaths) {
  const covered = new Set();
  const withCases = [];
  const withoutCases = [];
  for (const module of acceptance.modules) {
    const patterns = module.paths.map(globToRegExp);
    const paths = changedPaths.filter((file) => patterns.some((pattern) => pattern.test(file)));
    if (paths.length === 0) continue;
    paths.forEach((file) => covered.add(file));
    const count = module.cases.filter((item) => !item.retired).length;
    if (count > 0) withCases.push({ name: module.name, count, paths });
    else withoutCases.push({ name: module.name, paths });
  }
  return { withCases, withoutCases, uncovered: changedPaths.filter((file) => !covered.has(file)) };
}

export function renderImpact(result) {
  const list = (items) => (items.length ? items : ['нет']);
  return [
    'Задеты модули с кейсами:',
    ...list(result.withCases.map((module) => `  ${module.name} — ${countByRussianCases(module.count)}; ${module.paths.join(', ')}`)).map((line) => (line === 'нет' ? '  нет' : line)),
    'Задеты модули без кейсов:',
    ...list(result.withoutCases.map((module) => `  ${module.name} — ${module.paths.join(', ')}`)).map((line) => (line === 'нет' ? '  нет' : line)),
    'Пути вне реестра:',
    ...list(result.uncovered.map((file) => `  ${file}`)).map((line) => (line === 'нет' ? '  нет' : line)),
  ].join('\n');
}

export function renderStatus(status) {
  const { counts } = status;
  const lines = [
    '# Сводка приёмки',
    '',
    '<!-- сгенерировано командой node scripts/ralph/ralph-acceptance.mjs status; руками не править -->',
    '',
    `Кейсов ${counts.total} · PASS ${counts.PASS} · FAIL ${counts.FAIL} · BLOCKED ${counts.BLOCKED} · SKIPPED ${counts.SKIPPED} · не гонялся ${counts.never}`,
  ];
  for (const module of status.modules) {
    lines.push('', `## ${module.name} — ${module.casesFile}`, '');
    if (module.rows.length === 0) {
      lines.push('Кейсов нет.');
      continue;
    }
    lines.push('| Кейс | Название | Статус | Прогон | История |', '| ---- | -------- | ------ | ------ | ------- |');
    for (const row of module.rows) {
      lines.push(
        `| ${row.id} | ${row.title} | ${row.status ?? 'не гонялся'} | ${row.run ?? '—'} | ${row.history.length ? row.history.join(' ') : '—'} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

// -----------------------------------------------------------------------------
// CLI: две команды поверх разбора и сводки — `status` пишет файл и предупреждает
// о повисших ID в прогонах, `impact` только печатает задетые модули по diff.
// -----------------------------------------------------------------------------

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultDirectory = 'docs/acceptance';
const usage = [
  'Использование:',
  '  node scripts/ralph/ralph-acceptance.mjs status [--dir docs/acceptance]',
  '  node scripts/ralph/ralph-acceptance.mjs impact <диапазон git> [--dir docs/acceptance]',
].join('\n');

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== 'status' && command !== 'impact') throw acceptanceError(usage, 2);
  let range = null;
  let dir = defaultDirectory;
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--dir') {
      dir = rest[index + 1];
      if (!dir) throw acceptanceError(`--dir без значения.\n${usage}`, 2);
      index += 1;
    } else {
      positional.push(rest[index]);
    }
  }
  if (command === 'impact') range = positional.shift() ?? null;
  if (command === 'impact' && !range) throw acceptanceError(`impact ждёт диапазон git.\n${usage}`, 2);
  if (positional.length > 0) throw acceptanceError(`Лишние аргументы: ${positional.join(' ')}.\n${usage}`, 2);
  return { command, range, dir };
}

function changedPathsFromGit(range) {
  const result = run('git', ['diff', '--name-only', range], { allowFailure: true });
  if (result.status !== 0) throw acceptanceError(`git diff --name-only ${range} не удался: ${result.stderr.trim()}`);
  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

// Каталог `--dir` — единственный путь в CLI, который называет человек, а не
// набор: опечатка с «..» иначе тихо читает и пишет за пределами репозитория
// (тот же риск и то же решение, что у validationArtifactPaths в
// ralph-validation-runner.mjs — resolve и сверка с корнем до первого обращения
// к диску). Заодно снимаются завершающие слэши: без этого «--dir a/» даёт
// «a//status.md» в сообщениях и в status.md.
function resolveAcceptanceDirectory(root, dir) {
  const normalized = dir.replaceAll('\\', '/').replace(/\/+$/u, '');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, normalized);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw acceptanceError(
      `--dir «${dir}» выходит за пределы набора: путь обязан остаться внутри корня репозитория.`,
      2,
    );
  }
  return normalized;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const root = dependencies.projectRoot ?? projectRoot;
  const log = dependencies.log ?? console.log;
  const warn = dependencies.warn ?? console.error;
  const writeFile = dependencies.writeFile ?? ((file, text) => writeFileSync(file, text, 'utf8'));
  const { command, range, dir } = parseArguments(argv);
  // Каталог приёмки остаётся относительным: этот вид нужен человеку в
  // сообщениях и в status.md, абсолютный — только для проверки границы и для
  // диска.
  const directory = resolveAcceptanceDirectory(root, dir);
  const files = {
    exists: (file) => existsSync(path.join(root, file)),
    readFile: (file) => readFileSync(path.join(root, file), 'utf8'),
    readDirectory: (file) => (existsSync(path.join(root, file)) ? readdirSync(path.join(root, file)) : []),
  };
  const acceptance = readAcceptance(directory, files);
  if (command === 'status') {
    const status = buildStatus(acceptance);
    for (const warning of status.warnings) warn(`ВНИМАНИЕ: ${warning}`);
    const target = `${directory}/status.md`;
    writeFile(path.join(root, target), renderStatus(status));
    const { counts } = status;
    log(`Кейсов ${counts.total} · PASS ${counts.PASS} · FAIL ${counts.FAIL} · BLOCKED ${counts.BLOCKED} · SKIPPED ${counts.SKIPPED} · не гонялся ${counts.never}`);
    log(`Сводка записана: ${target}`);
    return;
  }
  const changedPaths = (dependencies.changedPaths ?? changedPathsFromGit)(range).map((file) => file.replaceAll('\\', '/'));
  log(renderImpact(computeImpact(acceptance, changedPaths)));
}

// Прямой запуск через node отличается от импорта модуля тестами: process.argv[1]
// указывает на этот файл только в первом случае (тот же приём, что в ralph-loop.mjs).
const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
