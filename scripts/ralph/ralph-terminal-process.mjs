// Карта показывает наблюдённые стадии. Она не управляет циклом и его бюджетами.
const labels = {
  implementation: 'Реализация', validation: 'Проверки', review: 'Ревью',
  fixing: 'Исправления', publishing: 'Публикация', done: 'Готово',
};

export function renderProcessLines(process, width, { reviewOffset = 0, reviewLimit = 3 } = {}) {
  const phase = process.scope === 'phase';
  const names = phase ? { ...labels, implementation: 'Задачи', publishing: 'PR фазы', review: 'Ревью фазы' } : labels;
  const stages = phase ? ['implementation', 'publishing', 'review', 'done']
    : ['implementation', 'validation', 'review', 'done'];
  if (process.current === 'fixing') stages.splice(-1, 0, 'fixing');
  const lines = [phase ? 'ПРОЦЕСС ФАЗЫ' : 'ПРОЦЕСС ЗАДАЧИ'];
  let map = '';
  for (const stage of stages) {
    const disabled = stage === 'review' && process.reviewEnabled === false;
    const marker = disabled ? 'x' : process.failed === stage ? '!' : process.current === stage ? '>'
      : process.completed.includes(stage) ? '+' : process.partial ? '?' : '-';
    const node = `[${marker}] ${disabled ? 'Ревью выключено' : names[stage]}`;
    if (map && [...map, ...' -> ', ...node].length > width) {
      lines.push(map);
      map = node;
    } else map += `${map ? ' -> ' : ''}${node}`;
  }
  if (map) lines.push(map);
  lines.push(`Сейчас: ${names[process.current] ?? 'нет данных'}`);
  const round = Number.isInteger(process.reviewRound) && process.reviewRound > 0 ? process.reviewRound
    : process.partial ? 'нет данных' : 'ещё не начат';
  lines.push(process.reviewEnabled === false ? 'Ревью выключено'
    : `Круг ревью${phase ? ' фазы' : ''}: ${round}`);
  const reviews = process.reviews ?? [];
  const end = Math.max(0, reviews.length - Math.max(0, reviewOffset));
  const start = Math.max(0, end - reviewLimit);
  if (start > 0 || end < reviews.length) lines.push(`Круги ${start + 1}-${end} из ${reviews.length} · PgUp/PgDn`);
  for (const review of reviews.slice(start, end)) {
    const verdict = ({ pass: 'PASS', fail: 'FAIL', error: 'ОШИБКА' })[review.verdict] ?? 'нет результата';
    const findings = Number.isInteger(review.findings) ? review.findings : 'нет данных';
    lines.push(`Ревью ${Number.isInteger(review.round) ? review.round : '?'}: ${verdict} · к исправлению ${findings}`);
  }
  if (process.current === 'fixing') lines.push((process.correctionSource ?? process.failed) === 'validation'
    ? 'Возврат: проверки -> исправления -> проверки'
    : 'Возврат: ревью -> исправления -> проверки');
  if (process.partial) lines.push('История неполная: ранние этапы не записаны');
  return lines;
}
