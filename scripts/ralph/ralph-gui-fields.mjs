/**
 * Описание полей `.agents/ralph.config.json` для формы настроек GUI.
 *
 * Здесь только данные: ни чтения файлов, ни HTTP, ни HTML. Источник истины по
 * поведению — `ralph-config.mjs`, и каждый `path` ниже встречается в нём. Если
 * ключ добавили в конфигурацию, но не в этот файл, GUI покажет его в
 * `unknownKeys`, а не потеряет.
 *
 * Поля формы:
 * - `path`     — путь до значения через точку (`runtime.commandTimeoutMs`).
 *                Массив фаз редактируется целиком, у него тип `phases`.
 * - `type`     — 'boolean' | 'number' | 'text' | 'textarea' | 'select' |
 *                'list' | 'phases'. 'list' — массив строк, по строке на
 *                элемент.
 * - `options`  — только у 'select'. Простой массив значений, когда список ни от
 *                чего не зависит; объект-карта, когда зависит: ключ — значение
 *                поля, названного в `optionsDependOn`, значение — массив
 *                вариантов. `optionsDependOn` задаётся только вместе с картой.
 * - `allowCustom` — только у 'select': форма разрешает ввести своё значение
 * - `emptyAsNull` — пустое текстовое поле удаляет ключ и включает умолчание
 *                пунктом «Другая…». Ставится там, где код проверяет не список,
 *                а форму значения.
 * - `required` — поле обязательно: пустое значение останавливает загрузку
 *                конфига, поэтому форма помечает его предупреждением и метит
 *                вкладку, на которой оно лежит.
 * - `unit`     — 'мс' или null; единица дописывается к полю ввода.
 * - `default`  — значение по умолчанию из кода. null означает, что умолчания
 *                нет: поле обязательно (`prompt`, `phases`,
 *                `approvedIssueSnapshotsHash`), вычисляется при
 *                загрузке или подставляется
 *                только вместе со всем родительским объектом. Третий случай —
 *                `enabled`, `schemaFile` и `outputFile` у `review` и
 *                `milestoneReview` плюс `milestoneReview.model`:
 *                `applyValidationAndReviewDefaults` в `ralph-config.mjs`
 *                подставляет их только вместе с целым объектом, а удаление
 *                одного такого ключа останавливает прогон. Остальные ключи
 *                этих объектов своё умолчание имеют, и форма его показывает.
 *
 * Групп ровно пять, и каждая становится вкладкой формы; `id` группы — якорь
 * вкладки.
 *
 * Необязательное поле `section` собирает соседние поля в озаглавленный блок
 * внутри вкладки. Порядок полей в массиве и есть порядок блоков: поля одного
 * блока идут подряд.
 *
 * Словарь текстов один на весь пульт: объект GitHub называется своим именем в
 * GitHub (`issue`, `milestone`, `pull request`), параметр CLI — своим именем в
 * CLI (`effort`, `CLI`), а наши внутренние понятия — по-русски (`фаза`,
 * `прогон`, `проверки`, `запомненный текст issue`). Фаза и milestone — разное:
 * фаза связывает milestone с рабочей веткой и её базой.
 */

import { agentClis, reasoningEffortsFor } from './ralph-agent-backends.mjs';
import { codexModels } from './ralph-codex-session.mjs';

// Наборы reasoning effort различаются у двух CLI. Здесь они не копируются, а
// берутся у того же источника, что и проверка конфигурации в
// `validateAgentRoles`, — иначе списки разойдутся в день, когда у CLI появится
// новое значение. Цепочка импорта уже загружена процессом пульта через
// `ralph-config.mjs`, так что она ничего не стоит.
const effortOptions = Object.fromEntries(agentClis.map((cli) => [cli, reasoningEffortsFor(cli)]));

// Имена моделей код списком не ограничивает: `validateAgentRoles` проверяет
// только безопасность символов. Поэтому у полей модели стоит `allowCustom` —
// список здесь подсказка, а не запрет, и новая модель вводится руками.
const claudeModels = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
];

