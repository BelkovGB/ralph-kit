import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStatus,
  computeImpact,
  globToRegExp,
  parseCases,
  parseModules,
  parseRun,
  readAcceptance,
  renderImpact,
  renderStatus,
} from './ralph-acceptance.mjs';

// Каталог приёмки в памяти: файловая система подменяется картой путей, потому
// что разбор не зависит от диска, а тест — от временных каталогов.
function memoryFiles(files) {
  const normalized = new Map(Object.entries(files).map(([key, value]) => [key.replaceAll('\\', '/'), value]));
  return {
    exists: (file) => normalized.has(file.replaceAll('\\', '/')),
    readFile: (file) => {
      const key = file.replaceAll('\\', '/');
      if (!normalized.has(key)) throw new Error(`нет файла ${key}`);
      return normalized.get(key);
    },
    readDirectory: (directory) => {
      const prefix = `${directory.replaceAll('\\', '/')}/`;
      return [...normalized.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    },
  };
}

const modulesText = ['| Модуль | Кейсы | Пути |', '| --- | --- | --- |', '| cart | cases/cart.md | src/cart/** |', '| search | cases/search.md | src/search/** |'].join('\n');
const cartCases = [
  '## CART-001. Добавление товара',
  '## CART-002. Нулевой остаток',
  '## CART-003. Снятый кейс',
  '**Снят** 2026-10-01 — удалено',
  '## CART-004. Ни разу не гонялся',
].join('\n');
const run = (rows) => ['## Результаты', '| Кейс | Статус | Комментарий |', '| --- | --- | --- |', ...rows].join('\n');

test('реестр модулей: имя, файл кейсов и пути через запятую', () => {
  const text = [
    '# Модули',
    '',
    '| Модуль | Кейсы | Пути |',
    '| ------ | ----- | ---- |',
    '| cart | cases/cart.md | src/cart/**, src/api/cart/** |',
    '| order-history | cases/order-history.md | src/orders/** |',
  ].join('\n');
  assert.deepEqual(
    parseModules(text, 'modules.md').map(({ name, casesFile, paths }) => ({ name, casesFile, paths })),
    [
      { name: 'cart', casesFile: 'cases/cart.md', paths: ['src/cart/**', 'src/api/cart/**'] },
      { name: 'order-history', casesFile: 'cases/order-history.md', paths: ['src/orders/**'] },
    ],
  );
});

test('реестр модулей: имя не по формату останавливает с файлом и строкой', () => {
  const text = ['| Модуль | Кейсы | Пути |', '| --- | --- | --- |', '| Cart | cases/cart.md | src/** |'].join('\n');
  assert.throws(() => parseModules(text, 'modules.md'), /modules\.md:3.*Cart/u);
});

test('кейсы: ID с дефисом в имени модуля и пометка «снят»', () => {
  const text = [
    '# Кейсы: order-history',
    '',
    '## ORDER-HISTORY-001. Список заказов открывается',
    '',
    '**Источник** issue #7, критерий 1',
    '',
    '## ORDER-HISTORY-002. Старый экспорт',
    '',
    '**Снят** 2026-10-01 — экспорт удалён в фазе 5',
  ].join('\n');
  assert.deepEqual(
    parseCases(text, 'cases/order-history.md', 'order-history').map(({ id, title, retired }) => ({ id, title, retired })),
    [
      { id: 'ORDER-HISTORY-001', title: 'Список заказов открывается', retired: false },
      { id: 'ORDER-HISTORY-002', title: 'Старый экспорт', retired: true },
    ],
  );
});

test('кейсы: заголовок не по формату и чужой модуль останавливают с файлом и строкой', () => {
  assert.throws(
    () => parseCases('## Просто заголовок', 'cases/cart.md', 'cart'),
    /cases\/cart\.md:1/u,
  );
  assert.throws(
    () => parseCases('## CHECKOUT-001. Чужой', 'cases/cart.md', 'cart'),
    /cases\/cart\.md:1.*CHECKOUT-001/u,
  );
});

test('прогон: строки таблицы после «Результаты», остальное — текст', () => {
  const text = [
    '# Прогон: регресс cart',
    '',
    '**Тип** регресс',
    '',
    '## Результаты',
    '',
    '| Кейс | Статус | Комментарий |',
    '| ---- | ------ | ----------- |',
    '| CART-001 | PASS | |',
    '| CART-007 | FAIL | кнопка активна |',
    '',
    '## Отказы',
    '',
    '| это | не | таблица результатов |',
  ].join('\n');
  assert.deepEqual(
    parseRun(text, 'runs/2026-09-15-regress-cart.md').map(({ id, status, comment }) => ({ id, status, comment })),
    [
      { id: 'CART-001', status: 'PASS', comment: '' },
      { id: 'CART-007', status: 'FAIL', comment: 'кнопка активна' },
    ],
  );
});

test('прогон: неизвестный статус, пустая таблица и отсутствие раздела останавливают', () => {
  const head = ['## Результаты', '', '| Кейс | Статус | Комментарий |', '| --- | --- | --- |'];
  assert.throws(
    () => parseRun([...head, '| CART-001 | OK | |'].join('\n'), 'runs/r.md'),
    /runs\/r\.md:5.*OK/u,
  );
  assert.throws(() => parseRun(head.join('\n'), 'runs/r.md'), /пуста/u);
  assert.throws(() => parseRun('# Прогон', 'runs/r.md'), /Результаты/u);
});

test('прогон: повтор ID в таблице результатов останавливает с файлом и строкой повтора', () => {
  const text = run(['| CART-001 | PASS | |', '| CART-007 | FAIL | |', '| CART-001 | PASS | |']);
  assert.throws(() => parseRun(text, 'runs/r.md'), /runs\/r\.md:6.*CART-001.*дважды/u);
});

test('сводка: последний статус, прогон и история из пяти, свежий справа', () => {
  const files = memoryFiles({
    'docs/acceptance/modules.md': modulesText,
    'docs/acceptance/cases/cart.md': cartCases,
    'docs/acceptance/runs/2026-09-01-phase-1.md': run(['| CART-001 | PASS | |', '| CART-002 | PASS | |']),
    'docs/acceptance/runs/2026-09-02-regress-cart.md': run(['| CART-001 | FAIL | |']),
    'docs/acceptance/runs/2026-09-03-regress-cart.md': run(['| CART-001 | PASS | |']),
    'docs/acceptance/runs/2026-09-04-regress-cart.md': run(['| CART-001 | PASS | |']),
    'docs/acceptance/runs/2026-09-05-regress-cart.md': run(['| CART-001 | BLOCKED | |']),
    'docs/acceptance/runs/2026-09-06-regress-cart.md': run(['| CART-001 | PASS | |']),
  });
  const status = buildStatus(readAcceptance('docs/acceptance', files));
  const cart = status.modules.find((module) => module.name === 'cart');
  assert.deepEqual(cart.rows.map(({ id, status: value, run: file, history }) => ({ id, status: value, run: file, history })), [
    { id: 'CART-001', status: 'PASS', run: 'runs/2026-09-06-regress-cart.md', history: ['F', 'P', 'P', 'B', 'P'] },
    { id: 'CART-002', status: 'PASS', run: 'runs/2026-09-01-phase-1.md', history: ['P'] },
    { id: 'CART-004', status: null, run: null, history: [] },
  ]);
  assert.deepEqual(status.counts, { total: 3, PASS: 2, FAIL: 0, BLOCKED: 0, SKIPPED: 0, never: 1 });
});

test('сводка: суффикс повтора «-2» и «-10» сортируется как число, а не как текст', () => {
  const files = memoryFiles({
    'docs/acceptance/modules.md': modulesText,
    'docs/acceptance/cases/cart.md': cartCases,
    'docs/acceptance/runs/2026-09-15-regress-cart.md': run(['| CART-001 | FAIL | |']),
    'docs/acceptance/runs/2026-09-15-regress-cart-2.md': run(['| CART-001 | PASS | |']),
    'docs/acceptance/runs/2026-09-15-regress-cart-10.md': run(['| CART-001 | BLOCKED | |']),
  });
  const status = buildStatus(readAcceptance('docs/acceptance', files));
  const cart001 = status.modules.find((module) => module.name === 'cart').rows.find((row) => row.id === 'CART-001');
  assert.deepEqual(cart001, {
    id: 'CART-001',
    title: 'Добавление товара',
    status: 'BLOCKED',
    run: 'runs/2026-09-15-regress-cart-10.md',
    history: ['F', 'P', 'B'],
  });
});

test('сводка: модуль без файла кейсов — не ошибка, а строка «кейсов нет»', () => {
  const files = memoryFiles({
    'docs/acceptance/modules.md': modulesText,
    'docs/acceptance/cases/cart.md': cartCases,
  });
  const status = buildStatus(readAcceptance('docs/acceptance', files));
  assert.deepEqual(status.modules.find((module) => module.name === 'search').rows, []);
  assert.match(renderStatus(status), /## search — cases\/search\.md\n\nКейсов нет\./u);
});

test('сводка: прогон с ID без кейса даёт предупреждение, а не остановку', () => {
  const files = memoryFiles({
    'docs/acceptance/modules.md': modulesText,
    'docs/acceptance/cases/cart.md': cartCases,
    'docs/acceptance/runs/2026-09-01-phase-1.md': run(['| CART-999 | PASS | |']),
  });
  const status = buildStatus(readAcceptance('docs/acceptance', files));
  assert.equal(status.warnings.length, 1);
  assert.match(status.warnings[0], /2026-09-01-phase-1\.md.*CART-999.*снят/u);
});

test('сводка: без реестра — остановка с ожидаемым путём', () => {
  assert.throws(() => readAcceptance('docs/acceptance', memoryFiles({})), /docs\/acceptance\/modules\.md/u);
});

test('сводка: текст держит счёт, заголовок о генерации и таблицу по модулям', () => {
  const files = memoryFiles({
    'docs/acceptance/modules.md': modulesText,
    'docs/acceptance/cases/cart.md': cartCases,
    'docs/acceptance/runs/2026-09-01-phase-1.md': run(['| CART-001 | FAIL | |']),
  });
  const text = renderStatus(buildStatus(readAcceptance('docs/acceptance', files)));
  assert.match(text, /^# Сводка приёмки\n\n<!-- сгенерировано командой node scripts\/ralph\/ralph-acceptance\.mjs status; руками не править -->/u);
  assert.match(text, /Кейсов 3 · PASS 0 · FAIL 1 · BLOCKED 0 · SKIPPED 0 · не гонялся 2/u);
  assert.match(text, /\| CART-001 \| Добавление товара \| FAIL \| runs\/2026-09-01-phase-1\.md \| F \|/u);
  assert.match(text, /\| CART-004 \| Ни разу не гонялся \| не гонялся \| — \| — \|/u);
  assert.doesNotMatch(text, /CART-003/u);
});

test('шаблоны путей: ** любая глубина, **/ ноль и более каталогов, * внутри сегмента', () => {
  assert.equal(globToRegExp('src/cart/**').test('src/cart/a/b.ts'), true);
  assert.equal(globToRegExp('src/cart/**').test('src/cartel/a.ts'), false);
  assert.equal(globToRegExp('**/*.test.mjs').test('a.test.mjs'), true);
  assert.equal(globToRegExp('**/*.test.mjs').test('x/y/a.test.mjs'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/a.ts'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/a/b.ts'), false);
  assert.equal(globToRegExp('src/(cart)/a.ts').test('src/(cart)/a.ts'), true);
});

test('impact: модули с кейсами, без кейсов и пути вне реестра', () => {
  const files = memoryFiles({
    'docs/acceptance/modules.md': modulesText,
    'docs/acceptance/cases/cart.md': cartCases,
  });
  const result = computeImpact(readAcceptance('docs/acceptance', files), [
    'src/cart/add.ts',
    'src/cart/total.ts',
    'src/search/index.ts',
    'src/utils/date.ts',
  ]);
  assert.deepEqual(result, {
    withCases: [{ name: 'cart', count: 3, paths: ['src/cart/add.ts', 'src/cart/total.ts'] }],
    withoutCases: [{ name: 'search', paths: ['src/search/index.ts'] }],
    uncovered: ['src/utils/date.ts'],
  });
  const text = renderImpact(result);
  assert.match(text, /Задеты модули с кейсами:\n  cart — 3 кейса; src\/cart\/add\.ts, src\/cart\/total\.ts/u);
  assert.match(text, /Задеты модули без кейсов:\n  search — src\/search\/index\.ts/u);
  assert.match(text, /Пути вне реестра:\n  src\/utils\/date\.ts/u);
});

test('impact: снятые кейсы в счёт не идут, пустые списки названы словами', () => {
  const files = memoryFiles({
    'docs/acceptance/modules.md': modulesText,
    'docs/acceptance/cases/cart.md': '## CART-001. Снятый\n**Снят** 2026-01-01 — нет',
  });
  const result = computeImpact(readAcceptance('docs/acceptance', files), ['src/cart/a.ts']);
  assert.deepEqual(result.withCases, []);
  assert.deepEqual(result.withoutCases, [{ name: 'cart', paths: ['src/cart/a.ts'] }]);
  assert.match(renderImpact(result), /Задеты модули с кейсами:\n  нет/u);
  assert.match(renderImpact(result), /Пути вне реестра:\n  нет/u);
});
