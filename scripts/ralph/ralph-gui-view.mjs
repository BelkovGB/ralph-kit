/**
 * Логика вида пульта: форматтеры, словари подписей и расчёты карточки хода.
 *
 * Файл служит двум читателям сразу. Тесты импортируют его как обычный модуль,
 * а страница пульта вклеивает его исходник в клиентский скрипт при сборке —
 * поэтому здесь нет import, обращений к document и window, а стиль совпадает с
 * шаблоном страницы: var и function, синтаксис не выше ES5.
 *
 * Экспорт собран одной строкой в конце файла намеренно: сканер владельцев
 * функций в тестах control plane собирает имена по "export function", и
 * пофункционный экспорт объявил бы вклеенные в страницу вызовы чужими.
 */

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

/* Доля, которая округлилась бы в ноль, пишется как «<1%»: ноль рядом с
   непустым числом читается как «ничего», а «1%» завысил бы её в разы. */
function share(part, total) {
  if (!total) return '';
  var percent = ((Number(part) || 0) / total) * 100;
  return percent > 0 && percent < 0.5 ? '<1%' : num(percent, 0) + '%';
}

/* Пять видов токенов не пересекаются и в сумме дают весь объём. Порядок —
   путь текста через модель: сначала то, что агент загрузил, потом то, что
   написал сам. */
var tokenKinds = [
  ['cacheRead', 'чтение кэша'],
  ['cacheCreation', 'запись в кэш'],
  ['uncachedInput', 'новый текст'],
  ['reasoning', 'рассуждения'],
  ['answer', 'ответ']
];

function kindSum(value, keys) {
  var t = value || {};
  return keys.reduce(function (sum, key) { return sum + (Number(t[key]) || 0); }, 0);
}

function loadedTokens(value) {
  return kindSum(value, ['cacheRead', 'cacheCreation', 'uncachedInput']);
}

function writtenTokens(value) {
  return kindSum(value, ['reasoning', 'answer']);
}

