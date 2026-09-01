import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Модули пульта ставятся не в каждую копию набора: без файла тесты
// пропускаются, как в соседних тестах страницы. Статического импорта нет
// намеренно — ERR_MODULE_NOT_FOUND уронил бы файл целиком вместо пропуска.
const viewPath = fileURLToPath(new URL('./ralph-gui-view.mjs', import.meta.url));
const skip = !existsSync(viewPath);

/**
 * Логика вида пульта, впервые доступная тестам напрямую: до извлечения эти
 * функции жили внутри шаблонной строки страницы, и проверить их можно было
 * только глазами в браузере.
 *
 * Ожидания для чисел строятся тем же num, что использует код: разделитель
 * групп в ru-RU — неразрывный пробел, и захардкоженная строка сломалась бы на
 * другой ICU.
 */

test('форматтеры чисел, токенов и времени', { skip }, async () => {
  const view = await import('./ralph-gui-view.mjs');

  assert.equal(view.plural(1, 'задача', 'задачи', 'задач'), 'задача');
  assert.equal(view.plural(3, 'задача', 'задачи', 'задач'), 'задачи');
  assert.equal(view.plural(12, 'задача', 'задачи', 'задач'), 'задач');
  assert.equal(view.plural(21, 'задача', 'задачи', 'задач'), 'задача');
  assert.equal(view.plural(-2, 'задача', 'задачи', 'задач'), 'задачи');

  assert.equal(view.num(7), '7');
  assert.equal(view.num('мусор'), '0');
  assert.equal(view.money(1.005), `${view.num(1.005, 2)} $`);

  assert.equal(view.tokensOf(42), 42);
  assert.equal(view.tokensOf({ a: 1, b: 2, c: 'нет' }), 3);
  assert.equal(view.tokensOf(null), 0);

  assert.equal(view.tokens(999), '999');
  assert.equal(view.tokens(25_000), `${view.num(25)} тыс.`);
  assert.equal(view.tokens(1_500_000), `${view.num(1.5, 1)} млн`);

  assert.equal(view.share(1, 0), '');
  assert.equal(view.share(1, 1000), '<1%');
  assert.equal(view.share(500, 1000), '50%');

  assert.equal(view.duration(5_000), '5 с');
  assert.equal(view.duration(90_000), '2 мин');
  assert.equal(view.duration(3_600_000), '1 ч');
  assert.equal(view.duration(3_660_000 * 2), '2 ч 2 мин');
  assert.equal(view.hours(5_400_000), `${view.num(1.5, 1)} ч`);

  assert.equal(view.cut('длинный заголовок', 8), 'длинный…');
  assert.equal(view.cut('короткий', 20), 'короткий');

  assert.equal(view.parseDate('не дата'), null);
  assert.equal(view.clock('не дата'), '');
  assert.notEqual(view.parseDate('2026-09-01T10:00:00Z'), null);
});

test('разбивка токенов по видам не теряет и не выдумывает объём', { skip }, async () => {
  const view = await import('./ralph-gui-view.mjs');
  const sample = { cacheRead: 900, cacheCreation: 50, uncachedInput: 50, reasoning: 0, answer: 100 };

  assert.equal(view.loadedTokens(sample), 1000);
  assert.equal(view.writtenTokens(sample), 100);
  // Нулевой вид пропускается, ненулевые в исходном порядке.
  assert.deepEqual(view.tokenKindList(sample), [
    `чтение кэша ${view.tokens(900)}`,
    `запись в кэш ${view.tokens(50)}`,
    `новый текст ${view.tokens(50)}`,
    `ответ ${view.tokens(100)}`,
  ]);
  // С долями список отсортирован по убыванию объёма.
  assert.equal(view.tokenKindList(sample, true)[0], `чтение кэша ${view.tokens(900)} · 82%`);
});

test('подписи исходов, фаз и ролей', { skip }, async () => {
  const view = await import('./ralph-gui-view.mjs');
  const words = { completed: 'Ralph закрыл issue' };

  assert.equal(view.outcomeWord(words, 'completed'), 'Ralph закрыл issue');
  // Незнакомый слаг показывается как есть: подмена скрыла бы новый код.
  assert.equal(view.outcomeWord(words, 'новый-исход'), 'новый-исход');
  assert.equal(view.outcomeWord(words, null), '—');

  assert.equal(view.outcomeClass('completed'), '');
  assert.equal(view.outcomeClass('review-parked'), 'warn');
  assert.equal(view.outcomeClass('milestone-review'), 'muted');
  assert.equal(view.outcomeClass('validation-failed'), 'bad');

  assert.equal(view.phaseWord('validating'), 'идут проверки');
  assert.equal(view.phaseWord('незнакомая'), 'незнакомая');
  assert.equal(view.roleWord('development'), 'разработка');
  assert.equal(view.roleWord(null), 'агент');

  assert.equal(view.isReviewRow({ issue: null }), true);
  assert.equal(view.isReviewRow({ issue: 7 }), false);

  assert.equal(view.stageMs(5), 5);
  assert.equal(view.stageMs({ ms: 7 }), 7);
  assert.equal(view.stageMs({ wallMs: 9 }), 9);
  assert.equal(view.stageMs('мусор'), 0);
});

