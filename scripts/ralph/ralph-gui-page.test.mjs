import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Пульт ставится не в каждую копию набора: без его модуля страницу не собрать,
// и проверки пропускаются, как в соседних тестах.
const guiPagePath = fileURLToPath(new URL('./ralph-gui-page.mjs', import.meta.url));

test('the GUI page ships a single dark theme', { skip: !existsSync(guiPagePath) }, async () => {
  const { renderPage } = await import('./ralph-gui-page.mjs');
  const page = renderPage();

  // Тема одна, ночная: страница объявляет её браузеру и не держит второй
  // палитры под системную настройку — иначе часть стилей жила бы мёртвым
  // грузом и расходилась с живой темой при правках.
  assert.equal(page.includes('color-scheme: dark'), true);
  assert.equal(page.includes('prefers-color-scheme'), false);
});

test('the GUI page loads nothing from the network', { skip: !existsSync(guiPagePath) }, async () => {
  const { renderPage } = await import('./ralph-gui-page.mjs');
  const page = renderPage({ token: 'test-token' });

  // Пульт работает без сети: в разметке не должно появиться ни одной внешней
  // ссылки на скрипт, стиль, шрифт или картинку.
  assert.equal(/\bsrc="https?:/u.test(page), false);
  assert.equal(/\bhref="https?:/u.test(page), false);
  assert.equal(page.includes('@import'), false);
});

test('the GUI page keeps every section reachable', { skip: !existsSync(guiPagePath) }, async () => {
  const { renderPage } = await import('./ralph-gui-page.mjs');
  const page = renderPage();

  // Разделы переключает клиентский скрипт по data-tab: пропавшая кнопка
  // оставила бы раздел живым в коде, но недостижимым со страницы.
  for (const tab of ['usage', 'settings', 'commands']) {
    assert.equal(page.includes(`data-tab="${tab}"`), true, `нет кнопки раздела ${tab}`);
  }
});