export const fieldGroups = [
  {
    id: 'run',
    title: 'Основное',
    fields: [
      {
        path: 'active',
        section: 'Запуск',
        label: 'Ralph включён',
        type: 'boolean',
        hint: 'Пока выключен, обе команды — и --check, и --run — печатают строку о выключении и выходят.',
        unit: null,
        default: null,
      },
      {
        path: 'agentCli',
        section: 'Запуск',
        label: 'Агент',
        type: 'select',
        options: ['codex', 'claude'],
        hint: 'Кто пишет код и делает ревью: Claude Code или Codex. От выбора зависит, какие значения effort доступны.',
        unit: null,
        default: 'codex',
      },
      {
        path: 'githubAccount',
        section: 'Запуск',
        label: 'Аккаунт GitHub',
        type: 'text',
        emptyAsNull: true,
        hint: 'Login аккаунта из gh auth status. Ralph использует его для команд gh и сетевых команд Git, не меняя глобальный active account. Origin должен быть HTTPS-адресом github.com. Пустое поле оставляет обычную авторизацию gh и Git.',
        unit: null,
        default: null,
      },
      {
        path: 'stopAfterFirstIssue',
        section: 'Запуск',
        label: 'Остановиться после первой issue',
        type: 'boolean',
        hint: 'Ralph выполнит одну issue и остановится. Коммит сделает, ветку отправит, pull request создавать не станет. Режим для проверки настроек.',
        unit: null,
        default: false,
      },
      {
        path: 'baseBranch',
        section: 'Ветки и pull request',
        label: 'Базовая ветка',
        type: 'text',
        hint: 'От неё Ralph создаёт ветку каждой фазы и в неё же направляет pull request. Фаза может задать свою базу вместо этой.',
        unit: null,
        default: 'main',
      },
      {
        path: 'syncBaseBranch',
        section: 'Ветки и pull request',
        label: 'Подтягивать базовую ветку',
        type: 'boolean',
        hint: 'Перед началом фазы Ralph вливает базовую ветку в рабочую, чтобы код писался поверх свежего.',
        unit: null,
        default: true,
      },
      {
        path: 'draftPullRequest',
        section: 'Ветки и pull request',
        label: 'Pull request черновиком',
        type: 'boolean',
        hint: 'Ralph открывает pull request черновиком и сам его оттуда не выводит. Снять черновик и слить — ваша работа.',
        unit: null,
        default: true,
      },
      {
        path: 'autoApproveConfiguredIssues',
        section: 'Откуда берутся issues',
        label: 'Одобрять issues автоматически',
        type: 'boolean',
        hint:
          'Ralph запоминает заголовок и тело issue в тот момент, когда берёт её в работу. Правка issue на GitHub после этого останавливает прогон. Выключите — и текст каждой issue придётся вписать в журнал одобренных issues руками, а рядом обновить контрольную сумму журнала.',
        unit: null,
        default: true,
      },
      {
        path: 'trustedIssueAuthors',
        section: 'Откуда берутся issues',
        label: 'Доверенные авторы issues',
        type: 'list',
        hint: 'Логины на GitHub, чьи issues Ralph берёт без ручного одобрения. Владелец репозитория доверен всегда, вписывать его не нужно.',
        unit: null,
        default: [],
      },
      {
        path: 'approvedIssueSnapshotsFile',
        section: 'Откуда берутся issues',
        label: 'Журнал одобренных issues',
        type: 'text',
        hint:
          'Отсюда Ralph читает issues, одобренные вручную. Сам он в этот журнал не пишет: при автоодобрении запомненный текст лежит в состоянии прогона и уходит вместе с ним. Путь считается от корня проекта. Содержимое защищено контрольной суммой из соседнего поля: правка журнала без правки суммы останавливает прогон.',
        unit: null,
        default: 'scripts/ralph/approved-issues.json',
      },
      {
        path: 'approvedIssueSnapshotsHash',
        section: 'Откуда берутся issues',
        label: 'Контрольная сумма журнала одобренных issues',
        type: 'text',
        hint:
          'Отпечаток журнала одобренных issues: 64 знака. Ralph считает его при каждом запуске и сверяет с этим полем, поэтому чужая правка журнала останавливает прогон. Правите журнал сами — впишите сюда новую сумму. Считать её руками не нужно: оставьте поле пустым и нажмите «Сохранить» — ответ назовёт текущую сумму журнала.',
        unit: null,
        default: null,
        required: true,
      },
    ],
  },
  {
    id: 'phases',
    title: 'Фазы',
    fields: [
      {
        path: 'phases',
        label: 'Список фаз',
        type: 'phases',
        hint: 'Ralph идёт по фазам сверху вниз. Одна фаза — это один milestone GitHub, ветка для его issues и база, от которой ветка растёт. Пустая клетка базы означает базовую ветку со вкладки «Основное». Имя milestone скопируйте из GitHub точно, до символа. Milestone и ветки не повторяются, ветка не совпадает со своей базой.',
        unit: null,
        default: null,
        required: true,
      },
    ],
  },
  {
    id: 'limits',
    title: 'Лимиты',
    fields: [
      {
        path: 'maxIterations',
        section: 'Объём прогона',
        label: 'Итераций на фазу',
        type: 'number',
        hint:
          'Итерация — одна сессия разработки по одной issue. Счётчик живёт в состоянии прогона и переживает перезапуск. На каждой новой фазе он обнуляется, поэтому план из трёх фаз потратит это число трижды. На пределе Ralph останавливается с ошибкой: работа остаётся в ветке, pull request он не создаёт. Поднимите число — следующий запуск продолжит с того же места.',
        unit: null,
        default: 20,
      },
      {
        path: 'maxTurns',
        section: 'Объём прогона',
        label: 'Шагов в сессии агента',
        type: 'number',
        hint:
          'Шаг у Claude — ответ модели, у Codex — любой элемент сессии, включая выполненную команду; одно и то же число даёт им разный объём работы. На пределе Ralph убивает сессию. Сессия разработки работу не теряет: та же issue уходит в следующую итерацию, но потраченную итерацию Ralph не возвращает. Сессия ревью на этом же пределе останавливает прогон. Значение действует на разработку и на ревью issue; у ревью milestone своё поле.',
        unit: null,
        default: 50,
      },
      {
        path: 'maxTestFixAttempts',
        section: 'Объём прогона',
        label: 'Попыток пройти проверки',
        type: 'number',
        hint: 'Проверки упали — Ralph отдаёт ошибку агенту и повторяет работу над той же issue. После этого числа попыток прогон останавливается с ошибкой.',
        unit: null,
        default: 5,
      },
      {
        path: 'maxReviewFixAttempts',
        section: 'Объём прогона',
        label: 'Отказов ревью подряд',
        type: 'number',
        hint: 'Ревью отклонило работу — issue возвращается в очередь с замечаниями в теле. После этого числа отказов подряд Ralph откладывает её до конца прогона и берёт следующую. Отложенная issue не даёт закрыть milestone.',
        unit: null,
        default: 3,
      },
      {
        path: 'runtime.reviewRetryAttempts',
        section: 'Объём прогона',
        label: 'Повторов сессии ревью',
        type: 'number',
        hint:
          'Считается только техническая ошибка: сессия упала или не отдала файл результата. Таймаут и лимит шагов повтору не подлежат — на них Ralph останавливает прогон сразу. Отказ ревью по существу сюда тоже не входит. От 1 до 5: попытка — это целая сессия агента, минуты и сотни тысяч токенов. Когда попытки кончились, коммит сохраняется, и следующий запуск повторит ревью без повторной реализации.',
        unit: null,
        default: 3,
      },
      {
        path: 'runtime.networkRetryAttempts',
        section: 'Сетевые команды',
        label: 'Повторов сетевой команды',
        type: 'number',
        hint: 'Ralph повторяет команду к GitHub или git, когда та упала по временной причине: таймаут, обрыв связи, ответ 5xx. От 1 до 60: попытка стоит секунд ожидания, поэтому запас большой.',
        unit: null,
        default: 3,
      },
      {
        path: 'runtime.networkRetryBaseDelayMs',
        section: 'Сетевые команды',
        label: 'Пауза перед первым повтором',
        type: 'number',
        hint: 'Перед каждым следующим повтором пауза удваивается и упирается в 30 секунд. 2000 — две секунды.',
        unit: 'мс',
        default: 2000,
      },
      {
        path: 'runtime.maxPages',
        section: 'Сетевые команды',
        label: 'Страниц ответа GitHub',
        type: 'number',
        hint: 'Списки issues и pull request приходят по 100 объектов на страницу. От 1 до 100 страниц. Когда список не помещается, Ralph падает с ошибкой, а не берёт в работу обрезанную очередь.',
        unit: null,
        default: 20,
      },
      {
        path: 'runtime.commandTimeoutMs',
        section: 'Таймауты',
        label: 'Таймаут обычной команды',
        type: 'number',
        hint:
          'Сколько Ralph ждёт команду git или gh. На пределе он убивает процесс и считает команду упавшей. Команды к сети — fetch, push, запросы к GitHub — после этого повторяются, остальные нет. 300000 — пять минут.',
        unit: 'мс',
        default: 300000,
      },
      {
        path: 'runtime.validationTimeoutMs',
        section: 'Таймауты',
        label: 'Таймаут коммита',
        type: 'number',
        hint: 'Сколько Ralph ждёт git-коммит выполненной работы. На пределе коммит обрывается, и прогон останавливается на этой issue. 1800000 — 30 минут.',
        unit: 'мс',
        default: 1800000,
      },
      {
        path: 'runtime.validationRunTimeoutMs',
        section: 'Таймауты',
        label: 'Таймаут прогона проверок',
        type: 'number',
        hint: 'Сколько Ralph ждёт весь набор команд проверок. На пределе прогон проверок прерывается, они считаются упавшими, попытка уходит в счётчик «Попыток пройти проверки». 3600000 — час.',
        unit: 'мс',
        default: 3600000,
      },
      {
        path: 'runtime.agentTimeoutMs',
        section: 'Таймауты',
        label: 'Таймаут сессии агента',
        type: 'number',
        hint: 'Сколько Ralph ждёт одну сессию CLI — разработку или ревью. На пределе процесс убивается, сессия считается упавшей. 5400000 — полтора часа.',
        unit: 'мс',
        default: 5400000,
      },
    ],
  },
  {
    id: 'agent',
    title: 'Разработка и ревью',
    fields: [
      {
        path: 'developmentModel',
        section: 'Разработка',
        label: 'Модель разработки',
        type: 'select',
        options: { codex: codexModels, claude: claudeModels },
        optionsDependOn: 'agentCli',
        allowCustom: true,
        hint: 'Эта модель пишет код по issue. Список зависит от поля «Агент» и ничего не запрещает: новое имя вводят пунктом «Другая…».',
        unit: null,
        default: 'gpt-5.6-terra',
      },
      {
        path: 'developmentEffort',
        section: 'Разработка',
        label: 'Effort разработки',
        type: 'select',
        options: effortOptions,
        optionsDependOn: 'agentCli',
        hint: 'Effort — глубина рассуждения модели. Выше значение — дороже и дольше сессия. Набор значений задаёт CLI. Список перерисовывается при смене поля «Агент».',
        unit: null,
        default: 'medium',
      },
      {
        path: 'developmentSkills',
        section: 'Разработка',
        label: 'Скиллы прогона',
        type: 'list',
        hint: 'Имена скиллов проекта из .agents/skills или .claude/skills — например, правила вашего стека. Ralph впишет описание и путь каждого в prompt задачи, и агент прочитает файл по ходу работы. Инструмент Skill автономной сессии не выдаётся; опечатка в имени останавливает --check.',
        unit: null,
        default: [],
      },
      {
        path: 'prompt',
        section: 'Разработка',
        label: 'Текст задания',
        type: 'textarea',
        hint: 'С этого текста начинается сессия разработки. Ralph подставляет вместо {issue_number}, {issue_title}, {issue_url}, {milestone}, {branch}, {max_turns}, {max_test_fix_attempts} значения текущей issue и настроек. Поле обязательное: без него прогон не стартует.',
        unit: null,
        default: null,
        required: true,
      },
      {
        path: 'rulesFile',
        section: 'Разработка',
        label: 'Файл правил сессии',
        type: 'text',
        hint: 'Правила из файла дописываются к заданию разработки; ревьюеры их не получают. Путь считается от корня проекта, файл обязан существовать. Те же подстановки работают и в нём.',
        unit: null,
        default: '.agents/ralph-rules.md',
      },
      {
        path: 'review.enabled',
        section: 'Ревью каждой issue',
        label: 'Проверять каждую issue',
        type: 'boolean',
        hint: 'Включено — отдельная сессия читает уже закоммиченный и отправленный код, и без её PASS issue не закрывается. Выключено — Ralph закрывает issue сразу после проверок.',
        unit: null,
        default: null,
      },
      {
        path: 'review.model',
        section: 'Ревью каждой issue',
        label: 'Модель ревью issue',
        type: 'select',
        options: { codex: codexModels, claude: claudeModels },
        optionsDependOn: 'agentCli',
        allowCustom: true,
        hint: 'Читает изменения одной issue и ничего не правит: сессия работает только на чтение. Список зависит от поля «Агент», своё имя вводят пунктом «Другая…».',
        unit: null,
        default: 'gpt-5.6-terra',
      },
      {
        path: 'review.effort',
        section: 'Ревью каждой issue',
        label: 'Effort ревью issue',
        type: 'select',
        options: effortOptions,
        optionsDependOn: 'agentCli',
        hint: 'Глубина рассуждения ревьюера. Набор значений задаёт CLI, как и у разработки.',
        unit: null,
        default: 'medium',
      },
      {
        path: 'reviewSeverityFloor',
        section: 'Ревью каждой issue',
        label: 'Порог важности замечаний',
        type: 'select',
        options: ['P0', 'P1', 'P2', 'P3'],
        hint:
          'P0 — самое важное замечание, P3 — самое мелкое. Замечание ниже порога не отклоняет работу и не мешает закрыть milestone. Порог P3 отклоняет работу на любом замечании: issue уходит на переделку чаще, а прогон тратит на неё больше итераций и токенов. Порог P1 пропускает P2 и P3. Пропущенное замечание не теряется: Ralph записывает его в issue с меткой ralph-deferred и без milestone, поэтому в очередь прогона она не попадает. Замечания к одному файлу он собирает в одну issue: P0 с P1, P2 с P3. Порог действует и на ревью issue, и на ревью milestone.',
        unit: null,
        default: 'P3',
      },
      {
        path: 'review.schemaFile',
        section: 'Ревью каждой issue',
        label: 'Схема ответа ревью',
        type: 'text',
        hint: 'JSON-схема, в которой ревьюер обязан отдать вердикт и замечания; CLI получает её вместе с заданием. Путь считается от корня проекта. Ответ не по схеме останавливает прогон.',
        unit: null,
        default: null,
      },
      {
        path: 'review.outputFile',
        section: 'Ревью каждой issue',
        label: 'Файл результата ревью',
        type: 'text',
        hint: 'Сюда ревьюер пишет вердикт. Ralph удаляет файл перед сессией и читает после неё, поэтому в файле лежит результат последнего ревью.',
        unit: null,
        default: null,
      },
      {
        path: 'reviewDiffExcludedPaths',
        section: 'Ревью каждой issue',
        label: 'Файлы без diff в ревью',
        type: 'list',
        hint: 'Пути, чей построчный diff ревьюер issue не получает: сгенерированный файл вроде lock-файла меняется на сотни строк от одной зависимости и вытесняет из бюджета продуктовый код. Файл остаётся в списке изменений и в статистике, исчезает только его diff. По пути на строку, от корня проекта. На ревью milestone поле не действует: там по тем же соображениям исключён control plane.',
        unit: null,
        default: [],
      },
      {
        path: 'milestoneReview.enabled',
        section: 'Ревью milestone',
        label: 'Проверять milestone перед закрытием',
        type: 'boolean',
        hint:
          'Включено — когда открытых issues не осталось, отдельная сессия проверяет весь milestone разом по его pull request, и только после её PASS Ralph закрывает milestone. Отказ запускает следующий круг: Ralph заводит issues на замечания, ждёт исправления и проверяет снова. Круг — один такой заход. Выключено — Ralph закрывает milestone сразу после последней issue.',
        unit: null,
        default: null,
      },
      {
        path: 'milestoneReview.model',
        section: 'Ревью milestone',
        label: 'Модель ревью milestone',
        type: 'select',
        options: { codex: codexModels, claude: claudeModels },
        optionsDependOn: 'agentCli',
        allowCustom: true,
        hint:
          'Читает изменения всего milestone разом, поэтому её берут сильнее, чем модель ревью одной issue. Смена модели заставляет следующий круг проверить milestone целиком. Своё имя вводят пунктом «Другая…».',
        unit: null,
        default: null,
      },
      {
        path: 'milestoneReview.effort',
        section: 'Ревью milestone',
        label: 'Effort ревью milestone',
        type: 'select',
        options: effortOptions,
        optionsDependOn: 'agentCli',
        hint:
          'Глубина рассуждения на проверке milestone. Набор значений задаёт CLI. Смена значения, как и смена модели, возвращает следующий круг к полной проверке.',
        unit: null,
        default: 'high',
      },
      {
        path: 'milestoneReview.maxTurns',
        section: 'Ревью milestone',
        label: 'Шагов в сессии ревью milestone',
        type: 'number',
        hint:
          'Своё ограничение шагов для проверки milestone: она читает больше кода, чем ревью одной issue. Без значения Ralph берёт «Шагов в сессии агента».',
        unit: null,
        default: null,
      },
      {
        path: 'milestoneReview.maxFindings',
        section: 'Ревью milestone',
        label: 'Замечаний за круг',
        type: 'number',
        hint:
          'Ralph берёт в работу не больше этого числа замечаний за круг; остальные ждут следующего. От 1 до 50. Задачи он собирает пачками: замечания к одному файлу идут в одну issue, P0 с P1 и P2 с P3, до пяти замечаний в issue. Круг, где замечания обрезал этот предел, не даёт сузить следующий: тот прочитает milestone целиком.',
        unit: null,
        default: 10,
      },
      {
        path: 'milestoneReview.incremental',
        section: 'Ревью milestone',
        label: 'Проверять только новые коммиты',
        type: 'boolean',
        hint:
          'Включено — со второго круга ревьюер читает коммиты после уже проверенного и закрытие прежних замечаний, а не весь milestone заново. К полной проверке Ralph возвращается сам: после force-push, влитой базы, смены модели или effort, обрезки замечаний пределом. Выключено — каждый круг читает milestone целиком.',
        unit: null,
        default: true,
      },
      {
        path: 'milestoneReview.schemaFile',
        section: 'Ревью milestone',
        label: 'Схема ответа ревью milestone',
        type: 'text',
        hint:
          'JSON-схема ответа для проверки milestone; путь считается от корня проекта. Ответ не по схеме останавливает прогон.',
        unit: null,
        default: null,
      },
      {
        path: 'milestoneReview.outputFile',
        section: 'Ревью milestone',
        label: 'Файл результата ревью milestone',
        type: 'text',
        hint: 'Сюда ревьюер пишет вердикт круга, а Ralph публикует его комментарием в pull request. Файл перезаписывается каждым кругом.',
        unit: null,
        default: null,
      },
    ],
  },
  {
    id: 'validation',
    title: 'Проверки',
    fields: [
      {
        path: 'preflightScripts',
        label: 'Команды подготовки',
        type: 'list',
        hint:
          'Готовят окружение: миграции, генерация кода, установка зависимостей. Ralph выполняет их в начале каждой фазы, а потом первыми перед каждым набором проверок. Цепочки запрещены: одна команда на строку. До 500 символов, перенос строки внутри команды запрещён.',
        unit: null,
        default: [],
      },
      {
        path: 'validationScripts',
        label: 'Команды проверок',
        type: 'list',
        hint: 'Доказывают, что изменение работает: линтер, сборка, тесты. Ralph выполняет строки подряд и останавливается на первой ошибке. Цепочки запрещены: одна команда на строку. До 500 символов, перенос строки внутри команды запрещён.',
        unit: null,
        default: [],
      },
      {
        path: 'validationEnvironment',
        label: 'Переменные проверок',
        type: 'list',
        hint:
          'Переменные окружения в формате NAME=value. Используйте только значения для локальной проверки. Не храните здесь production-секреты.',
        unit: null,
        default: [],
      },
      {
        path: 'validationArtifactPaths',
        label: 'Артефакты проверок',
        type: 'list',
        hint: 'Каталоги и файлы, которые проверки создают сами: отчёты, трассы, покрытие. Ralph удаляет их перед прогоном, чтобы отчёт прошлой итерации не попал под следующий линтер. Пути относительные, внутри проекта; путь, отслеживаемый Git, Ralph не удаляет, а останавливает прогон.',
        unit: null,
        default: [],
      },
    ],
  },
];

