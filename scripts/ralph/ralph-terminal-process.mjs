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

function marker(process, stage) {
  return stage === 'review' && process.reviewEnabled === false ? 'x'
    : process.failed === stage ? '!' : process.current === stage ? '>'
      : process.completed.includes(stage) ? '+' : process.partial ? '?' : '-';
}

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
    const node = `[${marker(process, stage)}] ${disabled ? 'Ревью выключено' : names[stage]}`;
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
    lines.push(reviewText(review));
  }
  if (process.current === 'fixing') lines.push((process.correctionSource ?? process.failed) === 'validation'
    ? 'Возврат: проверки -> исправления -> проверки'
    : 'Возврат: ревью -> исправления -> проверки');
  if (process.partial) lines.push('История неполная: ранние этапы не записаны');
  return lines;
}

function panel(title, content, width, height, fit, padding = 0) {
  const rule = fit(` ${title} `, width - 2).replace(/ +$/u, space => '─'.repeat(space.length));
  return [`┌${rule}┐`, ...Array.from({ length: Math.max(0, height - 2) }, (_, i) =>
    `│${' '.repeat(padding)}${fit(content[i] ?? '', width - 2 - 2 * padding)}${' '.repeat(padding)}│`), `└${'─'.repeat(width - 2)}┘`];
}

function wrapLabels(values, width) {
  const lines = [];
  let line = '';
  for (const value of values) {
    if (line && line.length + value.length + 3 > width) { lines.push(line); line = ''; }
    line += `${line ? '   ' : ''}${value}`;
  }
  if (line) lines.push(line);
  return lines;
}

