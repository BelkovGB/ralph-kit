/**
 * HTML-страница GUI: одна строка со встроенными стилями и скриптом.
 *
 * Страница не делает ни одного внешнего запроса — ни шрифтов, ни библиотек,
 * ни картинок: сервер поднимается на localhost и должен работать без сети.
 * Данные страница берёт сама через fetch к /api/*, подставляя токен в
 * заголовок `x-ralph-token`.
 *
 * Клиентский скрипт строит DOM через createElement и textContent и нигде не
 * пишет innerHTML: значения приходят из файлов конфигурации и журнала и могут
 * содержать угловые скобки.
 */

// Единственное место, где в разметку попадают данные: токен уходит в JS-литерал.
// Экранируются и угловые скобки, иначе значение вида "</script>" закрыло бы тег.
function scriptLiteral(value) {
  return JSON.stringify(String(value ?? ''))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

const styles = `
:root {
  color-scheme: light;
  --bg: #fcfcfc;
  --surface: #ffffff;
  --subtle: #f6f7f8;
  --hover: #f2f3f5;
  --text: #15171c;
  --muted: #6b727c;
  --border: #e6e8eb;
  --border-strong: #d6d9de;
  --accent: #2f6fd0;
  --ok: #1e7a45;
  --bad: #b32d24;
  --warn: #9a5b12;
  --bar-1: #98a0a9;
  --bar-2: #c2c8ce;
  --bar-3: #e1e4e8;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #17191c;
    --surface: #1d2024;
    --subtle: #212529;
    --hover: #262a2f;
    --text: #e7e9ec;
    --muted: #99a0a9;
    --border: #2c3036;
    --border-strong: #3a3f46;
    --accent: #6ea3ef;
    --ok: #5cb47c;
    --bad: #e0796e;
    --warn: #d0a05a;
    --bar-1: #7d858e;
    --bar-2: #565d65;
    --bar-3: #383d44;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
}

a { color: var(--accent); }

.shell {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 24px 48px;
}

/* Шапка */
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 18px 0 0;
}

.brand {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.tabs { display: flex; gap: 4px; }

.tab {
  appearance: none;
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  padding: 6px 10px;
}

.tab:hover { color: var(--text); }

.tab[aria-selected='true'] {
  color: var(--text);
  border-bottom-color: var(--accent);
}

/* Полоса состояния: высота фиксирована, чтобы опрос не дёргал вёрстку */
.status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  margin-top: 12px;
  padding: 0 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--muted);
}

.dot.is-running { background: var(--ok); }
.dot.is-stale { background: var(--warn); }

.status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel { margin-top: 24px; }

/* Сводка расхода */
.summary {
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.summary-line {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.summary-total { font-size: 20px; font-weight: 600; }
.summary-counts { color: var(--muted); }

.note {
  margin-top: 6px;
  color: var(--muted);
  font-size: 12px;
}

/* Таблица задач */
.table-wrap {
  margin-top: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  /* На узком экране таблица прокручивается внутри себя, а не растягивает страницу. */
  overflow-x: auto;
}

table { width: 100%; border-collapse: collapse; }
/* Колонки задач не переносятся, чтобы числа не расползались на две строки. */
.tasks th, .tasks td { white-space: nowrap; }
.tasks td:nth-child(2), .tasks td.detail-cell { white-space: normal; }

th {
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  text-align: left;
}

td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

tr:last-child td { border-bottom: 0; }

.num { text-align: right; }

.task-row { cursor: pointer; }
.task-row:hover td { background: var(--hover); }
.task-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

.task-id { font-weight: 500; }

.marker {
  display: inline-block;
  width: 12px;
  color: var(--muted);
}

.bad { color: var(--bad); }
.ok { color: var(--ok); }

.detail-cell { background: var(--subtle); padding: 4px 12px 14px; }

.run {
  padding: 12px 0 2px;
  border-top: 1px solid var(--border);
}

.run:first-child { border-top: 0; }

.run-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.run-title { font-weight: 500; }
.run-meta { color: var(--muted); font-size: 13px; }

/* Полоска стадий: три div с процентной шириной */
.bar {
  display: flex;
  height: 6px;
  margin: 8px 0 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--border);
}

.bar-seg { height: 100%; }
.bar-seg.s1 { background: var(--bar-1); }
.bar-seg.s2 { background: var(--bar-2); }
.bar-seg.s3 { background: var(--bar-3); }

.legend { color: var(--muted); font-size: 12px; }

.agents { margin-top: 8px; }

.agent {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 3px 0;
  font-size: 13px;
}

.agent-right { color: var(--muted); white-space: nowrap; }

.empty {
  margin-top: 16px;
  padding: 24px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--muted);
  text-align: center;
}

/* Настройки */
.banner {
  padding: 10px 12px;
  background: var(--subtle);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
}

.banner-title { font-weight: 600; }
.banner-text { color: var(--muted); font-size: 13px; }

.section { margin-top: 28px; }

.section-title {
  margin: 0 0 2px;
  font-size: 15px;
  font-weight: 600;
}

.section-rule {
  height: 1px;
  margin-bottom: 14px;
  background: var(--border);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 24px;
}

@media (max-width: 720px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
  .shell { padding: 0 16px 48px; }
}

.field.is-wide { grid-column: 1 / -1; }

.field-label {
  display: block;
  margin-bottom: 4px;
  font-size: 13px;
  font-weight: 500;
}

.field-hint {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}

input[type='text'],
input[type='number'],
select,
textarea {
  width: 100%;
  padding: 6px 8px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font: inherit;
  font-variant-numeric: tabular-nums;
}

textarea { min-height: 92px; resize: vertical; }

input:focus-visible,
select:focus-visible,
textarea:focus-visible,
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

input:disabled,
select:disabled,
textarea:disabled { color: var(--muted); background: var(--subtle); }

.check { display: flex; align-items: center; gap: 8px; }
.check input { width: auto; }

.phases { width: 100%; border-collapse: collapse; }
.phases th { padding: 4px 8px 4px 0; }
.phases td { padding: 4px 8px 4px 0; border-bottom: 0; }
.phases td:last-child, .phases th:last-child { padding-right: 0; width: 1%; }

.btn {
  padding: 6px 12px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}

.btn:hover:not(:disabled) { background: var(--hover); }
.btn:disabled { color: var(--muted); cursor: default; }

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}

.btn-primary:hover:not(:disabled) { background: var(--accent); opacity: 0.9; }
.btn-primary:disabled { background: var(--subtle); border-color: var(--border); color: var(--muted); }

.btn-small { padding: 3px 9px; font-size: 13px; }

.unknown-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 5px 0;
  border-bottom: 1px solid var(--border);
}

.unknown-row:last-child { border-bottom: 0; }
.unknown-value { color: var(--muted); overflow-wrap: anywhere; }

.savebar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 28px;
  padding: 12px 0;
  background: var(--bg);
  border-top: 1px solid var(--border);
}

.save-message { font-size: 13px; }
.save-message.is-ok { color: var(--ok); }
.save-message.is-bad { color: var(--bad); }
`;

const markup = `
<div class="shell">
  <header class="top">
    <div class="brand">Ralph</div>
    <nav class="tabs" role="tablist" aria-label="Разделы">
      <button class="tab" type="button" role="tab" id="tab-usage" data-tab="usage" aria-selected="true">Расход</button>
      <button class="tab" type="button" role="tab" id="tab-settings" data-tab="settings" aria-selected="false">Настройки</button>
    </nav>
  </header>
  <div class="status">
    <span class="dot" id="status-dot"></span>
    <span class="status-text" id="status-text">Состояние загружается</span>
  </div>
  <main class="panel" id="panel" role="tabpanel" aria-labelledby="tab-usage"></main>
</div>
`;

// Клиентский скрипт. Внутри нет шаблонных литералов и обратных кавычек:
// строка целиком лежит в шаблонном литерале модуля.
const script = `
(function () {
  'use strict';

  var token = window.__RALPH_TOKEN__ || '';
  var tab = 'usage';
  var stateData = null;
  var tasksData = null;
  var tasksError = '';
  var configData = null;
  var configError = '';
  var draft = null;
  var baseline = '';
  var saveMessage = null;
  var saving = false;
  var expanded = Object.create(null);
  var lastLocked = null;

  var panel = document.getElementById('panel');
  var statusDot = document.getElementById('status-dot');
  var statusText = document.getElementById('status-text');

  /* --- запросы --- */

  function api(path, options) {
    var opts = options || {};
    var headers = { 'x-ralph-token': token };
    if (opts.body) headers['content-type'] = 'application/json';
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body
    }).then(function (res) {
      return res
        .json()
        .catch(function () { return {}; })
        .then(function (body) { return { status: res.status, ok: res.ok, body: body }; });
    });
  }

  /* --- форматирование --- */

  function plural(n, one, few, many) {
    var a = Math.abs(Math.round(n)) % 100;
    var b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function num(value, digits) {
    var n = Number(value) || 0;
    return n.toLocaleString('ru-RU', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits || 0
    });
  }

  function money(value) {
    return num(Number(value) || 0, 2) + ' $';
  }

  function tokensOf(value) {
    if (typeof value === 'number') return value;
    if (value && typeof value === 'object') {
      var sum = 0;
      Object.keys(value).forEach(function (key) {
        if (typeof value[key] === 'number') sum += value[key];
      });
      return sum;
    }
    return 0;
  }

  function tokens(value) {
    var n = tokensOf(value);
    if (n >= 1000000) return num(n / 1000000, 1) + ' млн';
    if (n >= 10000) return num(n / 1000, 0) + ' тыс.';
    return num(n, 0);
  }

  function duration(ms) {
    var total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (total < 60) return total + ' с';
    var minutes = Math.round(total / 60);
    if (minutes < 60) return minutes + ' мин';
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return rest ? hours + ' ч ' + rest + ' мин' : hours + ' ч';
  }

  function hours(ms) {
    return num((Number(ms) || 0) / 3600000, 1) + ' ч';
  }

  function parseDate(value) {
    if (!value) return null;
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  function clock(value) {
    var date = parseDate(value);
    if (!date) return '';
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function stamp(value) {
    var date = parseDate(value);
    if (!date) return '';
    return date.toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  /* Семь верхних значений — те, что Ralph реально пишет в журнал попыток;
     остальные оставлены на случай чужого журнала. Незнакомое значение
     показывается как есть. */
  var outcomeWords = {
    completed: 'успех',
    'review-failed': 'ревью не пропустило',
    'validation-failed': 'проверки не прошли',
    'agent-failed': 'агент не справился',
    RALPH_COMMAND_FAILED: 'упала команда',
    RALPH_AGENT_AUTH: 'нет авторизации',
    aborted: 'обрыв',
    success: 'успех',
    ok: 'успех',
    done: 'успех',
    passed: 'успех',
    failure: 'провал',
    failed: 'провал',
    error: 'ошибка',
    blocked: 'блок',
    timeout: 'таймаут',
    skipped: 'пропуск',
    cancelled: 'отмена',
    canceled: 'отмена'
  };

  var successOutcomes = { success: 1, ok: 1, done: 1, completed: 1, passed: 1 };

  function outcomeWord(value) {
    if (!value) return '—';
    return outcomeWords[String(value)] || String(value);
  }

  function isSuccess(value) {
    return !!successOutcomes[String(value)];
  }

  var phaseWords = {
    implementation: 'реализация',
    validation: 'проверка',
    review: 'ревью',
    code: 'реализация'
  };

  function phaseWord(value) {
    if (!value) return '';
    return phaseWords[String(value)] || String(value);
  }

  var roleWords = {
    implementation: 'реализация',
    validation: 'проверка',
    review: 'ревью',
    milestoneReview: 'ревью вехи',
    summary: 'итог'
  };

  function roleWord(value) {
    if (!value) return 'агент';
    return roleWords[String(value)] || String(value);
  }

  /* --- DOM --- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* --- полоса состояния --- */

  function statusLine(data) {
    if (!data) return 'Состояние загружается';
    if (data.staleLock && !data.running) return 'Остался лок от упавшего прогона';
    var run = data.run;
    if (!data.running || !run) return 'Прогона нет';
    var parts = [];
    if (run.issueNumber) parts.push('Задача #' + run.issueNumber);
    var phase = phaseWord(run.issuePhase);
    if (phase) parts.push(phase);
    if (run.branch) parts.push('ветка ' + run.branch);
    if (typeof run.phaseIndex === 'number' && run.phaseCount) {
      parts.push('фаза ' + (run.phaseIndex + 1) + ' из ' + run.phaseCount);
    }
    if (run.maxIterations) {
      parts.push('попытка ' + (run.iterationsUsed || 0) + ' из ' + run.maxIterations);
    }
    var started = parseDate(run.startedAt);
    if (started) {
      var ms = Date.now() - started.getTime();
      parts.push(ms < 60000 ? 'идёт меньше минуты' : 'идёт ' + duration(ms));
    }
    return parts.length ? parts.join(' · ') : 'Идёт прогон';
  }

  function renderStatus() {
    statusText.textContent = statusLine(stateData);
    var running = !!(stateData && stateData.running);
    var stale = !!(stateData && stateData.staleLock && !running);
    statusDot.className = 'dot' + (running ? ' is-running' : stale ? ' is-stale' : '');
  }

  function loadState() {
    return api('/api/state').then(function (res) {
      if (!res.ok) return;
      stateData = res.body;
      renderStatus();
      var locked = !!stateData.running;
      if (lastLocked !== null && lastLocked !== locked && tab === 'settings' && !isDirty()) {
        loadConfig();
      }
      lastLocked = locked;
    }).catch(function () {});
  }

  /* --- вкладка «Расход» --- */

  function loadTasks() {
    return api('/api/tasks').then(function (res) {
      if (!res.ok) {
        tasksError = (res.body && res.body.error) || 'Не удалось прочитать журнал расхода';
        tasksData = null;
      } else {
        tasksError = '';
        tasksData = res.body;
      }
      if (tab === 'usage') renderPanel();
    }).catch(function () {
      tasksError = 'Не удалось прочитать журнал расхода';
      if (tab === 'usage') renderPanel();
    });
  }

  function stageMs(value) {
    if (typeof value === 'number') return value;
    if (value && typeof value === 'object') {
      return Number(value.wallMs || value.ms || value.durationMs || 0) || 0;
    }
    return 0;
  }

  function renderBar(stages) {
    var s = stages || {};
    var parts = [
      { cls: 's1', label: 'код', ms: stageMs(s.implementation) },
      { cls: 's2', label: 'проверки', ms: stageMs(s.validation) },
      { cls: 's3', label: 'ревью', ms: stageMs(s.review) }
    ];
    var total = parts[0].ms + parts[1].ms + parts[2].ms;
    if (total <= 0) return null;
    var box = document.createDocumentFragment();
    var bar = el('div', 'bar');
    var legend = [];
    parts.forEach(function (part) {
      if (part.ms <= 0) return;
      var seg = el('div', 'bar-seg ' + part.cls);
      seg.style.width = ((part.ms / total) * 100).toFixed(2) + '%';
      seg.title = part.label + ' ' + duration(part.ms);
      bar.appendChild(seg);
      legend.push(part.label + ' ' + duration(part.ms));
    });
    box.appendChild(bar);
    box.appendChild(el('div', 'legend', legend.join(' · ')));
    return box;
  }

  function renderRun(run) {
    var box = el('div', 'run');
    var head = el('div', 'run-head');
    head.appendChild(el('span', 'run-title', 'Попытка ' + (run.iteration || '—')));
    var when = [];
    var from = clock(run.startedAt);
    var to = clock(run.finishedAt);
    if (from) when.push(to ? from + ' → ' + to : from);
    if (run.wallMs) when.push(duration(run.wallMs));
    if (run.agentCli) when.push(run.agentCli);
    if (when.length) head.appendChild(el('span', 'run-meta', when.join(' · ')));
    head.appendChild(
      el('span', isSuccess(run.outcome) ? '' : 'bad', outcomeWord(run.outcome))
    );
    box.appendChild(head);

    if (run.reason) box.appendChild(el('div', 'run-meta', run.reason));

    var bar = renderBar(run.stages);
    if (bar) box.appendChild(bar);

    var agents = Array.isArray(run.agents) ? run.agents : [];
    if (agents.length) {
      var list = el('div', 'agents');
      agents.forEach(function (agent) {
        var row = el('div', 'agent');
        var left = [roleWord(agent.role)];
        var models = Array.isArray(agent.models) ? agent.models : agent.models ? [agent.models] : [];
        if (models.length) left.push(models.join(', '));
        if (agent.turns) left.push(agent.turns + ' ' + plural(agent.turns, 'ход', 'хода', 'ходов'));
        row.appendChild(el('span', '', left.join(' · ')));
        var right = [];
        if (tokensOf(agent.tokens)) right.push(tokens(agent.tokens));
        right.push(money(agent.costUsd));
        row.appendChild(el('span', 'agent-right', right.join(' · ')));
        list.appendChild(row);
      });
      box.appendChild(list);
    }
    return box;
  }

  function renderUsage() {
    var frag = document.createDocumentFragment();

    if (tasksError) {
      frag.appendChild(el('div', 'empty', tasksError));
      return frag;
    }
    if (!tasksData) {
      frag.appendChild(el('div', 'empty', 'Данные загружаются'));
      return frag;
    }

    var totals = tasksData.totals || {};
    var period = tasksData.period || {};
    var tasks = Array.isArray(tasksData.tasks) ? tasksData.tasks : [];

    var summary = el('div', 'summary');
    var line = el('div', 'summary-line');
    line.appendChild(el('span', 'summary-total', money(totals.costUsd)));
    var counts = [
      num(totals.tasks) + ' ' + plural(totals.tasks, 'задача', 'задачи', 'задач'),
      num(totals.attempts) + ' ' + plural(totals.attempts, 'попытка', 'попытки', 'попыток'),
      hours(totals.wallMs)
    ];
    if (tokensOf(totals.tokens)) counts.push(tokens(totals.tokens) + ' токенов');
    line.appendChild(el('span', 'summary-counts', counts.join(' · ')));
    summary.appendChild(line);

    if (period.fromIso || period.toIso) {
      summary.appendChild(
        el('div', 'note', 'Период: ' + (stamp(period.fromIso) || '—') + ' — ' + (stamp(period.toIso) || '—'))
      );
    }
    var warn = 'Ревью вехи в расход не попадает.';
    if (period.maxStored) {
      warn +=
        ' Журнал хранит последние ' +
        num(period.maxStored) +
        ' ' +
        plural(period.maxStored, 'попытку', 'попытки', 'попыток') +
        ', сейчас записано ' +
        num(period.storedAttempts || 0) +
        '.';
    }
    summary.appendChild(el('div', 'note', warn));
    frag.appendChild(summary);

    if (!tasks.length) {
      frag.appendChild(el('div', 'empty', 'Прогонов ещё не было'));
      return frag;
    }

    var wrap = el('div', 'table-wrap');
    var table = el('table', 'tasks');
    var thead = el('thead');
    var headRow = el('tr');
    [
      ['Задача', ''],
      ['Веха', ''],
      ['Попытки', 'num'],
      ['Исход', ''],
      ['Время', 'num'],
      ['Токены', 'num'],
      ['Стоимость', 'num']
    ].forEach(function (column) {
      headRow.appendChild(el('th', column[1], column[0]));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    tasks.forEach(function (task) {
      var key = String(task.issue);
      var open = !!expanded[key];
      var row = el('tr', 'task-row');
      row.tabIndex = 0;
      row.setAttribute('aria-expanded', open ? 'true' : 'false');

      var first = el('td', 'task-id');
      first.appendChild(el('span', 'marker', open ? '−' : '+'));
      first.appendChild(document.createTextNode('#' + (task.issue !== undefined ? task.issue : '—')));
      row.appendChild(first);
      row.appendChild(el('td', '', task.milestone || '—'));
      row.appendChild(el('td', 'num', num(task.attempts)));

      var outcomeCell = el('td', isSuccess(task.lastOutcome) ? '' : 'bad', outcomeWord(task.lastOutcome));
      if (task.lastReason) outcomeCell.title = String(task.lastReason);
      row.appendChild(outcomeCell);

      row.appendChild(el('td', 'num', duration(task.wallMs)));
      row.appendChild(el('td', 'num', tokens(task.tokens)));
      row.appendChild(el('td', 'num', money(task.costUsd)));

      function toggle() {
        if (expanded[key]) delete expanded[key];
        else expanded[key] = true;
        renderPanel();
      }

      row.addEventListener('click', toggle);
      row.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      });
      tbody.appendChild(row);

      if (open) {
        var detailRow = el('tr');
        var cell = el('td', 'detail-cell');
        cell.colSpan = 7;
        var runs = Array.isArray(task.runs) ? task.runs : [];
        if (!runs.length) {
          cell.appendChild(el('div', 'run-meta', 'Попыток не записано'));
        } else {
          runs.forEach(function (run) { cell.appendChild(renderRun(run)); });
        }
        detailRow.appendChild(cell);
        tbody.appendChild(detailRow);
      }
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    frag.appendChild(wrap);
    return frag;
  }

  /* --- вкладка «Настройки» --- */

  function loadConfig() {
    return api('/api/config').then(function (res) {
      if (!res.ok) {
        configError = (res.body && res.body.error) || 'Не удалось прочитать конфигурацию';
        configData = null;
      } else {
        configError = '';
        configData = res.body;
        draft = clone(configData.config || {});
        baseline = JSON.stringify(draft);
        saveMessage = null;
      }
      if (tab === 'settings') renderPanel();
    }).catch(function () {
      configError = 'Не удалось прочитать конфигурацию';
      if (tab === 'settings') renderPanel();
    });
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function isDirty() {
    return !!draft && JSON.stringify(draft) !== baseline;
  }

  function getPath(source, path) {
    var parts = String(path).split('.');
    var node = source;
    for (var i = 0; i < parts.length; i += 1) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[parts[i]];
    }
    return node;
  }

  function setPath(target, path, value) {
    var parts = String(path).split('.');
    var node = target;
    for (var i = 0; i < parts.length - 1; i += 1) {
      if (node[parts[i]] === null || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }

  // Описание полей приходит с сервера. Форма описания приводится к одному виду
  // здесь, чтобы страница пережила и массив секций, и плоский список полей.
  function normalizeGroups(fields) {
    var source = fields;
    if (source && !Array.isArray(source) && typeof source === 'object') {
      if (Array.isArray(source.groups)) source = source.groups;
      else if (Array.isArray(source.fieldGroups)) source = source.fieldGroups;
      else if (Array.isArray(source.fields)) source = source.fields;
      else {
        source = Object.keys(source).map(function (title) {
          return { title: title, fields: source[title] };
        });
      }
    }
    if (!Array.isArray(source)) return [];
    var isGrouped = source.some(function (item) {
      return item && Array.isArray(item.fields);
    });
    if (isGrouped) {
      return source.map(function (group) {
        return {
          title: group.title || group.label || group.name || 'Настройки',
          fields: (group.fields || []).map(normalizeField)
        };
      });
    }
    var order = [];
    var byTitle = Object.create(null);
    source.forEach(function (item) {
      var field = normalizeField(item);
      var title = item.group || item.section || 'Настройки';
      if (!byTitle[title]) {
        byTitle[title] = { title: title, fields: [] };
        order.push(byTitle[title]);
      }
      byTitle[title].fields.push(field);
    });
    return order;
  }

  function normalizeField(item) {
    var source = item || {};
    var path = source.path || source.key || source.name || '';
    var type = source.type || '';
    if (!type) {
      var value = draft ? getPath(draft, path) : undefined;
      if (path === 'phases') type = 'phases';
      else if (typeof value === 'boolean') type = 'boolean';
      else if (typeof value === 'number') type = 'number';
      else if (Array.isArray(value)) type = 'list';
      else type = 'text';
    }
    if (type === 'string') type = 'text';
    if (type === 'checkbox') type = 'boolean';
    return {
      path: path,
      label: source.label || source.title || path,
      type: type,
      hint: source.hint || source.help || source.description || source.note || '',
      options: source.options || null,
      optionsBy:
        source.optionsBy || source.optionsByAgentCli || source.optionsFor || source.agentOptions || null,
      min: source.min,
      max: source.max,
      step: source.step
    };
  }

  function optionList(field) {
    var raw = field.options;
    if (field.optionsBy) {
      var agent = draft ? getPath(draft, 'agentCli') : '';
      raw = field.optionsBy[agent] || field.optionsBy['*'] || [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.map(function (option) {
      if (option && typeof option === 'object') {
        return { value: String(option.value), label: String(option.label || option.value) };
      }
      return { value: String(option), label: String(option) };
    });
  }

  function markChanged() {
    var button = document.getElementById('save-button');
    if (button) button.disabled = !isDirty() || saving || isLocked();
    saveMessage = null;
    var message = document.getElementById('save-message');
    if (message) {
      message.textContent = '';
      message.className = 'save-message';
    }
  }

  function isLocked() {
    return !!(configData && configData.locked);
  }

  function renderField(field) {
    var box = el('div', 'field');
    var wide = field.type === 'phases' || field.type === 'list';
    if (wide) box.className = 'field is-wide';

    var value = draft ? getPath(draft, field.path) : undefined;
    var locked = isLocked();

    if (field.type === 'boolean') {
      var check = el('label', 'check');
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value === true;
      input.disabled = locked;
      input.addEventListener('change', function () {
        setPath(draft, field.path, input.checked);
        markChanged();
      });
      check.appendChild(input);
      check.appendChild(el('span', '', field.label));
      box.appendChild(check);
      if (field.hint) box.appendChild(el('div', 'field-hint', field.hint));
      return box;
    }

    var label = el('label', 'field-label', field.label);
    box.appendChild(label);

    if (field.type === 'select') {
      var select = document.createElement('select');
      select.disabled = locked;
      var options = optionList(field);
      var current = value === undefined || value === null ? '' : String(value);
      var known = false;
      options.forEach(function (option) {
        var node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        if (option.value === current) known = true;
        select.appendChild(node);
      });
      if (!known) {
        var extra = document.createElement('option');
        extra.value = current;
        extra.textContent = current || '—';
        select.insertBefore(extra, select.firstChild);
      }
      select.value = current;
      select.addEventListener('change', function () {
        setPath(draft, field.path, select.value);
        markChanged();
        // Значения зависимых селектов зависят от agentCli: перерисовываем секции.
        if (field.path === 'agentCli') renderPanel();
      });
      label.appendChild(select);
    } else if (field.type === 'list') {
      var area = document.createElement('textarea');
      area.disabled = locked;
      area.value = Array.isArray(value) ? value.join('\\n') : value === undefined ? '' : String(value);
      area.addEventListener('input', function () {
        var lines = area.value.split('\\n').map(function (line) { return line.trim(); });
        setPath(draft, field.path, lines.filter(function (line) { return line !== ''; }));
        markChanged();
      });
      label.appendChild(area);
      if (!field.hint) field.hint = 'Одна строка — одна команда.';
    } else if (field.type === 'phases') {
      label.appendChild(renderPhases(field, Array.isArray(value) ? value : []));
    } else {
      var text = document.createElement('input');
      text.type = field.type === 'number' ? 'number' : 'text';
      if (field.min !== undefined) text.min = field.min;
      if (field.max !== undefined) text.max = field.max;
      if (field.step !== undefined) text.step = field.step;
      text.disabled = locked;
      text.value = value === undefined || value === null ? '' : String(value);
      text.addEventListener('input', function () {
        if (field.type === 'number') {
          setPath(draft, field.path, text.value === '' ? '' : Number(text.value));
        } else {
          setPath(draft, field.path, text.value);
        }
        markChanged();
      });
      label.appendChild(text);
    }

    if (field.hint) box.appendChild(el('div', 'field-hint', field.hint));
    return box;
  }

  function renderPhases(field, rows) {
    var locked = isLocked();
    var wrap = document.createElement('div');
    var table = el('table', 'phases');
    var head = el('tr');
    ['Веха', 'Ветка', 'База', ''].forEach(function (title) {
      head.appendChild(el('th', '', title));
    });
    var thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    var body = el('tbody');
    rows.forEach(function (row, index) {
      var tr = el('tr');
      [
        ['milestone', 'Веха'],
        ['branch', 'Ветка'],
        ['baseBranch', 'База']
      ].forEach(function (column) {
        var td = el('td');
        var input = document.createElement('input');
        input.type = 'text';
        input.disabled = locked;
        input.setAttribute('aria-label', column[1] + ', строка ' + (index + 1));
        input.value = row && row[column[0]] !== undefined && row[column[0]] !== null ? String(row[column[0]]) : '';
        input.addEventListener('input', function () {
          var list = getPath(draft, field.path);
          if (!Array.isArray(list)) return;
          if (!list[index] || typeof list[index] !== 'object') list[index] = {};
          list[index][column[0]] = input.value;
          markChanged();
        });
        td.appendChild(input);
        tr.appendChild(td);
      });
      var actions = el('td');
      var remove = el('button', 'btn btn-small', 'Удалить');
      remove.type = 'button';
      remove.disabled = locked;
      remove.addEventListener('click', function () {
        var list = getPath(draft, field.path);
        if (!Array.isArray(list)) return;
        list.splice(index, 1);
        renderPanel();
      });
      actions.appendChild(remove);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
    table.appendChild(body);
    wrap.appendChild(table);

    var add = el('button', 'btn btn-small', 'Добавить строку');
    add.type = 'button';
    add.disabled = locked;
    add.style.marginTop = '8px';
    add.addEventListener('click', function () {
      var list = getPath(draft, field.path);
      if (!Array.isArray(list)) {
        list = [];
        setPath(draft, field.path, list);
      }
      list.push({ milestone: '', branch: '', baseBranch: '' });
      renderPanel();
    });
    wrap.appendChild(add);
    return wrap;
  }

  function renderUnknown(keys) {
    var section = el('section', 'section');
    section.appendChild(el('h2', 'section-title', 'Не распознано'));
    section.appendChild(el('div', 'section-rule'));
    section.appendChild(
      el('div', 'note', 'Эти ключи GUI не знает и не меняет. При сохранении они запишутся как есть.')
    );
    var box = el('div');
    box.style.marginTop = '8px';
    keys.forEach(function (key) {
      var row = el('div', 'unknown-row');
      row.appendChild(el('span', '', String(key)));
      var value = draft ? getPath(draft, String(key)) : undefined;
      row.appendChild(el('span', 'unknown-value', value === undefined ? '—' : JSON.stringify(value)));
      box.appendChild(row);
    });
    section.appendChild(box);
    return section;
  }

  /* После записи файл стал другим, и прежний отпечаток больше не сходится:
     обновляем его, не трогая правки на экране и сообщение о сохранении. */
  function refreshHash() {
    return api('/api/config').then(function (res) {
      if (res.ok && res.body && configData) configData.hash = res.body.hash;
    }).catch(function () {});
  }

  function save() {
    if (saving || !isDirty()) return;
    saving = true;
    markChanged();
    var button = document.getElementById('save-button');
    if (button) button.disabled = true;
    /* Отпечаток файла, выданный при чтении, уходит обратно: сервер по нему
       видит правку файла мимо пульта и не затирает её молча. */
    var payload = { config: draft };
    if (configData && typeof configData.hash === 'string') payload.hash = configData.hash;
    api('/api/config', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (res) {
        saving = false;
        if (res.ok && res.body && res.body.ok) {
          baseline = JSON.stringify(draft);
          showMessage(
            res.body.warning ? 'bad' : 'ok',
            res.body.warning || 'Сохранено, изменения вступят в силу со следующего прогона.'
          );
          refreshHash();
          loadState();
        } else {
          var text = (res.body && res.body.error) || 'Сохранить не удалось';
          showMessage('bad', text);
          if (res.status === 409) loadConfig();
        }
      })
      .catch(function () {
        saving = false;
        showMessage('bad', 'Сервер не ответил');
      });
  }

  function showMessage(kind, text) {
    saveMessage = { kind: kind, text: text };
    var message = document.getElementById('save-message');
    if (message) {
      message.textContent = text;
      message.className = 'save-message ' + (kind === 'ok' ? 'is-ok' : 'is-bad');
    }
    var button = document.getElementById('save-button');
    if (button) button.disabled = !isDirty() || saving || isLocked();
  }

  function renderSettings() {
    var frag = document.createDocumentFragment();

    if (configError) {
      frag.appendChild(el('div', 'empty', configError));
      return frag;
    }
    if (!configData || !draft) {
      frag.appendChild(el('div', 'empty', 'Данные загружаются'));
      return frag;
    }

    if (isLocked()) {
      var banner = el('div', 'banner');
      banner.appendChild(el('div', 'banner-title', 'Идёт прогон, настройки заблокированы'));
      banner.appendChild(
        el(
          'div',
          'banner-text',
          configData.lockReason ||
            'Правка файла во время прогона обрывает работу текущей задачи, поэтому сохранение доступно только между прогонами.'
        )
      );
      frag.appendChild(banner);
    }

    var groups = normalizeGroups(configData.fields);
    if (!groups.length) {
      frag.appendChild(el('div', 'empty', 'Описание полей не пришло с сервера'));
    }
    groups.forEach(function (group) {
      var section = el('section', 'section');
      section.appendChild(el('h2', 'section-title', group.title));
      section.appendChild(el('div', 'section-rule'));
      var grid = el('div', 'grid');
      group.fields.forEach(function (field) {
        grid.appendChild(renderField(field));
      });
      section.appendChild(grid);
      frag.appendChild(section);
    });

    var unknown = Array.isArray(configData.unknownKeys) ? configData.unknownKeys : [];
    if (unknown.length) frag.appendChild(renderUnknown(unknown));

    var bar = el('div', 'savebar');
    var button = el('button', 'btn btn-primary', 'Сохранить');
    button.type = 'button';
    button.id = 'save-button';
    button.disabled = !isDirty() || saving || isLocked();
    button.addEventListener('click', save);
    bar.appendChild(button);
    var message = el('span', 'save-message');
    message.id = 'save-message';
    if (saveMessage) {
      message.textContent = saveMessage.text;
      message.className = 'save-message ' + (saveMessage.kind === 'ok' ? 'is-ok' : 'is-bad');
    }
    bar.appendChild(message);
    frag.appendChild(bar);
    return frag;
  }

  /* --- переключение вкладок --- */

  function renderPanel() {
    clear(panel);
    panel.setAttribute('aria-labelledby', tab === 'usage' ? 'tab-usage' : 'tab-settings');
    panel.appendChild(tab === 'usage' ? renderUsage() : renderSettings());
  }

  function selectTab(next) {
    tab = next;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (button) {
      button.setAttribute('aria-selected', button.getAttribute('data-tab') === tab ? 'true' : 'false');
    });
    if (tab === 'usage' && !tasksData && !tasksError) loadTasks();
    if (tab === 'settings' && (!configData || !isDirty())) loadConfig();
    renderPanel();
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (button) {
    button.addEventListener('click', function () {
      selectTab(button.getAttribute('data-tab'));
    });
  });

  renderStatus();
  renderPanel();
  loadState();
  loadTasks();
  setInterval(loadState, 5000);
})();
`;

export function renderPage(options = {}) {
  const token = options.token ?? '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Ralph</title>
<style>${styles}</style>
</head>
<body>
${markup}
<script>window.__RALPH_TOKEN__ = ${scriptLiteral(token)};</script>
<script>${script}</script>
</body>
</html>
`;
}
