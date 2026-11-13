const stageNames = {
  implementation: 'Реализация', validation: 'Проверки', review: 'Ревью',
  fixing: 'Исправления', publishing: 'Git / GitHub', done: 'Готово',
};

export function processCurrentStage(process) {
  return process.current === 'implementation' && process.correctionSource ? 'fixing' : process.current;
}

export function processStageMarker(process, stage, active = true) {
  const current = processCurrentStage(process);
  const error = process.errorStage === stage && !(stage === 'implementation' && process.correctionSource) || stage === 'fixing'
    && process.errorStage === 'implementation' && process.correctionSource;
  if (stage === 'review' && process.reviewEnabled === false) return 'x';
  if (error) return '!';
  if (stage === 'done' && (current === 'done' || process.completed.includes('done'))) return '+';
  if (current === stage && active) return '>';
  if (stage === 'review' && process.failed === 'review') {
    const result = process.reviews?.findLast(review => review.round === process.reviewRound);
    return result?.verdict === 'fail' ? '~' : '!';
  }
  if (process.failed === stage && !(stage === 'implementation' && process.correctionSource)) return '!';
  return process.completed.includes(stage) ? '+' : process.partial ? '?' : '-';
}

function badge(round, partial) {
  return Number.isInteger(round) && round > 0 ? ` #${round}` : partial ? ' #?' : '';
}

function findingsText(value) {
  if (!Number.isInteger(value)) return 'замечания: ?';
  const last = value % 100;
  const word = last >= 11 && last <= 14 ? 'замечаний'
    : value % 10 === 1 ? 'замечание' : value % 10 >= 2 && value % 10 <= 4 ? 'замечания' : 'замечаний';
  return `${value} ${word}`;
}

export function processOperationNode(snapshot) {
  if (snapshot.actor === 'Lisa') return {
    label: ({ repairing: 'Lisa: ремонт', checking: 'Lisa: проверка', accepted: 'Lisa: ремонт принят',
      resuming: 'Lisa: возобновление', 'needs-human': 'Lisa: нужен оператор' })[snapshot.repairStatus] ?? 'Lisa',
    marker: snapshot.repairStatus === 'needs-human' ? '!' : '>',
  };
  const process = snapshot.process;
  if (process.scope === 'phase' && process.current === 'publishing' && process.operation === 'pull-request') return null;
  if (process.current !== 'publishing' && !['pull-request', 'review-results', 'milestone-close'].includes(process.operation)) return null;
  return { label: ({ staging: 'Подготовка коммита', committing: 'Подготовка коммита', committed: 'Отправка',
    closing: 'Закрытие задачи', 'pull-request': 'Создание PR', 'review-results': 'Задачи замечаний',
    'milestone-close': 'Закрытие фазы' })[process.operation] ?? 'Git / GitHub',
  marker: process.errorStage === 'publishing' ? '!' : '>' };
}