/* Вид с нулём пропускается: строка и так длинная, а ноль ничего не решает. */
function tokenKindList(value, withShare) {
  var t = value || {};
  var total = tokensOf(t);
  var parts = tokenKinds
    .map(function (kind) { return { label: kind[1], value: Number(t[kind[0]]) || 0 }; })
    .filter(function (part) { return part.value > 0; });
  if (withShare) parts.sort(function (a, b) { return b.value - a.value; });
  return parts.map(function (part) {
    var percent = withShare ? ' · ' + share(part.value, total) : '';
    return part.label + ' ' + tokens(part.value) + percent;
  });
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

var successOutcomes = { completed: 1 };

/* Ни успех, ни провал: issue цела, но ждёт решения человека. Красный тут
   соврал бы — работа не потеряна и не сломана. */
var pendingOutcomes = { 'review-parked': 1, 'iteration-limit': 1 };

function outcomeWord(words, value) {
  if (!value) return '—';
  return words[String(value)] || String(value);
}

function isSuccess(value) {
  return !!successOutcomes[String(value)];
}

/* Класс ячейки исхода: зелёный по умолчанию не ставится, красный — только на
   то, что действительно провалилось. */
function outcomeClass(value) {
  if (isSuccess(value)) return '';
  if (pendingOutcomes[String(value)]) return 'warn';
  if (String(value) === 'milestone-review') return 'muted';
  return 'bad';
}

/* Стадия текущей issue из state.json. Значения выписаны из
   ralph-state-store.mjs: цикл пишет в phase только их. Ключи
   implementation/validation/review сюда не приходят: список из них оставил бы
   полосу состояния с сырым agent-running вместо слов. */
var phaseWords = {
  'agent-running': 'идёт разработка',
  'working-tree': 'правки не закоммичены',
  validating: 'идут проверки',
  staging: 'Ralph готовит коммит',
  committed: 'коммит сделан',
  pushed: 'ветка отправлена',
  reviewing: 'идёт ревью',
  'review-failed': 'ревью вернуло замечания'
};

function phaseWord(value) {
  if (!value) return '';
  return phaseWords[String(value)] || String(value);
}

/* Метрики пишут три роли: development, review и milestone-review. Остальные
   оставлены на случай чужого журнала. */
var roleWords = {
  development: 'разработка',
  implementation: 'разработка',
  validation: 'проверка',
  review: 'ревью',
  'milestone-review': 'ревью milestone',
  summary: 'итог'
};

function roleWord(value) {
  if (!value) return 'агент';
  return roleWords[String(value)] || String(value);
}

/* Запись без номера issue — ревью milestone: цикл пишет его отдельной
   строкой, потому что оно оплачено прогоном, а не какой-то одной issue. */
function isReviewRow(task) {
  return task.issue === null || task.issue === undefined;
}

function cut(text, limit) {
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

function stageMs(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    return Number(value.wallMs || value.ms || value.durationMs || 0) || 0;
  }
  return 0;
}

/* Слепок того, что показывает карточка хода. Отметок времени в нём нет: они
   меняются на каждый опрос, а на экране их не видно. */
function shownStateStamp(data) {
  var run = (data && data.run) || {};
  return [
    data && data.running ? 1 : 0,
    data && data.staleLock ? 1 : 0,
    ((data && data.plannedPhases) || []).join('|'),
    run.milestone,
    run.phaseIndex,
    run.phaseCount,
    run.iterationsUsed,
    run.maxIterations,
    run.issueNumber,
    run.issueTitle,
    run.issuePhase,
    run.turn,
    run.turnLimit,
    run.turnFinished,
    run.validationFixAttempts,
    run.maxTestFixAttempts,
    run.reviewFixAttempts,
    run.maxReviewFixAttempts,
    run.issuesRemaining
  ].join('\u0001');
}

/* Лимит показываем, только когда он известен: «круг 2 из null» хуже, чем
   «круг 2». */
function outOf(value, limit) {
  return typeof limit === 'number' ? num(value) + ' из ' + num(limit) : num(value);
}

/* Счёт задач относится к фазе, пока прогон идёт, и ко всему журналу, когда
   его нет. Смешивать нельзя: «фаза 2 из 3» рядом с числом за все фазы
   читалось бы как счёт этой фазы. */
function progressScope(state, totals, phases) {
  var run = state && state.running ? state.run : null;
  var planned = (state && state.plannedPhases) || [];
  if (run) {
    var current = phases.filter(function (phase) {
      return phase.milestone === run.milestone;
    })[0];
    return {
      title:
        typeof run.phaseIndex === 'number' && run.phaseCount
          ? 'Фаза ' + (run.phaseIndex + 1) + ' из ' + run.phaseCount
          : 'Идёт прогон',
      subtitle: run.milestone || '',
      counters: current || totals,
      note: current ? '' : 'Журнал этой фазы пока пуст: числа ниже — за весь журнал.'
    };
  }
  var started = phases.filter(function (phase) {
    return phase.planned;
  }).length;
  return {
    title: planned.length ? 'Фаз в плане ' + planned.length : 'Прогона нет',
    subtitle: planned.length ? 'в журнале ' + started : '',
    counters: totals,
    note: 'Счёт по всему журналу, а не по одной фазе.'
  };
}

function orderedTasks(rows, taskSort) {
  var list = rows.slice();
  if (taskSort === 'volume') {
    list.sort(function (left, right) {
      return right.tokensTotal - left.tokensTotal;
    });
    /* Ревью milestone — объём всей фазы, а не задачи: по объёму оно иначе
       встаёт первой строкой и читается как самая дорогая issue. */
    return list.filter(isReviewRow).concat(
      list.filter(function (task) {
        return !isReviewRow(task);
      })
    );
  }
  /* Ход работы: по первой попытке. Ревью фазы встаёт в конец само — оно и
     идёт последним. */
  return list.sort(function (left, right) {
    return String(left.firstStartedAt || '').localeCompare(String(right.firstStartedAt || ''));
  });
}

/* Принадлежность задачи фазе. Сравнение как на сервере: там пустая строка
   остаётся пустой строкой, и приведение её к null увело бы задачу мимо своей
   группы. */
function taskBelongsToPhase(task, phase) {
  return (task.milestone === undefined ? null : task.milestone) === phase.milestone;
}

export {
  plural,
  num,
  money,
  tokensOf,
  tokens,
  share,
  kindSum,
  loadedTokens,
  writtenTokens,
  tokenKindList,
  duration,
  hours,
  parseDate,
  clock,
  stamp,
  cut,
  isReviewRow,
  isSuccess,
  outcomeClass,
  outcomeWord,
  phaseWord,
  roleWord,
  stageMs,
  outOf,
  shownStateStamp,
  progressScope,
  orderedTasks,
  taskBelongsToPhase,
};
