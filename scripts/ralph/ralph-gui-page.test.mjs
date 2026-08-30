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

test('every icon on the page is named or hidden', { skip: !existsSync(guiPagePath) }, async () => {
  const { renderPage } = await import('./ralph-gui-page.mjs');
  const page = renderPage();

  // Иконка ничего не говорит скринридеру. Картинка внутри кнопки с подписью
  // прячется от него совсем, а кнопка без видимого текста называет действие
  // сама: без имени она читается как «кнопка».
  for (const svg of page.match(/<svg[^>]*>/gu) ?? []) {
    assert.equal(svg.includes('aria-hidden="true"'), true, `SVG без aria-hidden: ${svg}`);
  }

  // Кнопку копирования рисует клиентский скрипт, DOM в тестах нет — проверяем
  // его текст: имя присваивается рядом с классом кнопки. Ищется сам вызов, а не
  // слово: упоминание в комментарии кнопку не называет.
  const copyButton = /command-copy[\s\S]{0,400}?setAttribute\('aria-label'/u;
  assert.equal(copyButton.test(page), true, 'кнопка копирования не называет действие');
});

test('the command fields fold, and «Делает» stays open', { skip: !existsSync(guiPagePath) }, async () => {
  const { renderPage } = await import('./ralph-gui-page.mjs');
  const page = renderPage();

  // Три поля подряд у каждой команды сливались в стену текста, поэтому
  // сворачивается каждое поле по отдельности: метка — кнопка, которая говорит
  // скринридеру, раскрыто ли поле, и указывает на свой текст.
  assert.equal(page.includes("el('button', 'command-lead')"), true, 'метка поля не кнопка');
  assert.equal(page.includes("setAttribute('aria-expanded'"), true, 'метка не сообщает о раскрытии');
  assert.equal(page.includes("setAttribute('aria-controls'"), true, 'метка не указывает на текст');

  // Первое поле открыто у всех команд: свёрнутый список из одних меток не
  // говорит, о чём команда, и требует клика ради каждой строки.
  assert.equal(/commandLine\('Делает',[^)]*true/u.test(page), true, '«Делает» свёрнуто по умолчанию');
});

test('every section is titled and explained', { skip: !existsSync(guiPagePath) }, async () => {
  const { renderPage } = await import('./ralph-gui-page.mjs');
  const page = renderPage();

  // Раздел называет заголовок страницы, а под ним строка о том, что человек
  // здесь видит: без неё пульт открывается таблицей чисел без объяснения.
  assert.match(page, /<h1 class="head-title" id="head-title">/u);
  assert.match(page, /id="head-note"/u);

  // Подпись называет источник данных раздела: журнал прогона, файл настроек
  // или сам набор. Без неё пульт открывается таблицей чисел без объяснения.
  for (const note of ['журнала прогона', 'ralph.config.json', 'чего она не делает']) {
    assert.equal(page.includes(note), true, `нет подписи раздела: ${note}`);
  }
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