function processMap(process, width, view, fit) {
  const phase = process.scope === 'phase';
  const names = phase ? { ...labels, implementation: 'Задачи', publishing: 'PR фазы', review: 'Ревью фазы' } : labels;
  const stages = phase ? ['implementation', 'publishing', 'review', 'fixing', 'done']
    : ['implementation', 'validation', 'review', 'fixing', 'done'];
  const nodeWidth = Math.floor((width - 2 - 12) / 5);
  const margin = Math.floor((width - 2 - nodeWidth * 5 - 12) / 2);
  const nodes = stages.map(stage => {
    const name = stage === 'review' && process.reviewEnabled === false ? 'Ревью выключено' : names[stage];
    const label = `[${marker(process, stage)}] ${name}`;
    const padding = Math.max(0, Math.floor((nodeWidth - 2 - label.length) / 2));
    return [`┌${'─'.repeat(nodeWidth - 2)}┐`,
      `│${fit(' '.repeat(padding) + label, nodeWidth - 2)}│`, `└${'─'.repeat(nodeWidth - 2)}┘`];
  });
  const round = process.reviewRound ?? (process.partial ? 'нет данных' : 'ещё не начат');
  const reviews = reviewWindow(process, view.reviewOffset ?? 0, 3);
  const end = (process.reviews?.length ?? 0) - (view.reviewOffset ?? 0);
  const history = process.reviews?.length > 3 ? ` · История: ${end - reviews.length + 1}-${end}/${process.reviews.length}` : '';
  const info = `Сейчас: ${names[process.current] ?? 'нет данных'} · ${process.reviewEnabled === false ? 'Ревью выключено' : `Круг ревью${phase ? ' фазы' : ''}: ${round}`}${history}`;
  const resultRows = wrapLabels(reviews.map(reviewText), width - 2);
  const source = process.correctionSource ?? (process.current === 'fixing' ? process.failed : null);
  const start = margin + (nodeWidth + 3) + Math.floor(nodeWidth / 2);
  const length = 2 * (nodeWidth + 3);
  const returning = source === 'review' || source === 'validation';
  const returnPath = returning ? ' '.repeat(start) + '└' + '┄'.repeat(length - 1) + '┘' : '';
  if (returning) {
    for (const [index, joint] of [[1, '^'], [3, '┬']]) {
      const center = Math.floor(nodeWidth / 2);
      const edge = nodes[index][2];
      nodes[index][2] = edge.slice(0, center) + joint + edge.slice(center + 1);
    }
  }
  const returnLabel = returning ? `Возврат: ${source === 'validation' ? 'проверки' : 'ревью'} -> исправления -> проверки`
    : '> сейчас · + пройдено · ! сбой · - не пройдено · x выключено';
  const content = [info, ...(resultRows.length ? resultRows : ['Ревью ещё не завершено']),
    ...[0, 1, 2].map(row => ' '.repeat(margin) + nodes.map(node => node[row]).join(row === 1 ? '──>' : '   ')),
    returnPath, returnLabel, ...(process.partial ? ['История неполная: ранние этапы не записаны'] : [])];
  return panel(phase ? 'ПРОЦЕСС ФАЗЫ' : 'ПРОЦЕСС ЗАДАЧИ', content, width, content.length + 2, fit);
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
  if (room > rows.length + 3 && known.length) {
    const maximum = Math.max(...known.map(review => review.findings));
    rows.push('', 'К ИСПРАВЛЕНИЮ ПО КРУГАМ');
    for (const review of reviewWindow(snapshot.process, view.reviewOffset ?? 0, 3).filter(review => Number.isInteger(review.findings))) {
      rows.push(`Круг ${review.round ?? '?'}: ${review.findings}  ${bar(review.findings, maximum, Math.max(1, width - 14))}`);
    }
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
  const context = [`${snapshot.timeLabel ?? 'Сессия задачи'}: ${snapshot.issueTime ?? '—'}`, `Прогон: ${snapshot.runTime ?? '—'}`];
  if (timing.length + notes.length + full.length + context.length + 2 > room) session = snapshot.compactSessionCounters ?? full;
  const available = room - timing.length - notes.length - 2;
  const priority = [...session.filter(row => row.startsWith('До остановки:')),
    ...session.filter(row => !row.startsWith('До остановки:'))];
  return ['ВРЕМЯ ПО СТАДИЯМ', ...timing, ...notes, '',
    ...(available >= session.length + context.length ? [...context, ...session] : priority),
    ...(room > timing.length + notes.length + session.length + context.length + 3 ? ['Токены: нет данных'] : [])];
}

export function renderProcessDashboard(snapshot, events, columns, rows, view) {
  const { fit } = view;
  const width = columns - 1;
  const height = rows - 1;
  const status = `Фаза ${snapshot.phase ?? '—'} · Прогон: ${snapshot.runTime ?? '—'}`;
  const header = fit(`RALPH --run · ${snapshot.status ?? 'Работает'} · ${snapshot.milestone ?? ''}`, Math.max(0, width - status.length - 1)) + ' ' + status;
  const context = `СЕЙЧАС: ${snapshot.headline ?? snapshot.stage}${snapshot.issue && snapshot.issue !== snapshot.headline ? ` · ${snapshot.issue}` : ''}`;
  const map = processMap(snapshot.process, width, view, fit);
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
  const colors = { '+': 32, '>': 33, '!': 31, x: 90, '?': 90, '-': 90 };
  const lines = frame.split('\n');
  const spans = new Map();
  const paint = (row, start, end, color) => {
    const list = spans.get(row) ?? [];
    if (list.some(span => span.start < end && span.end > start)) return;
    list.push({ start, end, color });
    spans.set(row, list);
  };
  for (let row = 0; row < lines.length; row += 1) {
    for (const match of lines[row].matchAll(/\[([+>!x?-])\]/gu)) {
      const start = lines[row].lastIndexOf('│', match.index);
      const end = lines[row].indexOf('│', match.index + match[0].length);
      if (start < 0 || end < 0) continue;
      paint(row, start, end + 1, colors[match[1]]);
      if (lines[row - 1]?.[start] === '┌') paint(row - 1, start, end + 1, colors[match[1]]);
      if (lines[row + 1]?.[start] === '└') paint(row + 1, start, end + 1, colors[match[1]]);
    }
    if (lines[row].includes('Возврат:') || lines[row].includes('┄')) paint(row, 0, lines[row].length, 31);
    if (lines[row].startsWith('┌') || lines[row].startsWith('RALPH')) paint(row, 0, lines[row].length, 1);
    for (const match of lines[row].matchAll(/█+|░+/gu)) {
      const start = lines[row].lastIndexOf('│', match.index);
      const end = lines[row].indexOf('│', match.index + match[0].length);
      const cell = lines[row].slice(start + 1, end < 0 ? undefined : end);
      const color = match[0][0] === '░' ? 90 : cell.includes('Исправления') ? 33
        : cell.includes('Круг ') ? 31 : cell.trim().startsWith('█') ? 36 : 32;
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