// Неподтверждённых ключей нет: каждый ключ из `.agents/ralph.config.json`
// встречается в `ralph-config.mjs`, и обратно — каждый ключ, который читает
// `ralph-config.mjs`, описан выше. Одного ключа нет в текущем
// `.agents/ralph.config.json`, но код его читает: `reviewDiffExcludedPaths`
// (использование в `ralph-loop.mjs` и `ralph-git.mjs`). Пустой список значит
// «ничего», поэтому форма показывает умолчание `[]`.
//
// Значения, помеченные `default: null`, обязательны: конфиг без `prompt`,
// `phases` или `approvedIssueSnapshotsHash` отклоняется.
// `milestoneReview.maxTurns` без явного значения равен `maxTurns`. Форма умеет
// показать только константу, а не ссылку на соседнее поле, поэтому умолчание
// здесь `null`: пустое поле остаётся пустым, а связь объясняет подсказка.
//
// Вычисляемые поля объекта конфигурации — `phasePlanId`, `milestone`, `branch`,
// `rulesPath`, `approvedIssueSnapshots`, `approvedIssueSnapshotsPath`,
// `review.schemaPath`, `review.outputPath`, `milestoneReview.schemaPath`,
// `milestoneReview.outputPath`, `agentInstructionFiles`,
// `trustedControlFileHashes` — в форму не выносятся: их пишет `loadConfig`, в
// файле настроек их нет.
