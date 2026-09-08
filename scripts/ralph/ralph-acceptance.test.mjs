import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCases, parseModules, parseRun } from './ralph-acceptance.mjs';

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
