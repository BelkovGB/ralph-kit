import { stripVTControlCharacters } from 'node:util';

const stages = {
  'agent-running': 'Реализация', 'working-tree': 'Изменения готовы', validating: 'Проверки',
  'validation-mutated': 'Проверки изменили файлы', staging: 'Подготовка коммита',
  committed: 'Коммит готов', pushed: 'Отправлено', reviewing: 'Ревью',
  'review-failed': 'Ревью отклонено', closing: 'Закрытие задачи',
};

function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function terminalSnapshot(store, metrics, startedMs, now = Date.now()) {
  const state = store?.state;
  const issue = store?.issue;
  return {
    status: store && !state ? 'Завершён' : 'Работает',
    phase: state ? `${store.phaseIndex + 1}/${store.phaseCount}` : '—',
    milestone: state?.milestone,
    issue: issue ? `#${issue.number} ${issue.title}` : undefined,
    stage: issue ? (stages[issue.phase] ?? issue.phase) : 'Между задачами / подготовка',
    iteration: state?.iterationsUsed,
    fixes: issue?.validationFixAttempts,
    issueTime: metrics && issue?.number === metrics.issue ? duration(now - metrics.startedMs) : undefined,
    runTime: duration(now - startedMs),
  };
}

export function parseUiOption(mode, args) {
  if (args.length === 0) return 'plain';
  if (args.length === 1 && args[0] === '--ui=plain') return 'plain';
  if (mode === '--run' && args.length === 1 && args[0] === '--ui=split') return 'split';
  throw new Error('Используйте --run --ui=split или --ui=plain.');
}

// Ограниченный алфавит гарантирует ширину ячейки без зависимости от версии
// Unicode в терминале. Другие символы остаются в полном run.log.
function clean(value) {
  return stripVTControlCharacters(String(value ?? '—'))
    // eslint-disable-next-line no-control-regex -- kit-hygiene: allow — линтер набора; удаляем управляющие символы.
    .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, '')
    .replace(/[^\u0020-\u007e\u00a0-\u024f\u0400-\u052f\u2010-\u2027\u2500-\u257f]/gu, '?');
}

function fit(value, width) {
  const text = [...clean(value)];
  return (text.length > width ? text.slice(0, Math.max(0, width - 1)).join('') + '…' : text.join('')).padEnd(width);
}

export function renderTerminal(snapshot, events, columns, rows) {
  const width = Math.max(1, Math.floor(columns) - 1);
  const height = Math.max(1, Math.floor(rows) - 1);
  const summary = [
    'RALPH · ' + (snapshot.status ?? 'Работает'),
    `Фаза ${snapshot.phase ?? '—'}`,
    `Milestone: ${snapshot.milestone ?? '—'}`,
    '',
    snapshot.issue ?? 'Задача ещё не выбрана',
    `Этап: ${snapshot.stage ?? 'Подготовка'}`,
    `Итерация фазы: ${snapshot.iteration ?? '—'}`,
    `Исправлений тестов: ${snapshot.fixes ?? '—'}`,
    `Сессия задачи: ${snapshot.issueTime ?? '—'}`,
    `Прогон: ${snapshot.runTime ?? '—'}`,
  ];
  const footer = 'Ctrl+C остановить · полный вывод: run.log';
  if (width < 89 || height < 15) {
    const top = summary.filter(Boolean).slice(0, Math.max(1, height - 4));
    const room = Math.max(0, height - top.length - 2);
    return [...top, '── События ──', ...(room ? events.slice(-room) : []), footer]
      .slice(0, height).map(line => fit(line, width)).join('\n');
  }
  const left = Math.floor(width * 0.38);
  const right = width - left - 3;
  const eventRows = ['СОБЫТИЯ', ...events.slice(-(height - 3))];
  const lines = Array.from({ length: height - 1 }, (_, index) =>
    `${fit(summary[index] ?? '', left)} │ ${fit(eventRows[index] ?? '', right)}`);
  return [...lines, fit(footer, width)].join('\n');
}

export function createTerminal({ output = process.stdout, errorOutput = process.stderr,
  lifecycle = process, term = process.env.TERM, snapshot = () => ({}) } = {}) {
  if (!output.isTTY || !errorOutput.isTTY || term === 'dumb' || !output.columns || !output.rows) return null;
  let closed = false;
  const events = [];
  const draw = () => {
    if (closed) return;
    const frame = renderTerminal(snapshot(), events, output.columns, output.rows);
    output.write('\x1b[H' + frame.replaceAll('\n', '\x1b[K\r\n') + '\x1b[J');
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    output.off('resize', draw);
    lifecycle.off('exit', close);
    lifecycle.off('SIGINT', interrupt);
    lifecycle.off('SIGTERM', terminate);
    output.write('\x1b[?25h\x1b[?1049l');
    if (events.length) output.write(events.slice(-3).join('\n') + '\n');
  };
  // Не меняем обработку остановки Ralph: восстанавливаем экран и повторно
  // отправляем сигнал после удаления своего обработчика.
  const interrupt = () => { close(); lifecycle.kill(lifecycle.pid, 'SIGINT'); };
  const terminate = () => { close(); lifecycle.kill(lifecycle.pid, 'SIGTERM'); };
  const timer = setInterval(draw, 1000);
  timer.unref();
  output.on('resize', draw);
  lifecycle.on('exit', close);
  lifecycle.on('SIGINT', interrupt);
  lifecycle.on('SIGTERM', terminate);
  output.write('\x1b[?1049h\x1b[?25l');
  draw();
  return {
    log(level, text) {
      const stamp = new Date().toLocaleTimeString('ru-RU', { hour12: false });
      for (const line of String(text).split(/\r?\n/u)) {
        if (line.trim()) events.push(`${stamp} ${level === 'ERROR' ? 'Ошибка: ' : ''}${clean(line).slice(0, 2000)}`);
      }
      events.splice(0, Math.max(0, events.length - 100));
      draw();
    },
    close,
  };
}