export function processMapRows(snapshot, width, fit) {
  const process = snapshot.process;
  const current = processCurrentStage(process);
  const phase = process.scope === 'phase';
  const names = phase ? { ...stageNames, implementation: 'Задачи', publishing: 'PR фазы', done: 'Фаза готова' } : stageNames;
  const stages = phase ? ['implementation', 'validation', 'publishing', 'review', 'done']
    : ['implementation', 'validation', 'review', 'done'];
  const last = stages.length - 1;
  const reviewIndex = stages.indexOf('review');
  const beforeReview = reviewIndex - 1;
  const nodeWidth = Math.floor((width - 3 * last) / stages.length);
  const margin = Math.floor((width - nodeWidth * stages.length - 3 * last) / 2);
  const left = index => margin + index * (nodeWidth + 3);
  const center = index => left(index) + Math.floor(nodeWidth / 2);
  const auxiliary = processOperationNode(snapshot);
  const correcting = Boolean(process.correctionSource || current === 'fixing') && !['review', 'done'].includes(current)
    && (!process.errorStage || current === 'fixing');
  const disabled = process.reviewEnabled === false;
  const base = disabled ? 1 : 0;
  const rows = Array.from({ length: base + (correcting || auxiliary ? 7 : 3) }, () => Array(width).fill(' '));
  const put = (row, column, value) => {
    for (const [index, char] of [...value].entries()) if (column + index >= 0 && column + index < width) rows[row][column + index] = char;
  };
  const node = (row, column, label, status, active) => {
    const text = `[${status}] ${label}`;
    const padding = Math.max(0, Math.floor((nodeWidth - 2 - text.length) / 2));
    const border = active ? ['╔', '═', '╗', '║', '╚', '╝'] : ['┌', '─', '┐', '│', '└', '┘'];
    put(row, column, border[0] + border[1].repeat(nodeWidth - 2) + border[2]);
    put(row + 1, column, border[3] + fit(' '.repeat(padding) + text, nodeWidth - 2) + border[3]);
    put(row + 2, column, border[4] + border[1].repeat(nodeWidth - 2) + border[5]);
  };
  for (const [index, stage] of stages.entries()) {
    let label = names[stage] + (stage === 'review' && !disabled ? badge(process.reviewRound, process.partial) : '');
    if (process.errorStage === stage && !(stage === 'implementation' && process.correctionSource)) label += ' ERROR';
    else if (stage === 'validation' && process.failed === stage) label += ' FAIL';
    let status = processStageMarker(process, stage, !auxiliary);
    if (phase && stage === 'implementation' && correcting) status = process.partial ? '?' : '-';
    node(base, left(index), label, status, !auxiliary && current === stage);
    if (index === last || disabled && index >= beforeReview) continue;
    const next = stages[index + 1];
    const entered = process.completed.includes(stage) && next === current;
    const passed = process.completed.includes(stage) && process.completed.includes(next);
    put(base + 1, left(index) + nodeWidth, entered ? '━━→' : passed ? '──→' : '┄┄→');
  }
  if (disabled) {
    const passed = process.completed.includes(stages[beforeReview]) && current === 'done';
    put(0, center(beforeReview), '┌' + (passed ? '─' : '┄').repeat(center(last) - center(beforeReview) - 1) + '┐');
    put(0, center(reviewIndex) - 5, '× выключено');
    put(base, center(beforeReview), '┴');
    put(base, center(last), '↓');
  }
  if (correcting) {
    const validationFailure = process.failed === 'validation' && !process.errorStage;
    const origin = validationFailure || process.correctionSource === 'validation' ? 'validation' : 'review';
    const result = process.reviews?.findLast(review => review.verdict === 'fail');
    const round = process.correctionSource === 'review' ? badge(result?.round ?? process.reviewRound, process.partial) : '';
    const label = names.fixing + round + (process.errorStage === 'implementation' ? ' ERROR' : '');
    node(base + 4, left(reviewIndex), label, processStageMarker(process, 'fixing', !auxiliary), !auxiliary && current === 'fixing');
    const input = center(phase ? 0 : 1) - (origin === 'validation' ? Math.ceil(nodeWidth / 4) : 0);
    const source = origin === 'validation' ? center(1) + Math.ceil(nodeWidth / 4) : center(reviewIndex);
    put(base + 2, source, '┬');
    if (source === center(reviewIndex)) {
      put(base + 3, source, '│');
      put(base + 3, source + 2, findingsText(result?.findings));
    } else {
      put(base + 3, source, '└' + '─'.repeat(center(reviewIndex) - source - 1) + '┐');
      put(base + 3, source + 2, ' FAIL ');
    }
    put(base + 4, center(reviewIndex), '↓');
    put(base + 2, input, '↑');
    put(base + 3, input, '│');
    put(base + 4, input, '│');
    const taken = process.completed.includes('fixing');
    const line = taken ? current === 'validation' && !process.errorStage ? '━' : '─' : '┄';
    put(base + 5, input, '└' + line.repeat(left(reviewIndex) - input - 1));
    put(base + 5, left(reviewIndex), !auxiliary && current === 'fixing' ? '╣' : '┤');
  }
  if (auxiliary) node(base + 4, left(phase ? last : 0), auxiliary.label, auxiliary.marker, true);
  return [...rows.map(row => row.join('')), ...(process.partial ? ['История неполная: ранние этапы не записаны'] : [])];
}
