import { processCurrentStage, processStageMarker, processOperationNode, processMapRows } from './ralph-terminal-map.mjs';

// Карта показывает наблюдённые стадии. Она не управляет циклом и его бюджетами.
const labels = {
  implementation: 'Реализация', validation: 'Проверки', review: 'Ревью',
  fixing: 'Исправления', publishing: 'Публикация', done: 'Готово',
};

function reviewText(review) {
  const verdict = ({ pass: 'PASS', fail: 'FAIL', error: 'ОШИБКА' })[review.verdict] ?? 'нет результата';
  const count = Number.isInteger(review.findings) ? review.findings : 'нет данных';
  return `Ревью ${Number.isInteger(review.round) ? review.round : '?'}: ${verdict} · к исправлению ${count}`;
}

function reviewWindow(process, offset, limit) {
  const reviews = process.reviews ?? [];
  const end = Math.max(0, reviews.length - Math.max(0, offset));
  return reviews.slice(Math.max(0, end - limit), end);
}

export function renderProcessLines(process, width, { reviewOffset = 0, reviewLimit = 3, snapshot } = {}) {
  const phase = process.scope === 'phase';
  const names = phase ? { ...labels, implementation: 'Задачи', publishing: 'PR фазы' } : labels;
  const current = processCurrentStage(process);
  const auxiliary = processOperationNode(snapshot ?? { process });
  const stages = phase ? ['implementation', 'validation', 'publishing', 'review', 'done']
    : ['implementation', 'validation', 'review', 'done'];
  const badge = value => Number.isInteger(value) && value > 0 ? ` #${value}` : process.partial ? ' #?' : '';
  const lines = [phase ? 'ПРОЦЕСС ФАЗЫ' : 'ПРОЦЕСС ЗАДАЧИ'];
  let line = '';
  for (const stage of stages) {
    if (stage === 'review' && process.reviewEnabled === false) continue;
    const label = `[${processStageMarker(process, stage, !auxiliary)}] ${names[stage]}${stage === 'review' ? badge(process.reviewRound) : ''}${process.errorStage === stage ? ' ERROR' : ''}`;
    if (line && line.length + label.length + 4 > width) { lines.push(line); line = ''; }
    line += `${line ? ' ··> ' : ''}${label}`;
  }
  if (line) lines.push(line);
  if (process.reviewEnabled === false) lines.push('[x] Ревью выключено');
  if ((process.correctionSource || current === 'fixing') && !['review', 'done'].includes(current)
    && (!process.errorStage || current === 'fixing')) {
    const review = process.reviews?.findLast(result => result.verdict === 'fail');
    const source = process.failed === 'validation' && !process.errorStage || process.correctionSource === 'validation' ? 'Проверки' : 'Ревью';
    const round = process.correctionSource === 'review' ? badge(review?.round ?? process.reviewRound) : '';
    const count = source === 'Ревью' ? `${Number.isInteger(review?.findings) ? review.findings : '?'} замеч.` : 'FAIL';
    lines.push(`${source} ─${count}→ [${processStageMarker(process, 'fixing', !auxiliary)}] Исправления${round}`);
    lines.push(`└${process.completed.includes('fixing') ? '──' : '┄┄'}→ ${phase ? 'Задачи' : 'Проверки'}`);
  }
  if (auxiliary) lines.push(`[${auxiliary.marker}] ${auxiliary.label}`);
  if (reviewOffset > 0) {
    const reviews = process.reviews ?? [];
    const end = Math.max(0, reviews.length - reviewOffset);
    lines.push(`История: ${Math.max(0, end - reviewLimit) + 1}-${end}/${reviews.length}`,
      ...reviewWindow(process, reviewOffset, reviewLimit).map(reviewText));
  }
  if (process.partial) lines.push('История неполная: ранние этапы не записаны');
  return lines;
}

function panel(title, content, width, height, fit, padding = 0) {
  const rule = fit(` ${title} `, width - 2).replace(/ +$/u, space => '─'.repeat(space.length));
  return [`┌${rule}┐`, ...Array.from({ length: Math.max(0, height - 2) }, (_, i) =>
    `│${' '.repeat(padding)}${fit(content[i] ?? '', width - 2 - 2 * padding)}${' '.repeat(padding)}│`), `└${'─'.repeat(width - 2)}┘`];
}

