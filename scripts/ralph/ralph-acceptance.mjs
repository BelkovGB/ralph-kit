/**
 * Хранение кейсов и прогонов приёмки: разбор трёх форматов Markdown, сводка по
 * кейсам и расчёт задетых модулей по diff. Форматы задаёт набор, поэтому разбор
 * строгий: пропущенный кейс в сводке выглядит как «не гонялся», и это ложь.
 */

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
  return rows.map(({ cells, line }) => {
    const [id = '', status = '', comment = ''] = cells;
    if (!caseIdPattern.test(id)) throw acceptanceError(`${file}:${line}: «${id}» не похоже на ID кейса.`);
    if (!acceptanceStatuses.includes(status)) {
      throw acceptanceError(
        `${file}:${line}: статус «${status}» у ${id} не из списка ${acceptanceStatuses.join(', ')}.`,
      );
    }
    return { id, status, comment, line };
  });
}
