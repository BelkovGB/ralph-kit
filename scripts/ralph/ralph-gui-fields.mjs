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
 *                пунктом «Другая…». Ставится там, где код проверяет не список,
 *                а форму значения.
 * - `unit`     — 'мс' или null; единица дописывается к полю ввода.
 * - `default`  — значение по умолчанию из кода. null означает, что умолчания
 *                нет: поле обязательно (`prompt`, `phases`), вычисляется при
 *                загрузке (`validationContainer.image`) или подставляется
 *                только вместе со всем родительским объектом. Третий случай —
 *                ключи внутри `review`, `milestoneReview` и
 *                `validationContainer`: `applyValidationAndReviewDefaults`
 *                в `ralph-config.mjs` заполняет эти объекты целиком, а
 *                одиночный удалённый ключ внутри них останавливает прогон, и
 *                обещать умолчание форме нельзя.
 *
 * Групп ровно пять, и каждая становится вкладкой формы; `id` группы — якорь
 * вкладки.
 */

import { agentClis, reasoningEffortsFor } from './ralph-agent-backends.mjs';

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
    title: 'Прогон',
    fields: [
      {
        path: 'active',
        label: 'Ralph включён',
        type: 'boolean',
        hint: 'Выключенный Ralph не запускается даже командой --run.',
        unit: null,
        default: null,
      },
      {
        path: 'agentCli',
        label: 'CLI агента',
        type: 'select',
        options: ['codex', 'claude'],
        hint: 'Чем запускать сессии разработки и ревью; от этого зависит набор значений effort.',
        unit: null,
        default: 'codex',
      },
      {
        path: 'baseBranch',
        label: 'Базовая ветка',
        type: 'text',
        hint: 'От неё создаются ветки фаз и в неё нацелены PR, если фаза не задала свою базу.',
        unit: null,
        default: 'main',
      },
      {
        path: 'draftPullRequest',
        label: 'PR черновиком',
        type: 'boolean',
        hint: 'Создавать pull request черновиком. Ralph сам его из черновика не выводит — это делает человек перед мержем.',
        unit: null,
        default: true,
      },
      {
        path: 'stopAfterFirstIssue',
        label: 'Остановка после первой issue',
        type: 'boolean',
        hint: 'Прогон завершается после одной задачи: коммит и push ветки выполняются, PR и ревью вехи — нет. Режим для проверки настроек.',
        unit: null,
        default: false,
      },
      {
        path: 'syncBaseBranch',
        label: 'Вливать базу перед фазой',
        type: 'boolean',
        hint: 'Перед началом фазы её база вливается в рабочую ветку, чтобы разработка шла на актуальном коде.',
        unit: null,
        default: true,
      },
      {
        path: 'autoApproveConfiguredIssues',
        label: 'Автоодобрение issues',
        type: 'boolean',
        hint: 'До старта фиксируются точные title и body issues доверенных авторов; при false каждую issue вносят в файл snapshots вручную и обновляют контрольную сумму approvedIssueSnapshotsHash в scripts/ralph/ralph-config.mjs, иначе прогон не стартует.',
        unit: null,
        default: true,
      },
      {
        path: 'trustedIssueAuthors',
        label: 'Доверенные авторы issues',
        type: 'list',
        hint: 'GitHub-логины, чьи issues одобряются автоматически; владелец репозитория доверен всегда.',
        unit: null,
        default: [],
      },
      {
        path: 'approvedIssueSnapshotsFile',
        label: 'Файл одобренных snapshots',
        type: 'text',
        hint: 'Путь внутри проекта, где хранятся зафиксированные title и body одобренных issues.',
        unit: null,
        default: 'scripts/ralph/approved-issues.json',
      },
    ],
  },
  {
    id: 'phases',
    title: 'Фазы',
    fields: [
      {
        path: 'phases',
        label: 'Фазы прогона',
        type: 'phases',
        hint: 'Упорядоченный список: точное имя вехи GitHub, рабочая ветка и своя база; пустая клетка базы означает базовую ветку прогона. Имена вех и веток уникальны, ветка не может совпадать с базой.',
        unit: null,
        default: null,
      },
    ],
  },
  {
    id: 'limits',
    title: 'Лимиты и тайминги',
    fields: [
      {
        path: 'maxIterations',
        label: 'Итераций на прогон',
        type: 'number',
        hint: 'Сколько задач подряд берёт один прогон; на пределе прогон останавливается с ошибкой, работа остаётся в ветке фазы, PR не создаётся.',
        unit: null,
        default: 20,
      },
      {
        path: 'maxTurns',
        label: 'Шагов в сессии агента',
        type: 'number',
        hint: 'Числом между CLI не переносится: Codex считает каждый item, Claude — ответы модели.',
        unit: null,
        default: 50,
      },
      {
        path: 'maxTestFixAttempts',
        label: 'Попыток починить проверки',
        type: 'number',
        hint: 'Сколько раз агент чинит упавшую валидацию одной задачи, прежде чем прогон падает.',
        unit: null,
        default: 5,
      },
      {
        path: 'maxReviewFixAttempts',
        label: 'Отказов ревью подряд',
        type: 'number',
        hint: 'После этого числа отказов задача уходит из очереди прогона как отложенная.',
        unit: null,
        default: 3,
      },
      {
        path: 'runtime.networkRetryAttempts',
        label: 'Повторов сетевой команды',
        type: 'number',
        hint: 'От 1 до 60: повтор обращения к GitHub стоит секунды, поэтому запас здесь большой.',
        unit: null,
        default: 3,
      },
      {
        path: 'runtime.reviewRetryAttempts',
        label: 'Повторов сессии ревью',
        type: 'number',
        hint: 'От 1 до 5: каждая попытка — целая сессия агента, минуты и сотни тысяч токенов.',
        unit: null,
        default: 3,
      },
      {
        path: 'runtime.maxPages',
        label: 'Страниц ответа GitHub',
        type: 'number',
        hint: 'От 1 до 100, по 100 объектов на страницу; на пределе запрос падает, а не молча обрезается.',
        unit: null,
        default: 20,
      },
      {
        path: 'runtime.commandTimeoutMs',
        label: 'Таймаут одной команды',
        type: 'number',
        hint: 'Бюджет обычной команды вроде git или gh; 300000 = 5 минут.',
        unit: 'мс',
        default: 300000,
      },
      {
        path: 'runtime.validationTimeoutMs',
        label: 'Таймаут сборки образа',
        type: 'number',
        hint: 'Бюджет docker build образа проверок; 1800000 = 30 минут.',
        unit: 'мс',
        default: 1800000,
      },
      {
        path: 'runtime.validationRunTimeoutMs',
        label: 'Таймаут прогона проверок',
        type: 'number',
        hint: 'Бюджет всего набора проверок в одном контейнере; 3600000 = 1 час.',
        unit: 'мс',
        default: 3600000,
      },
      {
        path: 'runtime.agentTimeoutMs',
        label: 'Таймаут сессии агента',
        type: 'number',
        hint: 'Бюджет одной сессии CLI агента; 5400000 = 1 час 30 минут.',
        unit: 'мс',
        default: 5400000,
      },
      {
        path: 'runtime.networkRetryBaseDelayMs',
        label: 'Базовая пауза перед повтором',
        type: 'number',
        hint: 'Пауза перед первым повтором сетевой команды, дальше растёт; 2000 = 2 секунды.',
        unit: 'мс',
        default: 2000,
      },
    ],
  },
  {
    id: 'agent',
    title: 'Агент и ревью',
    fields: [
      {
        path: 'developmentModel',
        label: 'Модель разработки',
        type: 'select',
        options: { codex: ['gpt-5.6-terra'], claude: claudeModels },
        optionsDependOn: 'agentCli',
        allowCustom: true,
        hint: 'Модель для сессии реализации. Список не ограничивает выбор: новую модель вводят пунктом «Другая…».',
        unit: null,
        default: 'gpt-5.6-terra',
      },
      {
        path: 'developmentEffort',
        label: 'Усилие разработки',
        type: 'select',
        options: effortOptions,
        optionsDependOn: 'agentCli',
        hint: 'Список зависит от поля «CLI агента» и перерисовывается при его смене; чем выше усилие, тем дороже сессия.',
        unit: null,
        default: 'medium',
      },
      {
        path: 'reviewSeverityFloor',
        label: 'Порог важности ревью',
        type: 'select',
        options: ['P0', 'P1', 'P2', 'P3'],
        hint: 'Самый мягкий уровень, который ещё останавливает работу: P3 останавливает всё и делает прогон заметно дороже, P1 пропускает P2 и P3 в отложенные issues.',
        unit: null,
        default: 'P3',
      },
      {
        path: 'review.enabled',
        label: 'Ревью каждой issue',
        type: 'boolean',
        hint: 'Отдельная сессия проверяет уже закоммиченную и запушенную работу: при отказе коммит остаётся в ветке, а issue переоткрывается с замечаниями.',
        unit: null,
        default: null,
      },
      {
        path: 'review.model',
        label: 'Модель ревью issue',
        type: 'select',
        options: { codex: ['gpt-5.6-terra'], claude: claudeModels },
        optionsDependOn: 'agentCli',
        allowCustom: true,
        hint: 'Имя модели для ревью одной задачи; список не ограничивает выбор, своё имя вводят пунктом «Другая…».',
        unit: null,
        default: 'gpt-5.6-terra',
      },
      {
        path: 'review.effort',
        label: 'Усилие ревью issue',
        type: 'select',
        options: effortOptions,
        optionsDependOn: 'agentCli',
        hint: 'Набор значений зависит от CLI, как и у усилия разработки.',
        unit: null,
        default: 'medium',
      },
      {
        path: 'review.schemaFile',
        label: 'Схема ответа ревью',
        type: 'text',
        hint: 'JSON-схема внутри проекта, по которой разбирается результат ревью.',
        unit: null,
        default: null,
      },
      {
        path: 'review.outputFile',
        label: 'Файл результата ревью',
        type: 'text',
        hint: 'Куда пишется последний отчёт ревью issue.',
        unit: null,
        default: null,
      },
      {
        path: 'milestoneReview.enabled',
        label: 'Ревью вехи',
        type: 'boolean',
        hint: 'Общий аудит всей вехи перед её закрытием.',
        unit: null,
        default: null,
      },
      {
        path: 'milestoneReview.model',
        label: 'Модель ревью вехи',
        type: 'select',
        options: { codex: ['gpt-5.6-sol'], claude: claudeModels },
        optionsDependOn: 'agentCli',
        allowCustom: true,
        hint: 'Имя модели для аудита вехи, обычно сильнее, чем для одной задачи; список не ограничивает выбор, своё имя вводят пунктом «Другая…».',
        unit: null,
        default: null,
      },
      {
        path: 'milestoneReview.effort',
        label: 'Усилие ревью вехи',
        type: 'select',
        options: effortOptions,
        optionsDependOn: 'agentCli',
        hint: 'Набор значений зависит от CLI, как и у усилия разработки.',
        unit: null,
        default: 'high',
      },
      {
        path: 'milestoneReview.maxTurns',
        label: 'Шагов в сессии ревью вехи',
        type: 'number',
        hint: 'Если не задано, берётся общее значение maxTurns.',
        unit: null,
        default: 50,
      },
      {
        path: 'milestoneReview.maxFindings',
        label: 'Замечаний за круг вехи',
        type: 'number',
        hint: 'От 1 до 50: сколько находок ревью вехи попадёт в очередь за один круг.',
        unit: null,
        default: 10,
      },
      {
        path: 'milestoneReview.incremental',
        label: 'Инкрементальное ревью вехи',
        type: 'boolean',
        hint: 'Со второго круга проверяются только новые коммиты и закрытие прежних находок, а не весь diff заново.',
        unit: null,
        default: true,
      },
      {
        path: 'milestoneReview.schemaFile',
        label: 'Схема ответа ревью вехи',
        type: 'text',
        hint: 'JSON-схема внутри проекта для результата аудита вехи.',
        unit: null,
        default: null,
      },
      {
        path: 'milestoneReview.outputFile',
        label: 'Файл результата ревью вехи',
        type: 'text',
        hint: 'Куда пишется последний отчёт аудита вехи.',
        unit: null,
        default: null,
      },
      {
        path: 'prompt',
        label: 'Текст задания',
        type: 'textarea',
        hint: 'Подстановки: {issue_number}, {issue_title}, {issue_url}, {milestone}, {branch}, {max_turns}, {max_test_fix_attempts}.',
        unit: null,
        default: null,
      },
      {
        path: 'rulesFile',
        label: 'Файл правил сессии',
        type: 'text',
        hint: 'Путь внутри проекта к правилам, которые дописываются к заданию; те же подстановки действуют и там.',
        unit: null,
        default: '.agents/ralph-rules.md',
      },
    ],
  },
  {
    id: 'validation',
    title: 'Проверки',
    fields: [
      {
        path: 'validationContainer.image',
        label: 'Образ проверок',
        type: 'text',
        hint: 'Тег docker-образа изоляции; по умолчанию выводится из имени каталога репозитория, чтобы проекты не перезаписывали образы друг друга.',
        unit: null,
        default: null,
      },
      {
        path: 'validationContainer.dockerfile',
        label: 'Dockerfile проверок',
        type: 'text',
        hint: 'Путь внутри проекта к Dockerfile, из которого собирается образ проверок.',
        unit: null,
        default: null,
      },
      {
        path: 'preflightScripts',
        label: 'Команды подготовки',
        type: 'list',
        hint: 'Готовят окружение в контейнере до проверок; по одной команде оболочки на строку, перевод строки внутри команды запрещён.',
        unit: null,
        default: [],
      },
      {
        path: 'validationScripts',
        label: 'Команды проверок',
        type: 'list',
        hint: 'Доказывают работоспособность изменения; по одной команде оболочки на строку, перевод строки внутри команды запрещён, длина до 500 символов.',
        unit: null,
        default: [],
      },
      {
        path: 'validationDependencyPaths',
        label: 'Файлы зависимостей образа',
        type: 'list',
        hint: 'Относительные пути к манифестам и lock-файлам, которые копируются в слой зависимостей образа.',
        unit: null,
        default: [],
      },
    ],
  },
];

