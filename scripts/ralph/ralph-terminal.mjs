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

export function terminalSnapshot(store, metrics, startedMs, now = Date.now(), live = {}) {
  const state = store?.state;
  const issue = store?.issue;
  const config = live.phaseConfig ?? {};
  const session = live.session && metrics && live.session.startedMs >= metrics.startedMs ? live.session : null;
  const pair = (value, limit) => `${value ?? '—'}/${limit ?? '—'}`;
  const counters = [];
  if (live.queueProgress) {
    const { completedInRun, remaining, parked } = live.queueProgress;
    counters.push(`Сделано в прогоне фазы: ${completedInRun}`, `В очереди: ${remaining} · отложено: ${parked}`);
  }
  counters.push(`Итерации: ${pair(state?.iterationsUsed, config.maxIterations)}`,
    `Исправления тестов: ${pair(issue?.validationFixAttempts, config.maxTestFixAttempts)}`,
    `Отказы ревью: ${pair(issue ? (issue.reviewFixAttempts ?? 0) : null, config.maxReviewFixAttempts)}`);
  if (session) {
    const end = session.active ? now : session.endedMs;
    counters.push(`Шаги агента: ${pair(session.turns, session.maxTurns)}`,
      `Ответы инструментов: ${session.toolResults}`,
      `Агент: ${duration(end - session.startedMs)} / ${duration(session.timeoutMs)}`);
    if (session.active) counters.push(session.lastEventMs === null
      ? `Первый ответ: ${duration(now - session.startedMs)} / ${duration(session.firstEventTimeoutMs)}`
      : `Без событий: ${duration(now - session.lastEventMs)} / ${duration(session.idleTimeoutMs)}`);
  }
  if (live.network) counters.push(`Сеть${live.network.active ? '' : ', последняя'}: ${pair(live.network.attempt, live.network.attempts)}`);
  if (live.review && metrics && live.review.startedMs >= metrics.startedMs) {
    counters.push(`Запуск ревью${live.review.active ? '' : ', последний'}: ${pair(live.review.attempt, live.review.attempts)}`);
  }
  if (live.operation?.active) counters.push(`Команда: ${duration(now - live.operation.startedMs)} / ${duration(live.operation.timeoutMs)}`);
  return {
    issueKey: issue || metrics?.issue != null ? `${state?.phaseIndex ?? 0}:${issue?.number ?? metrics.issue}`
      : metrics ? `stage:${metrics.startedMs}` : null,
    counters,
    status: store && !state ? 'Завершён' : 'Работает',
    phase: state ? `${store.phaseIndex + 1}/${store.phaseCount}` : '—',
    milestone: state?.milestone,
    issue: issue ? `#${issue.number} ${issue.title}`
      : metrics?.issue != null ? `#${metrics.issue} ${metrics.issueTitle ?? ''}` : undefined,
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
    ...(snapshot.counters ?? [`Итерация фазы: ${snapshot.iteration ?? '—'}`, `Исправлений тестов: ${snapshot.fixes ?? '—'}`]),
    `Сессия задачи: ${snapshot.issueTime ?? '—'}`,
    `Прогон: ${snapshot.runTime ?? '—'}`,
  ];
  const footer = 'Tab лог · Ctrl+C остановить · run.log';
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

export function createTerminal({ output = process.stdout, errorOutput = process.stderr, input = process.stdin,
  lifecycle = process, term = process.env.TERM, snapshot = () => ({}) } = {}) {
  if (!output.isTTY || !errorOutput.isTTY || term === 'dumb' || !output.columns || !output.rows) return null;
  let closed = false;
  const events = [];
  const details = [];
  let logMode = false;
  let scrollTop = null;
  let taskKey = null;
  let taskLabel = '';
  let keyBuffer = '';
  const interactive = input.isTTY && typeof input.setRawMode === 'function';
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  const syncTask = () => {
    const current = snapshot();
    if (current.issueKey != null && current.issueKey !== taskKey) {
      details.length = 0;
      scrollTop = null;
      taskKey = current.issueKey;
      taskLabel = current.issue ?? 'Ревью milestone';
    }
    if (current.issue) taskLabel = current.issue;
    return current;
  };
  const logRows = () => {
    const width = Math.max(1, output.columns - 1);
    return details.flatMap(line => {
      const chunks = [];
      for (let i = 0; i < line.length; i += width) chunks.push(line.slice(i, i + width));
      return chunks.length ? chunks : [''];
    });
  };
  const draw = () => {
    if (closed) return;
    const current = syncTask();
    let frame;
    if (logMode) {
      const lines = logRows();
      const room = Math.max(1, output.rows - 3);
      const bottom = Math.max(0, lines.length - room);
      const top = scrollTop === null ? bottom : Math.min(scrollTop, bottom);
      frame = [`ЛОГ ${taskLabel} · ${scrollTop === null ? 'слежение' : 'просмотр'} · хвост 2000 строк`,
        ...lines.slice(top, top + room), ...Array(Math.max(0, room - lines.slice(top, top + room).length)).fill(''),
        'Tab пульт · PgUp/PgDn листать · End следить · Ctrl+C стоп']
        .slice(0, Math.max(1, output.rows - 1)).map(line => fit(line, Math.max(1, output.columns - 1))).join('\n');
    } else frame = renderTerminal(current, events, output.columns, output.rows);
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
    if (interactive) {
      input.off('data', onKey);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
    }
    output.write('\x1b[?25h\x1b[?1049l');
    if (events.length) output.write(events.slice(-3).join('\n') + '\n');
  };
  // Не меняем обработку остановки Ralph: восстанавливаем экран и повторно
  // отправляем сигнал после удаления своего обработчика.
  const interrupt = () => { close(); lifecycle.kill(lifecycle.pid, 'SIGINT'); };
  const terminate = () => { close(); lifecycle.kill(lifecycle.pid, 'SIGTERM'); };
  const onKey = (chunk) => {
    keyBuffer += chunk.toString();
    const bindings = ['\x1b[5~', '\x1b[6~', '\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~', '\t', '\x03'];
    while (keyBuffer) {
      const key = bindings.find(value => keyBuffer.startsWith(value));
      if (!key) {
        if (bindings.some(value => value.startsWith(keyBuffer))) break;
        keyBuffer = keyBuffer.slice(1);
        continue;
      }
      keyBuffer = keyBuffer.slice(key.length);
      if (key === '\x03') { interrupt(); return; }
      if (key === '\t') logMode = !logMode;
      else if (logMode) {
        const room = Math.max(1, output.rows - 3);
        const bottom = Math.max(0, logRows().length - room);
        if (key === '\x1b[5~') scrollTop = Math.max(0, (scrollTop ?? bottom) - room);
        else if (key === '\x1b[6~') scrollTop = Math.min(bottom, (scrollTop ?? bottom) + room);
        else scrollTop = null;
      }
      draw();
    }
  };
  const timer = setInterval(draw, 1000);
  timer.unref();
  output.on('resize', draw);
  lifecycle.on('exit', close);
  lifecycle.on('SIGINT', interrupt);
  lifecycle.on('SIGTERM', terminate);
  if (interactive) {
    input.setRawMode(true);
    input.on('data', onKey);
    input.resume();
  }
  output.write('\x1b[?1049h\x1b[?25l');
  draw();
  const appendDetail = (text) => {
    syncTask();
    for (const line of String(text).split(/\r?\n/u)) details.push(clean(line).slice(0, 2000));
    const removed = details.splice(0, Math.max(0, details.length - 2000));
    if (scrollTop !== null) {
      const width = Math.max(1, output.columns - 1);
      scrollTop = Math.max(0, scrollTop - removed.reduce((total, line) => total + Math.max(1, Math.ceil(line.length / width)), 0));
    }
  };
  return {
    refresh: draw,
    detail(_level, text) {
      appendDetail(text);
      if (logMode) draw();
    },
    log(level, text) {
      appendDetail(text);
      const stamp = new Date().toLocaleTimeString('ru-RU', { hour12: false });
      const line = String(text).split(/\r?\n/u).find(value => value.trim());
      if (line) events.push(`${stamp} ${level === 'ERROR' ? 'Ошибка: ' : ''}${clean(line).slice(0, 2000)}`);
      events.splice(0, Math.max(0, events.length - 100));
      draw();
    },
    close,
  };
}
