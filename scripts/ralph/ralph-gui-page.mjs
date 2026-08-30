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

import { KIT_VERSION } from './ralph-version.mjs';

// Единственное место, где в разметку попадает значение извне: токен уходит в
// JS-литерал. Экранируются и угловые скобки, иначе значение вида "</script>"
// закрыло бы тег. Версия набора — константа модуля с проверенным форматом,
// экранировать в ней нечего.
function scriptLiteral(value) {
  return JSON.stringify(String(value ?? ''))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

// Тот же экран для константы модуля: JSON уходит в скрипт целым значением.
function jsonLiteral(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * Вкладка «Команды»: вся командная поверхность набора текстом.
 *
 * Третье поле важнее двух первых. Человек ошибается не в том, что команда
 * делает, а в том, чего она не делает: ждёт от `--check` начала работы, а от
 * `/issues` — кода.
 */
export const commandGuide = [
  {
    title: 'В терминале',
    note: 'Команды запускаются из корня репозитория.',
    items: [
      {
        title: 'Проверяет готовность к прогону',
        command: 'node scripts/ralph/ralph-loop.mjs --check',
        does:
          'Проверяет, что стоят git, gh и CLI агента, а конфиг, milestone и ветка сходятся. ' +
          'Печатает версию набора, фазу, репозиторий, milestone и число открытых issues, ветку, ' +
          'чистоту дерева, остаток итераций, лимиты, модели и заголовок следующей issue.',
        when: 'Перед первым прогоном и после каждой правки .agents/ralph.config.json.',
        omits:
          'Ничего не меняет: не переключает ветку, не коммитит, не создаёт issues и pull request. ' +
          'Вход в CLI агента не проверяет — это делает --run. ' +
          'Если текущая ветка не совпадает с веткой фазы, команда останавливается с ошибкой.',
      },
      {
        title: 'Проверяет готовность без ключа',
        command: 'node scripts/ralph/ralph-loop.mjs',
        does: 'То же, что --check: без аргумента это режим по умолчанию.',
        when: 'Отдельного повода нет: --check делает то же и явно называет режим.',
        omits: 'Прогон не начинает. Ralph работает только от явного --run.',
      },
      {
        title: 'Ведёт прогон Ralph',
        command: 'node scripts/ralph/ralph-loop.mjs --run',
        does:
          'Ведёт прогон: берёт открытые issues milestone по возрастанию номера, отдаёт агенту, гоняет ' +
          'проверки в контейнере, коммитит, отправляет ветку, получает ревью и в конце фазы открывает pull request.',
        when: 'Когда беклог на GitHub создан, а --check прошёл без ошибок.',
        omits:
          'На одной фазе не останавливается: закрыв milestone, переходит к следующей фазе плана — ' +
          'своя ветка, свой pull request — и встаёт, когда фазы кончились или очередная не прошла. ' +
          'Pull request не сливает — merge остаётся за вами. Берёт только issues тех milestone, ' +
          'которые перечислены в конфиге.',
      },
      {
        title: 'Открывает пульт',
        command: 'node scripts/ralph/ralph-gui.mjs',
        does: 'Поднимает пульт на localhost и открывает его в браузере: состояние прогона, расход токенов по задачам, редактор настроек.',
        when: 'Когда правите настройки и смотрите, на что ушли токены.',
        omits:
          'Прогон не запускает и не останавливает, аргументов не принимает. ' +
          'Меняет один файл — .agents/ralph.config.json.',
      },
    ],
  },
  {
    title: 'В чате с агентом',
    note: 'Скиллы — команды со слэшем в сессии CLI агента. Ralph их не вызывает: зовёте вы.',
    items: [
      {
        command: '/prd описание фичи',
        does: 'Спрашивает недостающее и пишет PRD — документ требований docs/prd-слаг.md.',
        when: 'Перед новой фичей, пока требований нет.',
        omits: 'Код не пишет, на фазы не делит, issues не создаёт.',
      },
      {
        command: '/plan-phase docs/prd-слаг.md',
        does: 'Делит PRD на фазы и сохраняет план docs/plan-слаг.md. Каждую фазу можно сдать отдельно.',
        when: 'Сразу после PRD.',
        omits: 'Беклог на GitHub не создаёт и код не пишет.',
      },
      {
        command: '/issues docs/plan-слаг.md',
        does: 'Создаёт беклог на GitHub в порядке плана: milestone на фазу, issue на задачу.',
        when: 'После того как план закоммичен и запушен: issue ссылается на файл плана по SHA коммита.',
        omits: 'Код не пишет и прогон не запускает — задачи заберёт следующий --run.',
      },
      {
        command: '/review-all',
        does: 'Ревьюит изменения ветки тремя перспективами — безопасность, корректность, покрытие тестами — и сводит подтверждённые находки в один отчёт с вердиктом «прошло» или «не прошло».',
        when: 'Когда изменения готовы: перед тем как слить pull request, открытый Ralph.',
        omits: 'Найденное не чинит, issue не заводит и прогон не останавливает.',
      },
    ],
  },
];

/**
 * Разбор команды на части для раскраски, как её красит терминал.
 *
 * Разбор идёт по пробелам и различает четыре вида: чем команду запускают
 * (`node`, имя скилла), путь к файлу, ключ и остальной аргумент. Ключ важнее
 * прочего: четыре команды набора начинаются одним и тем же путём, и различает
 * их именно он.
 *
 * Склейка частей через пробел возвращает исходную строку: команду копируют в
 * терминал посимвольно, и раскраска не вправе её менять.
 */
export function commandTokens(command) {
  return String(command ?? '')
    .split(' ')
    .filter((part) => part !== '')
    .map((text, index) => {
      if (index === 0) return { text, kind: 'exec' };
      if (text.startsWith('-')) return { text, kind: 'flag' };
      // Путь узнаётся по разделителю каталогов или по расширению файла:
      // плейсхолдер вида «docs/prd-слаг.md» тоже путь, хоть и не существует.
      if (text.includes('/') || /\.\w+$/u.test(text)) return { text, kind: 'path' };
      return { text, kind: 'arg' };
    });
}

/* Тема одна, ночная: пульт открывают рядом с терминалом, и светлая вкладка
   между тёмными окнами бьёт по глазам. Вторая палитра под системную настройку
   жила бы мёртвым грузом и расходилась с живой при каждой правке. */
const styles = `
:root {
  color-scheme: dark;
  --bg: #131518;
  --side: #0e1013;
  --surface: #191c21;
  --subtle: #1f2329;
  --hover: #252a31;
  --text: #e8eaec;
  --muted: #9aa3ad;
  --border: #2a2e36;
  --border-strong: #3a404a;
  --accent: #82abf5;
  --accent-ink: #10131a;
  --ok: #6cbd8a;
  --bad: #e8867c;
  --warn: #d3a35f;
  --bar-1: #8a93a0;
  --bar-2: #5b636e;
  --bar-3: #3b424c;
  --side-w: 236px;
  --rail-w: 56px;
}

* { box-sizing: border-box; }

html { scrollbar-color: var(--border-strong) transparent; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
  caret-color: var(--accent);
}

::selection { background: rgba(130, 171, 245, 0.3); }

a { color: var(--accent); }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}

/* Каркас: слева панель разделов, справа содержимое. */
.app { display: flex; min-height: 100vh; }

/* Панель темнее содержимого: второй нейтральный слой отделяет навигацию от
   рабочей области без рамок и теней. */
.side {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  width: var(--side-w);
  height: 100vh;
  flex: none;
  padding: 14px 10px;
  background: var(--side);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  /* Анимируется именно ширина: содержимое должно занять освободившееся место,
     transform его не сдвинет. Один элемент, один клик — рефлоу не мешает. */
  transition: width 0.2s ease, padding 0.2s ease;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px 14px;
}

.brand-mark {
  display: grid;
  place-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-ink);
}

.brand-text {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
}

.brand-version {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
}

.side-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tab,
.side-toggle {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: none;
  border: 0;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
}

.tab:hover, .side-toggle:hover { background: var(--hover); color: var(--text); }

.tab[aria-current='page'] { background: var(--subtle); color: var(--text); }
.tab[aria-current='page'] .tab-icon { color: var(--accent); }

.tab-icon {
  display: grid;
  place-content: center;
  width: 20px;
  height: 20px;
  flex: none;
}

.tab-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.side-toggle { margin-top: auto; }

/* Свёрнутая панель: остаются иконки, подписи прячутся только визуально —
   имя кнопки должно дожить до скринридера. */
.is-rail .side { width: var(--rail-w); padding: 14px 8px; }
.is-rail .brand { justify-content: center; padding-left: 0; padding-right: 0; }
.is-rail .tab, .is-rail .side-toggle { justify-content: center; padding: 8px; }

.is-rail .tab-label,
.is-rail .brand-text {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.is-rail .side-toggle .tab-icon svg { transform: rotate(180deg); }

/* Содержимое */
.main { flex: 1; min-width: 0; padding: 0 28px 48px; }

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 24px;
  max-width: 1160px;
  margin: 0 auto 24px;
  padding: 28px 0 18px;
  border-bottom: 1px solid var(--border);
}

.head-text { min-width: 0; }

.head-title {
  margin: 0;
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

/* Строка под заголовком отвечает на вопрос «что я здесь вижу»: раздел, который
   называет себя одним словом, этого не объясняет. */
.head-note {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 13px;
}

/* Полоса состояния живёт в шапке: точка и одна строка без своей рамки. */
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--muted);
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
  font-size: 13px;
}

.panel { max-width: 1160px; margin: 0 auto; }

/* Вкладки внутри настроек. Они намеренно тише боковой навигации: ни акцентной
   иконки, ни жирного начертания — два одинаковых по силе ряда не дают понять,
   что чему подчинено. Прозрачная рамка стоит и у невыбранных, чтобы выбор не
   сдвигал соседей на пиксель. */
.subtabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0 0 16px;
}

.subtab {
  appearance: none;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  padding: 4px 10px;
}

.subtab:hover { color: var(--text); background: var(--hover); }

.subtab[aria-current='true'] {
  background: var(--subtle);
  border-color: var(--border);
  color: var(--text);
}

.subtab.is-warn { color: var(--warn); }

.settings-warn {
  margin: -6px 0 14px;
  color: var(--warn);
  font-size: 12px;
}

/* Сводка расхода */
.summary {
  padding: 16px 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.summary-line {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.summary-total { font-size: 21px; font-weight: 600; }
.summary-counts { color: var(--muted); }

.note {
  margin-top: 6px;
  color: var(--muted);
  font-size: 12px;
}

.kinds {
  margin-top: 8px;
  color: var(--muted);
  font-size: 12px;
}

/* Таблица issues */
.table-wrap {
  margin-top: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  /* На узком экране таблица прокручивается внутри себя, а не растягивает страницу. */
  overflow-x: auto;
}

table { width: 100%; border-collapse: collapse; }
/* Колонки не переносятся, чтобы числа не расползались на две строки. */
.tasks th, .tasks td { white-space: nowrap; }
/* Milestone и исход — фразы, а не числа: пусть переносятся, иначе длинный
   исход выталкивает таблицу за обёртку и вешает горизонтальную прокрутку. */
.tasks td:nth-child(2), .tasks td:nth-child(4), .tasks td.detail-cell { white-space: normal; }

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

/* Заголовок issue длиннее номера и не должен растягивать таблицу. Обрезает
   inline-block: на ячейке таблицы max-width авто-раскладка вправе не соблюдать. */
.task-title {
  display: inline-block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  margin-left: 6px;
  font-weight: 400;
  color: var(--muted);
}

/* Строка ревью milestone: это цена прогона, а не issue, и номера у неё нет. */
.task-kind { font-weight: 500; color: var(--muted); }

.marker {
  display: inline-block;
  width: 12px;
  color: var(--muted);
}

.bad { color: var(--bad); }
.ok { color: var(--ok); }
/* Отложенная issue и упёршийся в лимит прогон — не провал и не успех: работа
   цела и ждёт человека. Тот же янтарный, что у брошенного лока и у полей,
   требующих внимания. */
.warn { color: var(--warn); }
.muted { color: var(--muted); }

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

/* Роль внутри попытки: строка-заголовок, под ней виды токенов и цена от CLI. */
.role { padding: 4px 0 6px; }

.agent {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 3px 0;
  font-size: 13px;
}

.agent-right { color: var(--muted); white-space: nowrap; }

.empty {
  padding: 24px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--muted);
  text-align: center;
}

/* Скелет на время загрузки: серые плашки по форме будущих блоков вместо
   мигающей пустой карточки с текстом. Текст остаётся для скринридера. */
.skeleton {
  padding: 16px 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.skeleton + .skeleton { margin-top: 16px; }

.skel {
  height: 13px;
  margin: 10px 0;
  border-radius: 6px;
  background: var(--subtle);
  animation: skel 1.1s ease-in-out infinite alternate;
}

.skel.is-title { height: 20px; margin-top: 2px; }

@keyframes skel {
  from { opacity: 0.55; }
  to { opacity: 1; }
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* Настройки */
.banner {
  margin-bottom: 16px;
  padding: 10px 12px;
  background: var(--subtle);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
}

.banner-title { font-weight: 600; }
.banner-text { color: var(--muted); font-size: 13px; }

.section { margin-top: 28px; }

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

/* Над заголовком блока воздуха больше, чем под ним: иначе заголовок читается
   как подпись к полям сверху, а не как название того, что под ним. */
.section-title {
  margin: 32px 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.section-title:first-child { margin-top: 4px; }

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

.field-hint.is-warn { color: var(--warn); }

input[type='text'],
input[type='number'],
select,
textarea {
  width: 100%;
  padding: 6px 8px;
  background: var(--subtle);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  font: inherit;
  font-variant-numeric: tabular-nums;
}

textarea { min-height: 92px; resize: vertical; }

/* Список строк задаёт высоту атрибутом rows: поле под нуль-два логина иначе
   занимало бы столько же места, сколько поле под десяток команд. */
textarea.is-rows { min-height: 0; }

input:focus-visible,
select:focus-visible,
textarea:focus-visible,
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

input:disabled,
select:disabled,
textarea:disabled { color: var(--muted); background: var(--surface); }

.check { display: flex; align-items: center; gap: 8px; }
.check input { width: auto; accent-color: var(--accent); }

.phases { width: 100%; border-collapse: collapse; }
.phases th { padding: 4px 8px 4px 0; }
.phases td { padding: 4px 8px 4px 0; border-bottom: 0; }
.phases td:last-child, .phases th:last-child { padding-right: 0; width: 1%; }

.btn {
  padding: 6px 12px;
  background: var(--subtle);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
}

.btn:hover:not(:disabled) { background: var(--hover); }
.btn:disabled { color: var(--muted); cursor: default; }

/* Тёмный текст на акценте: белый на этом голубом не дотягивает до контраста. */
.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}

.btn-primary:hover:not(:disabled) { background: var(--accent); opacity: 0.9; }
.btn-primary:disabled { background: var(--subtle); border-color: var(--border); color: var(--muted); }

.btn-small { padding: 3px 9px; font-size: 13px; }

/* Вкладка «Команды» */

/* Вкладки групп заодно и заголовки: это два имени того, где команду набирают,
   и мелкая кнопка рядом с командами читалась бы слабее их самих. */
.commands-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  margin: 0 0 16px;
  border-bottom: 1px solid var(--border);
}

.commands-tab {
  appearance: none;
  padding: 4px 0 10px;
  background: none;
  border: 0;
  /* Черта под выбранной вкладкой ложится поверх линии ряда. */
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.commands-tab:hover { color: var(--text); }

.commands-tab[aria-current='true'] {
  border-bottom-color: var(--accent);
  color: var(--text);
}

.commands-note {
  margin: 0 0 20px;
  color: var(--muted);
  font-size: 13px;
}

/* Команда и её объяснение стоят рядом, а не друг под другом: столбец команд
   слева сканируется глазом, а объяснение справа держит читаемую длину строки.
   На всю ширину пульта строка вышла бы под 140 знаков — вдвое длиннее того,
   что глаз проходит без усилия. */
/* Команда, её заголовок и три поля — одна колонка шириной в меру текста:
   объяснение на всю ширину пульта доходило до 140 знаков в строке. */
.command { max-width: 70ch; margin-bottom: 28px; }
.command:last-child { margin-bottom: 4px; }

/* Заголовок называет команду словами: четыре команды терминала начинаются
   одним путём, и без него список читается как одна повторяющаяся строка. */
.command-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
}

/* Сама команда набрана как строка терминала: тёмная полоса с приглашением и
   кнопкой копирования у правого края. Полоса темнее и карточек полей, и фона
   страницы — на неё смотрят первой, её и набирают. */
.command-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px 9px 12px;
  background: var(--side);
  border: 1px solid var(--border);
  border-radius: 8px;
}

/* Приглашение только рисуется: в текст команды оно не входит. */
.command-prompt {
  flex: none;
  padding: 4px 0;
  color: var(--ok);
  font-family: ui-monospace, 'SF Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
  line-height: 1.4;
  user-select: none;
}

/* Знак раскрытия у правого края карточки. */
.command-mark {
  display: grid;
  place-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--muted);
}

/* Моноширинный только у самой команды: это код, который человек набирает
   символ в символ. Фона и рамки у неё нет — рамку носят карточки полей, а
   коробка внутри коробки читается как чужая вставка. */
.command-name {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 0;
  color: var(--muted);
  font-family: ui-monospace, 'SF Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

/* Раскраска команды повторяет терминал: тем, чем её запускают, — приглушённо,
   путь к файлу — основным цветом, ключ — акцентом. Ключ различает четыре
   команды с одинаковым путём, поэтому он ярче всего. */
.cmd-exec { color: var(--muted); }
.cmd-path { color: var(--text); }
.cmd-flag { color: var(--accent); }
.cmd-arg { color: var(--muted); font-style: italic; }

/* Скилл вызывают именем, и оно же его команда: путь рядом с ним — аргумент. */
.command.is-skill .cmd-exec { color: var(--accent); }
.command.is-skill .cmd-path { color: var(--muted); }

/* Кнопка-иконка: подпись «Копировать» повторялась у каждой команды и спорила
   с самой командой за внимание. Цель нажатия остаётся 30×30 при рисунке 16. */
.command-copy {
  display: grid;
  place-content: center;
  width: 30px;
  height: 30px;
  flex: none;
  padding: 0;
  background: none;
  border: 0;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
}

.command-copy:hover { color: var(--text); background: var(--hover); }
.command-copy.is-ok { color: var(--ok); }

/* Исход клика стоит под командой и в покое пуст: его отступ иначе добавлял бы
   полосу пустоты каждой команде списка. */
.command-status { display: block; margin-top: 4px; font-size: 12px; }
.command-status:empty { display: none; }
.command-status.is-ok { color: var(--ok); }
.command-status.is-bad { color: var(--bad); }

.command-body { margin-top: 10px; }

/* Каждое поле — своя карточка: три ответа подряд читались как один абзац, а
   в отдельных карточках видно, где кончается один и начинается другой. */
.command-line {
  margin-bottom: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.command-line:last-child { margin-bottom: 0; }

/* Метка — кнопка во всю ширину карточки: попасть по ней проще, чем по слову,
   а знак справа говорит, что сделает клик. */
.command-lead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  background: none;
  border: 0;
  border-radius: 12px;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  text-align: left;
}

.command-lead:hover { color: var(--text); }
.command-lead:hover .command-mark { color: var(--text); }

/* У раскрытого поля метка — заголовок ответа под ней, поэтому она ярче. */
.command-lead[aria-expanded='true'] { color: var(--text); padding-bottom: 6px; }

.command-text {
  margin: 0;
  padding: 0 14px 13px;
  color: var(--muted);
}

/* Совсем узкий экран: метка не отнимает у текста половину строки, а встаёт
   над ним. */
@media (max-width: 720px) {
  .command-line { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}

.unknown-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 5px 0;
  border-bottom: 1px solid var(--border);
}

.unknown-row:last-child { border-bottom: 0; }
/* Значение прижато к правому краю: ключ остаётся слева, кнопка — за значением. */
.unknown-value { margin-left: auto; color: var(--muted); overflow-wrap: anywhere; }
.unknown-row .btn { flex: 0 0 auto; }

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

/* На узком экране панель сама складывается в рейку: место дороже подписей. */
@media (max-width: 720px) {
  .app .side { width: var(--rail-w); padding: 14px 8px; }
  .app .brand { justify-content: center; padding-left: 0; padding-right: 0; }
  .app .tab, .app .side-toggle { justify-content: center; padding: 8px; }
  .app .tab-label,
  .app .brand-text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .app .side-toggle { display: none; }
  .main { padding: 0 14px 48px; }
  .grid { grid-template-columns: minmax(0, 1fr); }
}
`;

/* Иконки — встроенные SVG в одной графике: штрих 1.75, скруглённые концы.
   Символы из набора Lucide (ISC), пакет для четырёх картинок не нужен. */
function icon(paths) {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}

const icons = {
  // Петля из двух стрелок: сам цикл Ralph.
  brand: icon('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  // Столбики: расход по задачам.
  usage: icon('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
  // Ползунки: настройки.
  settings: icon('<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'),
  // Приглашение терминала: команды.
  commands: icon('<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>'),
  // Шевроны внутрь: свернуть панель. В рейке разворачиваются наружу стилем.
  collapse: icon('<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>'),
  // Два листа: копировать команду в буфер.
  copy: icon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  // Галочка: команда легла в буфер.
  check: icon('<path d="M20 6 9 17l-5-5"/>'),
  // Плюс у свёрнутого поля и крест у раскрытого: знак говорит, что сделает
  // клик, а не в какую сторону поедет текст.
  plus: icon('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
};

const markup = `
<div class="app" id="app">
  <aside class="side">
    <div class="brand">
      <span class="brand-mark">${icons.brand}</span>
      <span class="brand-text">Ralph<span class="brand-version">${KIT_VERSION}</span></span>
    </div>
    <nav class="side-nav" aria-label="Разделы">
      <button class="tab" type="button" id="tab-usage" data-tab="usage" aria-current="page"><span class="tab-icon">${icons.usage}</span><span class="tab-label">Расход</span></button>
      <button class="tab" type="button" id="tab-settings" data-tab="settings"><span class="tab-icon">${icons.settings}</span><span class="tab-label">Настройки</span></button>
      <button class="tab" type="button" id="tab-commands" data-tab="commands"><span class="tab-icon">${icons.commands}</span><span class="tab-label">Команды</span></button>
    </nav>
    <button class="side-toggle" type="button" id="side-toggle" aria-expanded="true"><span class="tab-icon">${icons.collapse}</span><span class="tab-label">Свернуть</span></button>
  </aside>
  <div class="main">
    <header class="head">
      <div class="head-text">
        <h1 class="head-title" id="head-title">Расход</h1>
        <p class="head-note" id="head-note">Токены и время по задачам из журнала прогона.</p>
      </div>
      <div class="status">
        <span class="dot" id="status-dot"></span>
        <span class="status-text" id="status-text">Состояние загружается</span>
      </div>
    </header>
    <main class="panel" id="panel" aria-labelledby="tab-usage"></main>
  </div>
</div>
<!-- Иконки для кнопок, которые рисует скрипт. Он клонирует их из шаблона, а не
     собирает разметкой: innerHTML на странице не используется нигде. -->
<template id="icon-copy">${icons.copy}</template>
<template id="icon-check">${icons.check}</template>
<template id="icon-plus">${icons.plus}</template>
<template id="icon-close">${icons.close}</template>
`;

// Клиентский скрипт. Внутри нет шаблонных литералов и обратных кавычек:
// строка целиком лежит в шаблонном литерале модуля.
const script = `
(function () {
  'use strict';

  var token = window.__RALPH_TOKEN__ || '';
  // Перечень команд статичен и приезжает вместе со страницей: вкладка
  // «Команды» не ходит на сервер вовсе.
  var commandGuide = ${jsonLiteral(
    commandGuide.map((group) => ({
      ...group,
      // Команда приезжает уже разобранной на части: раскраску считает модуль,
      // страница только рисует span на каждую часть.
      items: group.items.map((item) => ({ ...item, tokens: commandTokens(item.command) })),
    })),
  )};
  var tab = 'usage';
  var stateData = null;
  var tasksData = null;
  var tasksStamp = '';
  var tasksError = '';
  var configData = null;
  var configError = '';
  var draft = null;
  var baseline = '';
  var saveMessage = null;
  var saving = false;
  var expanded = Object.create(null);
  var lastLocked = null;
  // Селекты с allowCustom, переведённые пунктом «Другая…» в ручной ввод.
  var customOpen = Object.create(null);
  var customMarker = '__ralph_custom__';
  // Выбранная вкладка настроек переживает сохранение и перезагрузку страницы.
  var settingsTabKey = 'ralph-gui-settings-tab';
  var settingsTab = readSettingsTab();
  // Пути полей, от значения которых зависят чужие списки вариантов.
  var dependencyPaths = Object.create(null);
  // Выбранная группа справочника команд: терминал или чат с агентом.
  var commandsGroup = 0;

  var panel = document.getElementById('panel');
  var statusDot = document.getElementById('status-dot');
  var statusText = document.getElementById('status-text');
  var headTitle = document.getElementById('head-title');
  var headNote = document.getElementById('head-note');
  /* Заголовок над содержимым называет раздел: в свёрнутой панели подписей у
     кнопок не видно. Строка под ним говорит, что человек здесь видит и откуда
     эти данные — из журнала, из файла настроек или из самого набора. */
  var tabTitles = {
    usage: ['Расход', 'Токены и время по задачам из журнала прогона.'],
    settings: ['Настройки', 'Файл .agents/ralph.config.json: поля с подсказками и проверкой ввода.'],
    commands: ['Команды', 'Что делает каждая команда, когда её звать и чего она не делает.']
  };

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

  /* Итог попытки в одну строку: колонка не переносится. Семь верхних значений
     пишет сам цикл, остальные приходят кодом упавшего исключения. Незнакомое
     значение показывается как есть — подмена скрыла бы новый код.

     Список повторяет outcomeDescriptions из ralph-gui-data.mjs слово в слово:
     сервер той же парой заполняет reason, и разные формулировки читались бы
     как два разных события. Меняете здесь — правьте и там. */
  var outcomeWords = {
    completed: 'Ralph закрыл issue',
    'review-failed': 'ревью вернуло замечания',
    'review-parked': 'Ralph отложил issue после отказов ревью',
    'iteration-limit': 'итерации кончились до начала issue',
    'milestone-review': 'Ralph отревьюил milestone',
    'validation-failed': 'проверки не прошли',
    'agent-failed': 'сессия агента оборвалась, наработки сохранены',
    RALPH_VALIDATION_FAILED: 'проверки не прошли, попытки кончились',
    RALPH_MAX_TURNS: 'сессия упёрлась в лимит шагов',
    RALPH_AGENT_TIMEOUT: 'сессия не уложилась в срок',
    RALPH_AGENT_AUTH: 'CLI агента не авторизован',
    RALPH_AGENT_REJECTED: 'CLI отклонил запрос',
    RALPH_AGENT_WRITE_ACCESS: 'агент не смог писать файлы',
    RALPH_UNTRUSTED_ISSUE: 'автор issue не доверенный',
    RALPH_COMMAND_FAILED: 'команда прогона вернула ошибку',
    RALPH_COMMAND_NOT_FOUND: 'Ralph не нашёл команду прогона',
    RALPH_COMMAND_TIMEOUT: 'команда прогона не уложилась в срок',
    RALPH_COMMAND_TERMINATED: 'команду прогона прервали снаружи',
    aborted: 'прогон прервали'
  };

  var successOutcomes = { completed: 1 };

  /* Ни успех, ни провал: issue цела, но ждёт решения человека. Красный тут
     соврал бы — работа не потеряна и не сломана. */
  var pendingOutcomes = { 'review-parked': 1, 'iteration-limit': 1 };

  function outcomeWord(value) {
    if (!value) return '—';
    return outcomeWords[String(value)] || String(value);
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

  /* Скелет на время загрузки: плашки по форме будущего блока вместо текста в
     пустой карточке. Глазам — заготовка раздела, скринридеру — скрытая
     подпись. Ширины в процентах, чтобы скелет дышал вместе с колонкой. */
  function renderSkeleton(widths) {
    var box = el('div', 'skeleton');
    box.appendChild(el('span', 'sr-only', 'Данные загружаются'));
    widths.forEach(function (width, index) {
      var bar = el('div', index === 0 ? 'skel is-title' : 'skel');
      bar.style.maxWidth = width;
      box.appendChild(bar);
    });
    return box;
  }

  /* --- полоса состояния --- */

  function statusLine(data) {
    if (!data) return 'Данные загружаются';
    if (data.staleLock && !data.running) return 'Прошлый прогон упал, не закрывшись. Следующий запуск начнётся как обычно';
    var run = data.run;
    if (!data.running || !run) return 'Прогона нет';
    var parts = [];
    if (run.issueNumber) parts.push('Issue #' + run.issueNumber);
    var phase = phaseWord(run.issuePhase);
    if (phase) parts.push(phase);
    if (run.branch) parts.push('ветка ' + run.branch);
    if (typeof run.phaseIndex === 'number' && run.phaseCount) {
      parts.push('фаза ' + (run.phaseIndex + 1) + ' из ' + run.phaseCount);
    }
    if (run.maxIterations) {
      parts.push('итерация ' + (run.iterationsUsed || 0) + ' из ' + run.maxIterations);
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

  /* Опрос повторяет этот запрос, а renderPanel строит таблицу заново и теряет
     прокрутку и фокус. Поэтому ответ сравнивается с предыдущим и панель
     перерисовывается только когда журнал действительно дописали. */
  /* Один текст на два места: он же служит признаком «ошибка та же самая», по
     которому опрос решает не перерисовывать панель. */
  var tasksUnreachable = 'Пульт не получил журнал расхода от сервера.';

  function loadTasks() {
    return api('/api/tasks').then(function (res) {
      var changed;
      if (!res.ok) {
        var message = (res.body && res.body.error) || tasksUnreachable;
        changed = tasksError !== message || tasksData !== null;
        tasksError = message;
        tasksData = null;
        tasksStamp = '';
      } else {
        var next = JSON.stringify(res.body);
        changed = tasksError !== '' || next !== tasksStamp;
        tasksError = '';
        tasksData = res.body;
        tasksStamp = next;
      }
      if (changed && tab === 'usage') renderPanel();
    }).catch(function () {
      var failed = tasksError !== tasksUnreachable || tasksData !== null;
      tasksError = tasksUnreachable;
      tasksData = null;
      tasksStamp = '';
      if (failed && tab === 'usage') renderPanel();
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
      { cls: 's1', label: 'разработка', ms: stageMs(s.implementation) },
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

  /* Номер строки — порядок попытки внутри issue: он сходится с колонкой
     «Попытки». Номер итерации сквозной по всему прогону и идёт с пропусками,
     поэтому остаётся справочной пометкой. */
  function renderRun(run, index) {
    var box = el('div', 'run');
    var head = el('div', 'run-head');
    head.appendChild(
      el(
        'span',
        'run-title',
        'Попытка ' + (index + 1) + (run.iteration ? ' · итерация ' + run.iteration : '')
      )
    );
    var when = [];
    var from = clock(run.startedAt);
    var to = clock(run.finishedAt);
    if (from) when.push(to ? from + ' → ' + to : from);
    if (run.wallMs) when.push(duration(run.wallMs));
    if (run.agentCli) when.push(run.agentCli);
    if (when.length) head.appendChild(el('span', 'run-meta', when.join(' · ')));
    var outcomeText = outcomeWord(run.outcome);
    head.appendChild(el('span', outcomeClass(run.outcome), outcomeText));
    box.appendChild(head);

    /* Свой reason от цикла добавляет подробность, подставленный сервером —
       повторяет подпись справа. Повтор читался бы как второе объяснение. */
    var reasonText = run.reason ? String(run.reason) : '';
    if (reasonText && reasonText !== outcomeText) {
      box.appendChild(el('div', 'run-meta', reasonText));
    }

    var bar = renderBar(run.stages);
    if (bar) box.appendChild(bar);

    var roles = Array.isArray(run.roles) ? run.roles : [];
    if (roles.length) {
      var list = el('div', 'agents');
      roles.forEach(function (role) { list.appendChild(renderRole(role)); });
      box.appendChild(list);
    }
    return box;
  }

  /* Цену присылает не всякая сессия: сессия, убитая лимитом шагов, и весь
     backend Codex её не отдают. Поэтому подпись называет источник и говорит,
     за сколько сессий число посчитано. */
  function costLine(role) {
    var sessions = Number(role.sessions) || 0;
    var reported = Number(role.costReportedBy) || 0;
    if (!reported) return 'CLI цену не прислал';
    var text = 'CLI насчитал ' + money(role.costUsd);
    if (reported < sessions) {
      text += ' за ' + num(reported) + ' ' + plural(reported, 'сессию', 'сессии', 'сессий') +
        ' из ' + num(sessions);
    }
    return text;
  }

  /* Роль — это операция попытки: разработка, ревью issue, ревью milestone. Внутри
     роли объём разложен по видам токенов, стадии же показывает полоска
     времени выше, и повторять их здесь незачем. */
  function renderRole(role) {
    var box = el('div', 'role');
    var head = el('div', 'agent');
    var left = [roleWord(role.role)];
    var models = Array.isArray(role.models) ? role.models : role.models ? [role.models] : [];
    if (role.sessions > 1) {
      left.push(num(role.sessions) + ' ' + plural(role.sessions, 'сессия', 'сессии', 'сессий'));
    }
    if (role.turns) left.push(num(role.turns) + ' ' + plural(role.turns, 'ход', 'хода', 'ходов'));
    if (models.length) left.push(models.join(', '));
    head.appendChild(el('span', '', left.join(' · ')));
    /* Ни одной сессии со счётчиками — объёма нет вовсе, и ноль соврал бы:
       сессия, убитая лимитом шагов, отдаёт пустую телеметрию. */
    var silent = role.sessionsWithoutTokens >= role.sessions;
    head.appendChild(
      el(
        'span',
        'agent-right',
        silent ? 'CLI не прислал счётчики' : tokens(role.tokensTotal) + ' токенов'
      )
    );
    box.appendChild(head);

    var kinds = tokenKindList(role.tokens);
    if (kinds.length) box.appendChild(el('div', 'legend', kinds.join(' · ')));
    box.appendChild(el('div', 'legend', costLine(role)));
    return box;
  }

  function renderUsage() {
    var frag = document.createDocumentFragment();

    if (tasksError) {
      frag.appendChild(el('div', 'empty', tasksError));
      return frag;
    }
    if (!tasksData) {
      // Два скелета повторяют раздел: карточка сводки и таблица под ней.
      frag.appendChild(renderSkeleton(['34%', '62%', '46%']));
      frag.appendChild(renderSkeleton(['22%', '100%', '100%', '100%']));
      return frag;
    }

    var totals = tasksData.totals || {};
    var period = tasksData.period || {};
    var tasks = Array.isArray(tasksData.tasks) ? tasksData.tasks : [];

    /* Битый журнал даёт те же нули, что и новый проект. Без этой ветки экран
       врал бы «прогонов ещё не было» поверх лежащей на диске истории. */
    if (totals.metricsUnreadable) {
      frag.appendChild(
        el(
          'div',
          'empty',
          'Журнал .git/ralph-loop/issue-metrics.json лежит на месте, но не разбирается. ' +
            'Расход не показать, пока файл не почините или не удалите.'
        )
      );
      return frag;
    }

    /* Пустой журнал проверяется до сводки: нули и примечания к ним человеку,
       который ещё не запускал Ralph, сказать нечего. */
    if (!tasks.length) {
      frag.appendChild(el('div', 'empty', 'Ralph ещё не сделал ни одной попытки'));
      return frag;
    }

    /* Ни одной сессии со счётчиками — объёма нет вовсе, и ноль соврал бы. Так
       выглядит любой журнал прогона на Codex: этот CLI счётчики не присылает. */
    var mute = Number(totals.sessionsWithoutTokens) || 0;
    var silent = totals.sessions ? mute >= totals.sessions : false;

    var summary = el('div', 'summary');
    var line = el('div', 'summary-line');
    line.appendChild(
      el(
        'span',
        'summary-total',
        silent ? 'CLI не прислал счётчики' : tokens(totals.tokensTotal) + ' токенов'
      )
    );
    var reviews = Number(totals.milestoneReviews) || 0;
    var counts = [
      num(totals.tasks) + ' ' + plural(totals.tasks, 'issue', 'issues', 'issues'),
      num(totals.attempts) + ' ' + plural(totals.attempts, 'попытка', 'попытки', 'попыток')
    ];
    /* Ревью milestone оплачено прогоном, а не одной issue, поэтому оно стоит
       рядом с попытками отдельным числом. */
    if (reviews) counts.push(num(reviews) + ' ревью milestone');
    if (totals.sessions) {
      var word = plural(totals.sessions, 'сессия', 'сессии', 'сессий');
      counts.push(num(totals.sessions) + ' ' + word);
    }
    counts.push(hours(totals.wallMs));
    line.appendChild(el('span', 'summary-counts', counts.join(' · ')));
    summary.appendChild(line);

    /* Разбивка отвечает на вопрос, куда ушёл объём. Сумма пяти видов равна
       числу слева: виды не пересекаются. */
    var kinds = silent ? [] : tokenKindList(totals.tokens, true);
    if (kinds.length) summary.appendChild(el('div', 'kinds', kinds.join(' · ')));

    if (period.fromIso || period.toIso) {
      summary.appendChild(
        el('div', 'note', 'Период: ' + (stamp(period.fromIso) || '—') + ' — ' + (stamp(period.toIso) || '—'))
      );
    }
    var warn = [];
    /* Пока цикл не писал запись ревью milestone, итог его не покрывает. Появилась
       запись — предупреждение врало бы: ревью уже в числах. */
    if (totals.missesMilestoneReview) warn.push('Ревью milestone в эти числа не входит.');
    if (period.maxStored) {
      warn.push(
        'Журнал хранит последние ' +
          num(period.maxStored) +
          ' ' +
          plural(period.maxStored, 'попытку', 'попытки', 'попыток') +
          ', сейчас записано ' +
          num(period.storedAttempts || 0) +
          '.'
      );
    }
    if (warn.length) summary.appendChild(el('div', 'note', warn.join(' ')));
    /* Сессия без счётчиков входит в итог нулём, поэтому итог занижен. Молчать
       об этом нельзя: именно так выглядит сессия, сгоревшая на лимите шагов.
       Когда счётчиков нет ни у одной сессии, число слева уже сказало об этом. */
    if (mute && !silent) {
      summary.appendChild(
        el(
          'div',
          'note',
          'У ' +
            num(mute) +
            ' ' +
            plural(mute, 'сессии', 'сессий', 'сессий') +
            ' из ' +
            num(totals.sessions) +
            ' CLI не прислал счётчики токенов: этот объём в итог не попал.'
        )
      );
    }
    summary.appendChild(
      el(
        'div',
        'note',
        silent
          ? 'CLI не прислал ни одного счётчика токенов за ' +
              num(totals.sessions) +
              ' ' +
              plural(totals.sessions, 'сессию', 'сессии', 'сессий') +
              '. Так работает Codex: объём он не сообщает, и пульту его взять неоткуда. ' +
              'Время и число попыток посчитаны по журналу и верны.'
          : 'Чтение кэша — агент прогоняет через модель контекст, который она уже видела. ' +
              'Запись в кэш — тот же контекст в первый раз. Новый текст пришёл мимо кэша. ' +
              'Рассуждения и ответ агент написал сам. Числа приходят от CLI как есть.'
      )
    );
    frag.appendChild(summary);

    var wrap = el('div', 'table-wrap');
    var table = el('table', 'tasks');
    var thead = el('thead');
    var headRow = el('tr');
    /* Строки уже отсортированы по объёму: сервер отдаёт их от большего к
       меньшему. */
    [
      ['Issue', '', ''],
      ['Milestone', '', ''],
      ['Попытки', 'num', ''],
      ['Исход', '', ''],
      ['Время', 'num', ''],
      ['Загружено', 'num', 'Чтение кэша, запись в кэш и новый текст запроса'],
      ['Написано', 'num', 'Рассуждения и ответ агента'],
      ['Всего', 'num', 'Сумма пяти видов токенов']
    ].forEach(function (column) {
      var cell = el('th', column[1], column[0]);
      if (column[2]) cell.title = column[2];
      headRow.appendChild(cell);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    /* Ревью milestone стоит выше issues: это объём всего прогона, и в сортировке
       по объёму оно иначе встаёт первой строкой, читаясь как самая объёмная
       issue. Порядок issues между собой сервер уже задал. */
    var ordered = tasks.filter(isReviewRow).concat(tasks.filter(function (task) {
      return !isReviewRow(task);
    }));
    ordered.forEach(function (task) {
      var review = isReviewRow(task);
      var key = review ? 'milestone-review:' + (task.milestone || '') : String(task.issue);
      var open = !!expanded[key];
      var row = el('tr', 'task-row');
      row.tabIndex = 0;
      row.setAttribute('aria-expanded', open ? 'true' : 'false');

      var first = el('td', 'task-id');
      first.appendChild(el('span', 'marker', open ? '−' : '+'));
      if (review) {
        first.appendChild(el('span', 'task-kind', 'Ревью milestone'));
      } else {
        first.appendChild(document.createTextNode('#' + task.issue));
        /* Заголовка нет у попыток старого формата. Прочерк на его месте занял
           бы колонку молчанием: номер уже сказал, о чём строка. */
        if (task.title) {
          var titleSpan = el('span', 'task-title', task.title);
          titleSpan.title = String(task.title);
          first.appendChild(titleSpan);
        }
      }
      row.appendChild(first);
      row.appendChild(el('td', '', task.milestone || '—'));
      row.appendChild(el('td', 'num', review ? '—' : num(task.attempts)));

      /* У ревью milestone исход всегда один, а знать надо вердикт: он в reason. */
      var outcomeText = review && task.lastReason
        ? cut(String(task.lastReason), 40)
        : outcomeWord(task.lastOutcome);
      var outcomeCell = el('td', outcomeClass(task.lastOutcome), outcomeText);
      /* Подсказка нужна, только когда добавляет текст: у исхода без своего
         reason сервер подставляет ту же подпись, и всплывающее повторение
         читалось бы как второе, другое объяснение. */
      var reasonText = task.lastReason ? String(task.lastReason) : '';
      if (reasonText && reasonText !== outcomeText) outcomeCell.title = reasonText;
      row.appendChild(outcomeCell);

      row.appendChild(el('td', 'num', duration(task.wallMs)));
      /* Ни одной сессии со счётчиками — прочерк вместо нулей: ноль означал бы,
         что объём измерен и равен нулю. */
      var noTokens = task.sessions ? task.sessionsWithoutTokens >= task.sessions : true;
      row.appendChild(el('td', 'num', noTokens ? '—' : tokens(loadedTokens(task.tokens))));
      row.appendChild(el('td', 'num', noTokens ? '—' : tokens(writtenTokens(task.tokens))));
      row.appendChild(el('td', 'num', noTokens ? '—' : tokens(task.tokensTotal)));

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
        cell.colSpan = 8;
        var runs = Array.isArray(task.runs) ? task.runs : [];
        if (!runs.length) {
          cell.appendChild(el('div', 'run-meta', 'Журнал не сохранил ни одной попытки'));
        } else {
          runs.forEach(function (run, index) { cell.appendChild(renderRun(run, index)); });
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
    var groups;
    if (isGrouped) {
      groups = source.map(function (group) {
        var title = group.title || group.label || group.name || 'Настройки';
        return {
          id: String(group.id || title),
          title: title,
          fields: (group.fields || []).map(normalizeField)
        };
      });
    } else {
      var order = [];
      var byTitle = Object.create(null);
      source.forEach(function (item) {
        var field = normalizeField(item);
        var title = item.group || item.section || 'Настройки';
        if (!byTitle[title]) {
          byTitle[title] = { id: title, title: title, fields: [] };
          order.push(byTitle[title]);
        }
        byTitle[title].fields.push(field);
      });
      groups = order;
    }
    // Смена такого поля перерисовывает экран: от него зависят чужие списки.
    dependencyPaths = Object.create(null);
    groups.forEach(function (group) {
      group.fields.forEach(function (field) {
        if (field.optionsDependOn) dependencyPaths[field.optionsDependOn] = true;
      });
    });
    return groups;
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
      section: source.section || '',
      label: source.label || source.title || path,
      type: type,
      hint: source.hint || source.help || source.description || source.note || '',
      options: source.options || null,
      // Имена ровно те, что кладёт ralph-gui-fields.mjs: синоним здесь молча
      // оставил бы зависимые селекты пустыми.
      optionsDependOn: source.optionsDependOn || null,
      allowCustom: source.allowCustom === true,
      required: source.required === true,
      hasDefault: Object.prototype.hasOwnProperty.call(source, 'default'),
      fallback: source.default,
      min: source.min,
      max: source.max,
      step: source.step
    };
  }

  function optionList(field) {
    var raw = field.options;
    if (field.optionsDependOn) {
      var key = draft ? getPath(draft, field.optionsDependOn) : '';
      raw = (field.options || {})[key] || [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.map(function (option) {
      if (option && typeof option === 'object') {
        return { value: String(option.value), label: String(option.label || option.value) };
      }
      return { value: String(option), label: String(option) };
    });
  }

  /* Значение вне списка. Имя модели код списком не ограничивает — там это
     просто своё значение. Усилие проверяется по списку CLI (validateAgentRoles
     в ralph-config.mjs), и чужое значение остановит прогон, о чём надо сказать
     прямо. */
  function outsideWord(field) {
    if (field.allowCustom) return 'своё значение';
    var key = field.optionsDependOn ? getPath(draft, field.optionsDependOn) : '';
    return key ? 'недопустимо для ' + key : 'нет в списке';
  }

  // Поля, из-за которых прогон не стартует: значение вне списка или пустое
  // обязательное. Такое поле может лежать на соседней вкладке — после смены CLI
  // агента или после обновления набора человек обязан узнать о нём, не открывая
  // её.
  function badFields(group) {
    return group.fields.filter(function (field) {
      var stored = draft ? getPath(draft, field.path) : undefined;
      if (field.required && isBlank(stored)) return true;
      if (field.type !== 'select' || field.allowCustom) return false;
      if (isUnset(stored)) return false;
      var current = String(stored);
      if (!current) return false;
      return !optionList(field).some(function (option) { return option.value === current; });
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

  function isUnset(value) {
    return value === undefined || value === null;
  }

  // Пустая строка приходит из очищенного поля ввода, пустой список — из таблицы
  // фаз без строк: для обязательного поля это то же самое, что значения нет.
  function isBlank(value) {
    if (isUnset(value)) return true;
    if (Array.isArray(value)) return value.length === 0;
    return String(value).trim() === '';
  }

  /* Значения в файле может не быть — тогда его подставит сам Ralph. Форма
     показывает это значение и подписывает поле, но в draft не пишет: иначе
     кнопка «Сохранить» оживала бы без правки, а файл распухал бы всеми ключами.
     Про null и списки ничего не пишем: там умолчания нет или оно пустое. */
  function defaultNote(field, stored) {
    if (!isUnset(stored) || !field.hasDefault) return '';
    var fallback = field.fallback;
    if (isUnset(fallback) || Array.isArray(fallback)) return '';
    var text = fallback === true ? 'включено' : fallback === false ? 'выключено' : String(fallback);
    return 'Значение не задано — Ralph подставит: ' + text + '.';
  }

  function renderField(field) {
    var box = el('div', 'field');
    var wide = field.type === 'phases' || field.type === 'list' || field.type === 'textarea';
    if (wide) box.className = 'field is-wide';

    var stored = draft ? getPath(draft, field.path) : undefined;
    var value = isUnset(stored) && field.hasDefault ? field.fallback : stored;
    var note = defaultNote(field, stored);
    var hintText = field.hint;
    if (note) hintText = hintText ? hintText + ' ' + note : note;
    var locked = isLocked();
    var warnText = '';

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
      if (hintText) box.appendChild(el('div', 'field-hint', hintText));
      return box;
    }

    var label = el('label', 'field-label', field.label);
    box.appendChild(label);

    if (field.type === 'select') {
      var select = document.createElement('select');
      select.disabled = locked;
      var options = optionList(field);
      var current = isUnset(value) ? '' : String(value);
      var custom = customOpen[field.path] === true;
      var known = false;
      options.forEach(function (option) {
        var node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        if (option.value === current) known = true;
        select.appendChild(node);
      });
      if (!known && !custom) {
        // Значение вне списка не теряется: оно остаётся выбранным первым
        // пунктом и подписано — своё оно или недопустимое для текущего CLI.
        var extra = document.createElement('option');
        extra.value = current;
        extra.textContent = current ? current + ' — ' + outsideWord(field) : '—';
        select.insertBefore(extra, select.firstChild);
      }
      if (field.allowCustom) {
        var other = document.createElement('option');
        other.value = customMarker;
        other.textContent = 'Другая…';
        select.appendChild(other);
      }
      select.value = custom ? customMarker : current;
      select.addEventListener('change', function () {
        if (select.value === customMarker) {
          customOpen[field.path] = true;
          renderPanel();
          return;
        }
        // Выбор готового пункта закрывает режим «Другая…», а его поле ввода
        // убирает перерисовка: без неё оно осталось бы на экране и следующий
        // символ в нём вернул бы старое значение.
        var wasCustom = customOpen[field.path] === true;
        delete customOpen[field.path];
        setPath(draft, field.path, select.value);
        markChanged();
        // От этого поля зависят чужие списки — перерисовываем экран целиком.
        if (wasCustom || dependencyPaths[field.path]) renderPanel();
      });
      label.appendChild(select);
      if (custom) {
        /* «Другая…» открывает поле рядом со списком, а не вместо него: список
           остаётся на экране и возвращает к готовым вариантам одним выбором.
           Введённое имя сохраняется как есть — код проверяет только символы. */
        var free = document.createElement('input');
        free.type = 'text';
        free.disabled = locked;
        free.value = current;
        free.placeholder = 'Своё значение';
        free.style.marginTop = '6px';
        free.setAttribute('aria-label', field.label + ', своё значение');
        free.addEventListener('input', function () {
          setPath(draft, field.path, free.value);
          markChanged();
        });
        box.appendChild(free);
      }
      if (!known && !custom && current && !field.allowCustom) {
        warnText =
          'Значение «' + current + '» ' + outsideWord(field) +
          ': выберите другое, иначе прогон остановится на проверке настроек.';
      }
    } else if (field.type === 'textarea') {
      var multi = document.createElement('textarea');
      multi.disabled = locked;
      // Многострочный текст: однострочный input вырезал бы переводы строк.
      multi.value = value === undefined || value === null ? '' : String(value);
      multi.addEventListener('input', function () {
        setPath(draft, field.path, multi.value);
        markChanged();
      });
      label.appendChild(multi);
    } else if (field.type === 'list') {
      var area = document.createElement('textarea');
      area.disabled = locked;
      area.value = Array.isArray(value) ? value.join('\\n') : value === undefined ? '' : String(value);
      // Поле под нуль-два логина не должно занимать столько же, сколько поле
      // под десяток команд: высота идёт от содержимого.
      area.rows = Math.min(8, Math.max(2, area.value.split('\\n').length + 1));
      area.className = 'is-rows';
      area.placeholder = 'по одной строке';
      area.addEventListener('input', function () {
        var lines = area.value.split('\\n').map(function (line) { return line.trim(); });
        setPath(draft, field.path, lines.filter(function (line) { return line !== ''; }));
        markChanged();
      });
      label.appendChild(area);
      if (!hintText) hintText = 'Одна строка — одна команда.';
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
          // Пустое поле — это «убрать значение, пусть работает умолчание»:
          // null проходит слияние на сервере, пустая строка ломала проверку.
          setPath(draft, field.path, text.value === '' ? null : Number(text.value));
        } else {
          setPath(draft, field.path, text.value);
        }
        markChanged();
      });
      label.appendChild(text);
    }

    if (!warnText && field.required && isBlank(stored)) {
      warnText = 'Поле обязательное: пока оно пустое, прогон останавливается на проверке настроек.';
    }
    if (hintText) box.appendChild(el('div', 'field-hint', hintText));
    if (warnText) box.appendChild(el('div', 'field-hint is-warn', warnText));
    return box;
  }

  function renderPhases(field, rows) {
    var locked = isLocked();
    var wrap = document.createElement('div');
    var table = el('table', 'phases');
    var head = el('tr');
    ['Milestone', 'Ветка', 'База', ''].forEach(function (title) {
      head.appendChild(el('th', '', title));
    });
    var thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    var body = el('tbody');
    rows.forEach(function (row, index) {
      var tr = el('tr');
      [
        ['milestone', 'Milestone'],
        ['branch', 'Ветка'],
        ['baseBranch', 'База']
      ].forEach(function (column) {
        var td = el('td');
        var input = document.createElement('input');
        input.type = 'text';
        input.disabled = locked;
        input.setAttribute('aria-label', column[1] + ', строка ' + (index + 1));
        input.value = row && row[column[0]] !== undefined && row[column[0]] !== null ? String(row[column[0]]) : '';
        /* Пустая база — это «наследовать базу прогона»: подсказка показывает,
           что подставится, иначе клетка читается как «база не задана». */
        if (column[0] === 'baseBranch') {
          input.placeholder = String((draft && draft.baseBranch) || 'main');
        }
        input.addEventListener('input', function () {
          var list = getPath(draft, field.path);
          if (!Array.isArray(list)) return;
          if (!list[index] || typeof list[index] !== 'object') list[index] = {};
          // Ключ с пустой строкой конфигурация отвергает, отсутствие ключа —
          // разрешает и подставляет базу прогона.
          if (column[0] === 'baseBranch' && input.value === '') delete list[index].baseBranch;
          else list[index][column[0]] = input.value;
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
      list.push({ milestone: '', branch: '' });
      renderPanel();
    });
    wrap.appendChild(add);
    return wrap;
  }

  /* Ключ, вычеркнутый кнопкой, стоит в черновике как null: сервер возвращает из
     файла всё, чего в черновике нет, и только null доживает до шага, который
     убирает ключ из файла. Такой ключ уходит из списка вместе с ним. */
  function keysStillInDraft(keys) {
    return keys.filter(function (key) {
      var value = draft ? getPath(draft, String(key)) : undefined;
      return value !== undefined && value !== null;
    });
  }

  function renderUnknown(keys) {
    var locked = isLocked();
    var section = el('section', 'section');
    section.appendChild(el('h2', 'section-title', 'Не распознано'));
    section.appendChild(el('div', 'section-rule'));
    section.appendChild(
      el(
        'div',
        'note',
        'Пульт эти ключи не знает. Незнакомый ключ верхнего уровня и незнакомый ключ ' +
          'внутри runtime останавливают прогон: конфиг не читается. Ключ внутри review, ' +
          'milestoneReview, validationContainer и фазы прогон пропускает молча и значение ' +
          'его не берёт. Кнопка «Удалить» вычёркивает ключ, кнопка «Сохранить» убирает ' +
          'его из файла.'
      )
    );
    var box = el('div');
    box.style.marginTop = '8px';
    keys.forEach(function (key) {
      var path = String(key);
      var row = el('div', 'unknown-row');
      row.appendChild(el('span', '', path));
      var value = draft ? getPath(draft, path) : undefined;
      row.appendChild(el('span', 'unknown-value', value === undefined ? '—' : JSON.stringify(value)));
      var remove = el('button', 'btn btn-small', 'Удалить');
      remove.type = 'button';
      remove.disabled = locked;
      remove.setAttribute('aria-label', 'Удалить ключ ' + path);
      remove.addEventListener('click', function () {
        if (!draft) return;
        setPath(draft, path, null);
        renderPanel();
      });
      row.appendChild(remove);
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
            res.body.warning || 'Сохранил. Ralph подхватит настройки на следующем прогоне.'
          );
          refreshHash();
          loadState();
        } else {
          /* Отказ ничего не перечитывает: правки остаются на экране вместе с
             объяснением, а отпечаток остаётся прежним — обновить его значило бы
             дать следующему сохранению молча затереть чужую правку. */
          var text = (res.body && res.body.error) || 'Сохранить не удалось';
          showMessage('bad', text);
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

  /* Выбранная вкладка настроек хранится в localStorage: после сохранения и
     перезагрузки человек остаётся там же. В приватном окне доступ к хранилищу
     бросает исключение, поэтому обе стороны в try. */
  function readSettingsTab() {
    try {
      return window.localStorage.getItem(settingsTabKey) || '';
    } catch (error) {
      return '';
    }
  }

  function writeSettingsTab(id) {
    try {
      window.localStorage.setItem(settingsTabKey, id);
    } catch (error) {}
  }

  function selectSettingsTab(id) {
    if (settingsTab === id) return;
    settingsTab = id;
    writeSettingsTab(id);
    // Черновик один на весь экран, поэтому несохранённые правки соседних
    // вкладок переживают переключение.
    renderPanel();
  }

  function renderSubtabs(groups, active) {
    var nav = el('nav', 'subtabs');
    nav.setAttribute('aria-label', 'Разделы настроек');
    groups.forEach(function (group, index) {
      var button = el('button', badFields(group).length ? 'subtab is-warn' : 'subtab', group.title);
      button.type = 'button';
      button.id = 'subtab-' + index;
      /* Та же история, что у боковой навигации: роли вкладок без стрелочной
         навигации врали бы скринридеру, текущую отмечает aria-current. */
      if (index === active) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', function () {
        selectSettingsTab(group.id);
      });
      nav.appendChild(button);
    });
    return nav;
  }

  function renderSettings() {
    var frag = document.createDocumentFragment();

    if (configError) {
      frag.appendChild(el('div', 'empty', configError));
      return frag;
    }
    if (!configData || !draft) {
      // Скелет повторяет форму: заголовок ряда вкладок и поля под ним.
      frag.appendChild(renderSkeleton(['28%', '52%', '38%', '52%', '33%']));
      return frag;
    }

    if (isLocked()) {
      var banner = el('div', 'banner');
      banner.appendChild(el('div', 'banner-title', 'Идёт прогон — пульт не даёт сохранять'));
      banner.appendChild(
        el(
          'div',
          'banner-text',
          configData.lockReason ||
            'Правка файла настроек оборвала бы текущую issue. Сохраните после прогона.'
        )
      );
      frag.appendChild(banner);
    }

    var groups = normalizeGroups(configData.fields);
    if (!groups.length) {
      frag.appendChild(el('div', 'empty', 'Описание полей не пришло с сервера'));
    } else {
      var active = 0;
      groups.forEach(function (group, index) {
        if (group.id === settingsTab) active = index;
      });
      frag.appendChild(renderSubtabs(groups, active));
      // Поле, из-за которого прогон не стартует, на закрытой вкладке иначе
      // осталось бы незамеченным.
      var trouble = [];
      groups.forEach(function (group, index) {
        if (index === active) return;
        badFields(group).forEach(function (field) {
          trouble.push(field.label + ' — вкладка «' + group.title + '»');
        });
      });
      if (trouble.length) {
        frag.appendChild(
          el('div', 'settings-warn', 'Прогон не стартует из-за полей: ' + trouble.join('; ') + '.')
        );
      }
      // Заголовок группы не дублируется: её называет выбранная вкладка.
      var box = el('div');
      box.setAttribute('aria-labelledby', 'subtab-' + active);
      // Поля с одинаковым именем секции, стоящие подряд, образуют озаглавленный
      // блок. Вкладка без секций рисуется одной сеткой.
      var grid = null;
      var currentSection = null;
      groups[active].fields.forEach(function (field) {
        if (!grid || field.section !== currentSection) {
          currentSection = field.section;
          if (currentSection) box.appendChild(el('h2', 'section-title', currentSection));
          grid = el('div', 'grid');
          box.appendChild(grid);
        }
        grid.appendChild(renderField(field));
      });
      frag.appendChild(box);
    }

    var unknown = keysStillInDraft(
      Array.isArray(configData.unknownKeys) ? configData.unknownKeys : []
    );
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

  /* --- вкладка «Команды» --- */

  /* Иконка приезжает со страницей шаблоном и клонируется: собирать SVG
     разметкой значило бы писать innerHTML, а его на странице нет нигде. */
  function iconNode(id) {
    var source = document.getElementById(id);
    if (!source || !source.content) return null;
    return source.content.cloneNode(true);
  }

  function setIcon(button, id) {
    clear(button);
    var node = iconNode(id);
    if (node) button.appendChild(node);
  }

  function resetCopy(ui) {
    if (ui.status.resetTimer) window.clearTimeout(ui.status.resetTimer);
    ui.status.textContent = '';
    ui.status.className = 'command-status';
    ui.button.className = 'command-copy';
    setIcon(ui.button, 'icon-copy');
  }

  /* Исход клика пишется в отдельный узел role="status", а не в имя кнопки: имя
     читается один раз, и подмена его до скринридера не доходила. Кнопка тем
     временем меняет рисунок на галочку — глазу этого достаточно. Успех гаснет
     через полторы секунды, отказ — только на следующем клике: «Скопируйте
     вручную» — задание человеку, и пропустить его дороже, чем увидеть лишний
     раз. */
  function markCopy(ui, kind, text) {
    if (ui.status.resetTimer) window.clearTimeout(ui.status.resetTimer);
    ui.status.textContent = text;
    ui.status.className = 'command-status is-' + kind;
    if (kind !== 'ok') return;
    ui.button.className = 'command-copy is-ok';
    setIcon(ui.button, 'icon-check');
    ui.status.resetTimer = window.setTimeout(function () {
      resetCopy(ui);
    }, 1600);
  }

  /* Буфер отказал — человек копирует сам: текст команды выделен, остаётся
     нажать Ctrl+C. */
  function manualCopy(ui) {
    try {
      var range = document.createRange();
      range.selectNodeContents(ui.name);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (error) {
      // Выделение — подсказка, а не результат: без него сообщение всё равно верно.
    }
    markCopy(ui, 'bad', 'Скопируйте вручную: Ctrl+C');
  }

  /* Запасной путь нужен не ради старых браузеров: navigator.clipboard живёт
     только в защищённом контексте, а пульт открывается по http://127.0.0.1
     и в части браузеров этот API там отсутствует. */
  function copyFallback(text, ui) {
    var focused = document.activeElement;
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    document.body.removeChild(area);
    // Фокус возвращается туда, откуда пришёл клик: иначе нажавший Enter на
    // кнопке окажется на body, и следующий Tab начнёт обход страницы заново.
    if (focused && focused.focus) focused.focus();
    if (copied) markCopy(ui, 'ok', 'Скопировано');
    else manualCopy(ui);
  }

  function copyCommand(text, ui) {
    resetCopy(ui);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          markCopy(ui, 'ok', 'Скопировано');
        },
        function () {
          // Обработчик отклонённого промиса выполняется уже вне жеста
          // пользователя, а там Safari отклоняет и execCommand: запасной путь
          // отсюда вернул бы false, поэтому сразу просим скопировать руками.
          manualCopy(ui);
        }
      );
      return;
    }
    copyFallback(text, ui);
  }

  /* Метка и текст — две ячейки одной сетки: метки выстраиваются в столбик, и
     нужное поле находится взглядом, а не чтением абзаца целиком.

     Метка при этом кнопка: поле сворачивается отдельно от соседних, иначе три
     ответа подряд у каждой команды сливаются в стену текста. «Делает» открыто
     всегда — свёрнутый список из одних меток не говорит, о чём команда.
     Роль region панели не дают: таких панелей на странице два десятка, и
     скринридер получил бы столько же одинаковых ориентиров. */
  function commandLine(lead, text, open, key) {
    var line = el('div', 'command-line');
    var button = el('button', 'command-lead');
    button.type = 'button';
    button.appendChild(el('span', '', lead));
    var mark = el('span', 'command-mark');
    button.appendChild(mark);

    var body = el('p', 'command-text', text);
    body.id = key;

    function apply(next) {
      button.setAttribute('aria-expanded', next ? 'true' : 'false');
      body.hidden = !next;
      // Знак говорит про следующий клик: плюс раскроет поле, крест закроет.
      setIcon(mark, next ? 'icon-close' : 'icon-plus');
    }

    button.setAttribute('aria-controls', key);
    apply(open);
    button.addEventListener('click', function () {
      apply(button.getAttribute('aria-expanded') !== 'true');
    });

    line.appendChild(button);
    line.appendChild(body);
    return line;
  }

  function renderCommands() {
    var frag = document.createDocumentFragment();
    var index = 0;

    /* Команды терминала и команды чата набирают в разных местах: вперемешку
       они читаются как один длинный список, поэтому группа выбирается вкладкой
       и на экране всегда одна. */
    var tabs = el('nav', 'commands-tabs');
    tabs.setAttribute('aria-label', 'Где набирают команды');
    commandGuide.forEach(function (group, position) {
      var button = el('button', 'commands-tab', group.title);
      button.type = 'button';
      if (position === commandsGroup) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', function () {
        if (commandsGroup === position) return;
        commandsGroup = position;
        renderPanel();
      });
      tabs.appendChild(button);
    });
    frag.appendChild(tabs);

    var groups = commandGuide[commandsGroup] ? [commandGuide[commandsGroup]] : commandGuide;
    groups.forEach(function (group) {
      if (group.note) frag.appendChild(el('p', 'commands-note', group.note));
      group.items.forEach(function (item) {
        index += 1;
        // Скилл зовут по имени, поэтому красится оно, а не путь за ним.
        var box = el('div', item.command.charAt(0) === '/' ? 'command is-skill' : 'command');

        // Заголовок есть не у всех: скилл называет себя сам, а четыре команды
        // терминала начинаются одним путём и различаются только им.
        if (item.title) box.appendChild(el('h3', 'command-title', item.title));

        // Над карточками полей: сама команда, кнопка копирования и исход клика.
        var side = el('div', 'command-side');
        var row = el('div', 'command-row');
        /* Приглашение стоит вне узла команды: текст этого узла выделяют, когда
           буфер отказал, и доллар попал бы в терминал вместе с командой. В чате
           агента приглашения нет — там команду вводят строкой сообщения. */
        if (item.command.charAt(0) !== '/') {
          var prompt = el('span', 'command-prompt', '$');
          prompt.setAttribute('aria-hidden', 'true');
          row.appendChild(prompt);
        }
        // Части команды красятся по отдельности, как в терминале. Текст узла
        // при этом равен самой команде: его читает скринридер и выделяет
        // человек, когда буфер отказал.
        var name = el('code', 'command-name');
        name.id = 'command-' + index;
        (item.tokens || []).forEach(function (token, position) {
          if (position > 0) name.appendChild(document.createTextNode(' '));
          name.appendChild(el('span', 'cmd-' + token.kind, token.text));
        });
        row.appendChild(name);

        var copy = el('button', 'command-copy');
        copy.type = 'button';
        // Текста у кнопки нет, поэтому действие называет подпись, а саму
        // команду кнопка получает описанием.
        copy.setAttribute('aria-label', 'Копировать');
        copy.setAttribute('aria-describedby', name.id);
        copy.title = 'Копировать';
        setIcon(copy, 'icon-copy');
        var status = el('span', 'command-status');
        status.setAttribute('role', 'status');
        var ui = { button: copy, status: status, name: name };
        copy.addEventListener('click', function () {
          copyCommand(item.command, ui);
        });
        row.appendChild(copy);
        side.appendChild(row);
        side.appendChild(status);
        box.appendChild(side);

        // Объяснение: что команда делает, когда её звать и чего не делает.
        // Открыто первое поле, два других человек раскрывает сам.
        var body = el('div', 'command-body');
        body.appendChild(commandLine('Делает', item.does, true, 'command-does-' + index));
        body.appendChild(commandLine('Когда звать', item.when, false, 'command-when-' + index));
        body.appendChild(commandLine('Не делает', item.omits, false, 'command-omits-' + index));
        box.appendChild(body);
        frag.appendChild(box);
      });
    });
    return frag;
  }

  /* --- переключение вкладок --- */

  function renderPanel() {
    clear(panel);
    panel.setAttribute('aria-labelledby', 'tab-' + tab);
    if (tab === 'usage') panel.appendChild(renderUsage());
    else if (tab === 'settings') panel.appendChild(renderSettings());
    // Явное имя вкладки, а не else: новая вкладка без своей ветки оставит
    // панель пустой, и отказ будет видно здесь, а не в чужом содержимом.
    else if (tab === 'commands') panel.appendChild(renderCommands());
  }

  function selectTab(next) {
    tab = next;
    if (tabTitles[tab]) {
      if (headTitle) headTitle.textContent = tabTitles[tab][0];
      if (headNote) headNote.textContent = tabTitles[tab][1];
    }
    /* Разделы — не вкладки ARIA: роль tab обещает переключение стрелками,
       которого здесь нет. Текущий раздел отмечает aria-current. */
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (button) {
      if (button.getAttribute('data-tab') === tab) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    // Неудачный запрос повторяется при возврате на вкладку: иначе одна ошибка
    // держится до перезагрузки страницы.
    if (tab === 'usage' && !tasksData) loadTasks();
    if (tab === 'settings' && (!configData || !isDirty())) loadConfig();
    renderPanel();
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (button) {
    button.addEventListener('click', function () {
      selectTab(button.getAttribute('data-tab'));
    });
  });

  /* --- боковая панель --- */

  /* Свёрнутая панель переживает перезагрузку: состояние в localStorage.
     В приватном окне доступ к хранилищу бросает исключение — обе стороны
     в try, отказ хранилища оставляет панель развёрнутой. */
  var railKey = 'ralph-gui-rail';
  var app = document.getElementById('app');
  var sideToggle = document.getElementById('side-toggle');

  function readRail() {
    try {
      return window.localStorage.getItem(railKey) === '1';
    } catch (error) {
      return false;
    }
  }

  function writeRail(on) {
    try {
      window.localStorage.setItem(railKey, on ? '1' : '0');
    } catch (error) {}
  }

  function applyRail(on) {
    if (app) app.className = on ? 'app is-rail' : 'app';
    if (!sideToggle) return;
    sideToggle.setAttribute('aria-expanded', on ? 'false' : 'true');
    // Подпись меняется вместе с действием: в рейке она скрыта визуально,
    // но именно её читает скринридер.
    var label = sideToggle.querySelector('.tab-label');
    if (label) label.textContent = on ? 'Развернуть' : 'Свернуть';
  }

  var rail = readRail();
  applyRail(rail);
  if (sideToggle) {
    sideToggle.addEventListener('click', function () {
      rail = !rail;
      writeRail(rail);
      applyRail(rail);
    });
  }

  renderStatus();
  renderPanel();
  loadState();
  loadTasks();
  /* Один таймер на обе вкладки: журнал дописывается после каждой попытки, и без
     опроса цифры расхода застывали бы на моменте открытия страницы. */
  setInterval(function () {
    loadState();
    if (tab === 'usage') loadTasks();
  }, 15000);
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