// Неподтверждённых ключей нет: каждый ключ из `.agents/ralph.config.json`
// встречается в `ralph-config.mjs`, и обратно — каждый ключ, который читает
// `ralph-config.mjs`, описан выше. Единственный ключ, которого нет в текущем
// `.agents/ralph.config.json`, но который код читает и валидирует, —
// `validationDependencyPaths` (умолчание `[]`, проверка в
// `validateValidationCommands`, использование в `ralph-validation-runner.mjs`).
//
// Значения, выведенные кодом, а не записанные в конфигурации, помечены
// `default: null`: `validationContainer.image` собирается из имени каталога
// репозитория, `prompt` и `phases` обязательны, конфиг без них отклоняется.
// `milestoneReview.maxTurns` без явного значения равен `maxTurns`; в таблице
// стоит умолчание `maxTurns`, то есть 50.
//
// Вычисляемые поля объекта конфигурации — `phasePlanId`, `milestone`, `branch`,
// `rulesPath`, `approvedIssueSnapshots`, `approvedIssueSnapshotsPath`,
// `validationContainer.dockerfilePath`, `review.schemaPath`,
// `review.outputPath`, `milestoneReview.schemaPath`,
// `milestoneReview.outputPath`, `agentInstructionFiles`,
// `trustedControlFileHashes` — в форму не выносятся: их пишет `loadConfig`, в
// файле настроек их нет.
