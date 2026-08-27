import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { printCheck } from './ralph-loop.mjs';
import { KIT_VERSION } from './ralph-version.mjs';

// CHANGELOG.md лежит в корне набора и в проект не копируется, поэтому проверка
// заголовка пропускается там, где файла нет.
const changelogPath = fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url));
// Пульт ставится не в каждую копию набора: без его модуля проверка шапки
// пропускается, как и проверка changelog.
const guiPagePath = fileURLToPath(new URL('./ralph-gui-page.mjs', import.meta.url));

function captureOutput(operation) {
  const lines = [];
  const originalLog = console.log;
  console.log = (message) => lines.push(String(message));
  try {
    operation();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

test('the kit version is three numbers', () => {
  assert.match(KIT_VERSION, /^\d+\.\d+\.\d+$/u);
});

test('the changelog opens with the current version', { skip: !existsSync(changelogPath) }, () => {
  const firstHeading = readFileSync(changelogPath, 'utf8')
    .split(/\r?\n/u)
    .find((line) => line.startsWith('## '));

  assert.equal(typeof firstHeading, 'string');
  assert.equal(firstHeading.slice(3).startsWith(KIT_VERSION), true);
});

test('--check names the kit version', () => {
  // По этой строке человек называет свою версию набора, когда пишет о проблеме:
  // другого места, где номер видно без чтения кода, в консоли нет.
  const lines = captureOutput(() =>
    printCheck(
      {
        maxIterations: 40,
        maxTurns: 120,
        maxTestFixAttempts: 3,
        developmentModel: 'gpt-5.6',
        rulesFile: '.agents/ralph-rules.md',
        review: { enabled: false },
        milestoneReview: { enabled: false },
      },
      'owner/repository',
      { title: 'Test milestone' },
      { currentBranch: 'feature/test', clean: true },
      [],
      { used: 0, limit: 40, remaining: 40 },
    ),
  );

  assert.equal(lines.includes(`Версия набора: ${KIT_VERSION}`), true);
});

test('the GUI header shows the kit version', { skip: !existsSync(guiPagePath) }, async () => {
  const { renderPage } = await import('./ralph-gui-page.mjs');
  const shown = renderPage().match(/class="brand-version">([^<]*)</u);

  assert.equal(shown?.[1], KIT_VERSION);
});
