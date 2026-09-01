import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
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

// INSTALL.md, как и CHANGELOG.md, живёт в репозитории набора и в проект не
// копируется: в установленной копии проверка пропускается.
const installPath = fileURLToPath(new URL('../../INSTALL.md', import.meta.url));
const kitRoot = fileURLToPath(new URL('../../', import.meta.url));

// Что набор кладёт в чужой репозиторий. Файлы самого набора — README, CHANGELOG,
// INSTALL, docs, templates, .github — в проект не едут и в список не входят.
const shippedRoots = ['.agents', '.claude', 'scripts/ralph'];
const shippedFiles = [
  '.gitattributes',
  '.gitignore',
  'LICENSE',
  'templates/AGENTS.md',
  'templates/CLAUDE.md',
];

function shippedPaths() {
  const collected = [...shippedFiles];
  const walk = (relativeDirectory) => {
    for (const entry of readdirSync(path.join(kitRoot, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) walk(relativePath);
      else collected.push(relativePath);
    }
  };
  for (const root of shippedRoots) walk(root);

  return collected;
}

/**
 * Инструкция установки перечисляет то, что копируют в проект. Новый файл набора
 * без строки в инструкции — это файл, который потребитель не скопирует и не
 * обновит, а узнает о пропаже по отказу прогона.
 */
test('the install guide names every shipped path', { skip: !existsSync(installPath) }, () => {
  const guide = readFileSync(installPath, 'utf8');
  // Из инструкции берутся пути в обратных кавычках; `**` в конце покрывает
  // каталог целиком.
  const named = [...guide.matchAll(/`([^`\n]+)`/gu)]
    .map((match) => match[1].replace(/\*\*$/u, ''))
    .filter((value) => value.includes('/') || shippedFiles.includes(value));

  for (const shipped of shippedPaths()) {
    const covered = named.some(
      (candidate) => shipped === candidate || shipped.startsWith(candidate),
    );
    assert.equal(covered, true, `INSTALL.md не называет ${shipped}`);
  }
});