test('слепок состояния меняется от показанных полей и только от них', { skip }, async () => {
  const view = await import('./ralph-gui-view.mjs');
  const base = {
    running: true,
    staleLock: false,
    plannedPhases: ['Фаза 1'],
    run: { turn: 27, issueNumber: 11, stateUpdatedAt: 'A', logUpdatedAt: 'A' },
  };

  const same = view.shownStateStamp({
    ...base,
    run: { ...base.run, stateUpdatedAt: 'B', logUpdatedAt: 'B' },
  });
  assert.equal(view.shownStateStamp(base), same);
  assert.notEqual(view.shownStateStamp({ ...base, run: { ...base.run, turn: 28 } }), same);
  // Разделитель — управляющий символ, а не текст «»: при переносе из
  // шаблона в модуль один уровень экранирования снимается.
  assert.equal(same.includes(String.fromCharCode(1)), true);
  assert.equal(same.includes('u0001'), false);
});

test('счёт карточки хода относится к фазе при живом прогоне и к журналу без него', { skip }, async () => {
  const view = await import('./ralph-gui-view.mjs');
  const phases = [
    { milestone: 'Фаза 1', planned: true, completed: 5 },
    { milestone: 'Фаза 2', planned: true, completed: 2 },
  ];
  const totals = { completed: 7 };

  const running = view.progressScope(
    { running: true, run: { milestone: 'Фаза 2', phaseIndex: 1, phaseCount: 3 }, plannedPhases: [] },
    totals,
    phases,
  );
  assert.equal(running.title, 'Фаза 2 из 3');
  assert.equal(running.counters.completed, 2);
  assert.equal(running.note, '');

  const unknownPhase = view.progressScope(
    { running: true, run: { milestone: 'Фаза 3' }, plannedPhases: [] },
    totals,
    phases,
  );
  assert.equal(unknownPhase.counters, totals);
  assert.match(unknownPhase.note, /за весь журнал/);

  const idle = view.progressScope(
    { running: false, plannedPhases: ['Фаза 1', 'Фаза 2', 'Фаза 3'] },
    totals,
    phases,
  );
  assert.equal(idle.title, 'Фаз в плане 3');
  assert.equal(idle.subtitle, 'в журнале 2');
  assert.equal(idle.counters, totals);
});

test('порядок строк: по ходу работы и по объёму с ревью milestone наверху', { skip }, async () => {
  const view = await import('./ralph-gui-view.mjs');
  const review = { issue: null, tokensTotal: 900, firstStartedAt: '2026-09-01T12:00:00Z' };
  const early = { issue: 1, tokensTotal: 100, firstStartedAt: '2026-09-01T09:00:00Z' };
  const heavy = { issue: 2, tokensTotal: 500, firstStartedAt: '2026-09-01T10:00:00Z' };
  const rows = [review, heavy, early];

  assert.deepEqual(view.orderedTasks(rows, 'plan'), [early, heavy, review]);
  // По объёму ревью фазы встаёт первым отдельно, дальше задачи по убыванию.
  assert.deepEqual(view.orderedTasks(rows, 'volume'), [review, heavy, early]);
  // Вход не мутируется: страница пере-сортирует один и тот же массив.
  assert.deepEqual(rows, [review, heavy, early]);
});

test('задача принадлежит фазе так же, как на сервере', { skip }, async () => {
  const view = await import('./ralph-gui-view.mjs');

  assert.equal(view.taskBelongsToPhase({ milestone: 'Фаза 1' }, { milestone: 'Фаза 1' }), true);
  assert.equal(view.taskBelongsToPhase({}, { milestone: null }), true);
  // Пустая строка остаётся пустой строкой, а не превращается в null.
  assert.equal(view.taskBelongsToPhase({ milestone: '' }, { milestone: null }), false);
  assert.equal(view.taskBelongsToPhase({ milestone: '' }, { milestone: '' }), true);
});

test('outOf называет лимит только когда он известен', { skip }, async () => {
  const view = await import('./ralph-gui-view.mjs');

  assert.equal(view.outOf(2, 5), '2 из 5');
  assert.equal(view.outOf(2, null), '2');
});
