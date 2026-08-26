/**
 * Что считается control plane Ralph, а что продуктовой работой.
 *
 * Ralph управляет продуктовым циклом, но его собственная реализация и
 * инструкции настраиваются оператором вручную. Поэтому findings и issues,
 * указывающие на `.agents/**`, `.claude/**`, `scripts/ralph/**` и любые
 * `AGENTS.md` или `CLAUDE.md`, не должны попадать в продуктовую очередь.
 *
 * Модуль намеренно не импортирует ничего: это делает его пригодным для
 * использования из любого другого модуля Ralph без риска цикла.
 */

export const ralphInfrastructureLabel = 'ralph-infrastructure';

export function fail(message) {
  throw new Error(message);
}

export function isRalphInfrastructurePath(file) {
  const normalized = String(file ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/:\d+(?::\d+)?$/, '');

  // `AGENTS.md` читает Codex, `CLAUDE.md` — Claude Code; обоими задаётся
  // поведение будущей сессии, поэтому и защищены они одинаково.
  return (
    normalized === 'AGENTS.md' ||
    normalized.endsWith('/AGENTS.md') ||
    normalized === 'CLAUDE.md' ||
    normalized.endsWith('/CLAUDE.md') ||
    normalized === '.agents' ||
    normalized.startsWith('.agents/') ||
    // Claude Code читает из `.claude/**` агентов, скиллы, настройки и хуки.
    // Файл, положенный туда, меняет поведение будущей сессии, поэтому каталог
    // относится к control plane наравне с `.agents/**`.
    normalized === '.claude' ||
    normalized.startsWith('.claude/') ||
    normalized === 'scripts/ralph' ||
    normalized.startsWith('scripts/ralph/')
  );
}

/**
 * Тот же список путей в виде pathspec для git.
 *
 * Выводится здесь, а не пишется вторым списком рядом с git-командами: два
 * перечисления одного и того же расходятся при первом же добавлении каталога, и
 * расхождение будет тихим — diff просто покажет лишнее.
 */
export const controlPlaneExcludePathspec = [
  ':(exclude).agents',
  ':(exclude).claude',
  ':(exclude)scripts/ralph',
  ':(exclude)AGENTS.md',
  ':(exclude,glob)**/AGENTS.md',
  ':(exclude)CLAUDE.md',
  ':(exclude,glob)**/CLAUDE.md',
];

export function issueLabels(issue) {
  return (issue?.labels ?? []).map((label) =>
    typeof label === 'string' ? label : String(label?.name ?? ''),
  );
}

export function milestoneFindingPath(issue) {
  if (!String(issue?.body ?? '').includes('<!-- ralph-milestone-finding ')) return null;
  return String(issue.body).match(/^\*\*Location:\*\*\s+`([^`]+)`\s*$/m)?.[1] ?? null;
}

export function isRalphInfrastructureIssue(issue) {
  return (
    issueLabels(issue).some((label) => label.toLowerCase() === ralphInfrastructureLabel) ||
    isRalphInfrastructurePath(milestoneFindingPath(issue))
  );
}

/**
 * Замечания к control plane выбрасываются из любого ревью, а не только из
 * milestone.
 *
 * Агенту запрещено править `.agents/**`, `.claude/**`, `scripts/ralph/**` и
 * `AGENTS.md`, и ревью, которое требует именно этого, невыполнимо по
 * построению: следующая сессия вернёт тот же результат, ревью — то же
 * замечание. На issue #84 так и вышло — десять заходов подряд, около двух
 * часов и порядка девяти миллионов токенов, причём поводом были правки
 * оператора в конфиге, сделанные параллельно с прогоном.
 */
export function scopeReviewToProduct(review, label = 'Review') {
  const productFindings = review.findings.filter(
    (finding) => !isRalphInfrastructurePath(finding.file),
  );
  const ignoredCount = review.findings.length - productFindings.length;
  if (ignoredCount === 0) return review;

  console.log(
    `${label}: ${ignoredCount} замечаний к Ralph-инфраструктуре исключены из продуктовой очереди.`,
  );
  return {
    ...review,
    verdict: productFindings.length > 0 ? 'fail' : 'pass',
    summary:
      `${review.summary} ${ignoredCount} Ralph infrastructure finding(s) were excluded ` +
      'from the product milestone and must be handled manually in the configuration chat.',
    findings: productFindings,
  };
}

/**
 * Порог важности, ниже которого замечание не блокирует работу.
 *
 * Ревьюер с `effort=high` на растущем изменении всегда найдёт ещё один P3:
 * каждое исправление трогает больше кода и даёт ему больше поверхности. За
 * ночь это дало десять заходов на одной задаче и три на другой, ни разу не
 * сойдясь, — при том что ни одно замечание не было важнее P3.
 *
 * Замечания ниже порога не исчезают: они остаются в сводке ревью и в
 * комментарии к PR. Они лишь перестают отклонять работу и заводить задачи.
 */
const severityOrder = ['P0', 'P1', 'P2', 'P3'];

export function findingBlocks(finding, floor) {
  const rank = severityOrder.indexOf(String(finding?.severity ?? '').toUpperCase());
  const limit = severityOrder.indexOf(String(floor ?? 'P3').toUpperCase());

  // Незнакомая важность считается блокирующей: молча пропустить замечание
  // опаснее, чем лишний раз остановить работу.
  return rank === -1 || limit === -1 || rank <= limit;
}

export function applySeverityFloor(review, floor, label = 'Review') {
  const blocking = review.findings.filter((finding) => findingBlocks(finding, floor));
  const belowFloor = review.findings.length - blocking.length;
  if (belowFloor === 0) return review;

  console.log(
    `${label}: ${belowFloor} замечаний ниже порога ${floor} не блокируют работу и остаются в отчёте.`,
  );
  // Замечания уходят в отдельное поле, а не в никуда. Первая версия просто
  // вырезала их из `findings`, и отчёт выходил с пустым списком под фразой
  // «четыре замечания ниже порога» — то есть ровно с тем, чего обещал не делать.
  return {
    ...review,
    verdict: blocking.length > 0 ? 'fail' : 'pass',
    summary:
      `${review.summary} ${belowFloor} finding(s) below the ${floor} severity floor are reported ` +
      'but do not block the work.',
    findings: blocking,
    belowFloorFindings: review.findings.filter((finding) => !findingBlocks(finding, floor)),
  };
}

export function scopeMilestoneReviewToProduct(review) {
  return scopeReviewToProduct(review, 'Milestone review');
}