function processMap(snapshot, width, fit) {
  const content = processMapRows(snapshot, width - 2, fit);
  return panel(snapshot.process.scope === 'phase' ? 'ПРОЦЕСС ФАЗЫ' : 'ПРОЦЕСС ЗАДАЧИ', content,
    width, content.length + 2, fit);
}

function elapsed(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'нет данных';
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function bar(value, limit, width) {
  if (!Number.isFinite(value) || !Number.isFinite(limit) || limit <= 0) return '';
  const filled = Math.min(width, Math.max(0, Math.round(value / limit * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function qualityRows(snapshot, room, width, view) {
  const groups = snapshot.counterGroups ?? { run: [], checks: [] };
  let rows = [...groups.run, ...groups.checks];
  if (rows.length > room) rows = rows.filter(row => !row.startsWith('Вызовы Lisa за прогон:'));
  if (room > rows.length + 4 && snapshot.phaseBudget?.limit > 0) {
    rows.push('', 'БЮДЖЕТ ИТЕРАЦИЙ', bar(snapshot.phaseBudget.used, snapshot.phaseBudget.limit, width));
  }
  const reviews = snapshot.process.reviews ?? [];
  const known = reviews.filter(review => Number.isInteger(review.findings));
  if ((view.reviewOffset > 0 || room > rows.length + 3) && reviews.length) {
    const maximum = Math.max(...known.map(review => review.findings));
    const window = reviewWindow(snapshot.process, view.reviewOffset ?? 0, 3);
    const end = Math.max(0, reviews.length - (view.reviewOffset ?? 0));
    const chart = [view.reviewOffset > 0 ? `ИСТОРИЯ: ${end - window.length + 1}-${end}/${reviews.length}` : 'К ИСПРАВЛЕНИЮ ПО КРУГАМ'];
    for (const review of window) {
      const status = review.verdict === 'pass' ? '+' : review.verdict === 'fail' ? '~' : '?';
      chart.push(`Круг ${review.round ?? '?'}: ${review.findings ?? '?'} [${status}] ${bar(review.findings, maximum, Math.max(1, width - 18))}`);
    }
    rows = view.reviewOffset > 0 ? [...chart, '', ...rows] : [...rows, '', ...chart];
  }
  return rows;
}

function metricRows(snapshot, room, width) {
  const measured = Object.entries(snapshot.process.stageMs ?? {}).filter(([, value]) => typeof value === 'number');
  const sum = measured.reduce((total, [, value]) => total + value, 0);
  const timing = measured.length ? Object.keys(labels).filter(stage => stage !== 'done').map(stage => {
    const ms = snapshot.process.stageMs[stage];
    return `${labels[stage].padEnd(12)} ${elapsed(ms)} ${bar(ms, sum, Math.max(0, width - 23))}`;
  }) : ['Время стадий ещё не записано'];
  const notes = snapshot.process.timingPartial ? ['Время измерено частично'] : [];
  const full = snapshot.counterGroups?.session ?? [];
  let session = full;
  const context = [`${snapshot.timeLabel ?? 'Сессия задачи'}: ${snapshot.issueTime ?? '—'}`];
  if (timing.length + notes.length + full.length + context.length + 2 > room) session = snapshot.compactSessionCounters ?? full;
  const available = room - timing.length - notes.length - 2;
  const priority = [...session.filter(row => row.startsWith('До остановки:')),
    ...session.filter(row => !row.startsWith('До остановки:'))];
  return ['ВРЕМЯ ПО СТАДИЯМ', ...timing, ...notes, '',
    ...(available >= session.length + context.length ? [...context, ...session] : priority)];
}

export function renderProcessDashboard(snapshot, events, columns, rows, view) {
  const { fit } = view;
  const width = columns - 1;
  const height = rows - 1;
  const status = `Фаза ${snapshot.phase ?? '—'} · Прогон: ${snapshot.runTime ?? '—'}`;
  const header = fit(`RALPH --run · ${snapshot.status ?? 'Работает'} · ${snapshot.milestone ?? ''}`, Math.max(0, width - status.length - 1)) + ' ' + status;
  const subject = snapshot.subject ?? snapshot.issue ?? snapshot.headline ?? snapshot.milestone ?? '';
  const context = [subject, snapshot.detail === subject ? null : snapshot.detail].filter(Boolean).join(' · ');
  const map = processMap(snapshot, width, fit);
  const bottomHeight = height - map.length - 3;
  const left = Math.floor((width - 2) * 0.28);
  const center = Math.floor((width - 2) * 0.36);
  const right = width - 2 - left - center;
  const eventRoom = Math.max(0, bottomHeight - 2);
  const panels = [
    panel('ПРОГРЕСС И КАЧЕСТВО', qualityRows(snapshot, eventRoom, left - 4, view), left, bottomHeight, fit, 1),
    panel('СОБЫТИЯ', events.slice(-eventRoom), center, bottomHeight, fit, 1),
    panel(snapshot.process.scope === 'phase' ? 'МЕТРИКИ ФАЗЫ' : 'МЕТРИКИ ЗАДАЧИ',
      metricRows(snapshot, eventRoom, right - 4), right, bottomHeight, fit, 1),
  ];
  return [header, context, ...map, ...Array.from({ length: bottomHeight }, (_, row) => panels.map(part => part[row]).join(' ')),
    'PgUp/PgDn круги · End последние · Tab лог · Ctrl+C стоп'];
}

export function colorTerminalFrame(frame) {
  const colors = { '+': 32, '>': 33, '~': 33, '!': 31, x: 90, '?': 90, '-': 90 };
  const lines = frame.split('\n');
  const spans = new Map();
  const paint = (row, start, end, color) => {
    const list = spans.get(row) ?? [];
    if (list.some(span => span.start < end && span.end > start)) return;
    list.push({ start, end, color });
    spans.set(row, list);
  };
  for (let row = 0; row < lines.length; row += 1) {
    for (const match of lines[row].matchAll(/\[([+>!~x?-])\]/gu)) {
      let start = match.index;
      while (start >= 0 && !'│║┤╣'.includes(lines[row][start])) start -= 1;
      let end = match.index + match[0].length;
      while (end < lines[row].length && !'│║'.includes(lines[row][end])) end += 1;
      if (start < 0 || end >= lines[row].length) continue;
      paint(row, start, end + 1, colors[match[1]]);
      if ('┌╔'.includes(lines[row - 1]?.[start] ?? ' ')) paint(row - 1, start, end + 1, colors[match[1]]);
      if ('└╚'.includes(lines[row + 1]?.[start] ?? ' ')) paint(row + 1, start, end + 1, colors[match[1]]);
    }
    for (const match of lines[row].matchAll(/┄+(?:→)?|━+(?:→)?|─{2,}→|\d+ замечани[еяй]/gu)) {
      paint(row, match.index, match.index + match[0].length,
        match[0].startsWith('┄') ? 90 : match[0].startsWith('━') ? 33 : match[0].startsWith('─') ? 32 : 33);
    }
    if (lines[row].startsWith('┌') || lines[row].startsWith('RALPH')) paint(row, 0, lines[row].length, 1);
    for (const match of lines[row].matchAll(/█+|░+/gu)) {
      const start = lines[row].lastIndexOf('│', match.index);
      const end = lines[row].indexOf('│', match.index + match[0].length);
      const cell = lines[row].slice(start + 1, end < 0 ? undefined : end);
      const color = match[0][0] === '░' ? 90 : cell.includes('Исправления') ? 33
        : cell.includes('Круг ') ? 33 : cell.trim().startsWith('█') ? 36 : 32;
      paint(row, match.index, match.index + match[0].length, color);
    }
  }
  return lines.map((line, row) => {
    for (const span of (spans.get(row) ?? []).sort((a, b) => b.start - a.start)) {
      line = line.slice(0, span.start) + `\x1b[${span.color}m` + line.slice(span.start, span.end) + '\x1b[0m' + line.slice(span.end);
    }
    return line;
  }).join('\n');
}
