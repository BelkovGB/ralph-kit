import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { repositoryGitDirectory } from './ralph-test-support.mjs';

/**
 * Каталог фейковых бинарей обязан находиться и в git worktree.
 *
 * В worktree `.git` — файл со строкой `gitdir: <путь>`, и mkdir внутри него
 * роняет весь прогон тестов на импорте ralph-test-support. Это блокировало
 * прогон сьюта при разборе pull request в отдельной рабочей копии.
 */

test('в обычной копии каталогом git остаётся .git', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-gitdir-'));
  mkdirSync(path.join(root, '.git'));

  try {
    assert.equal(repositoryGitDirectory(root), path.join(root, '.git'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('в worktree путь читается из файла .git', () => {
  const main = mkdtempSync(path.join(tmpdir(), 'ralph-gitdir-main-'));
  const worktree = mkdtempSync(path.join(tmpdir(), 'ralph-gitdir-wt-'));
  const linked = path.join(main, '.git', 'worktrees', 'wt');
  mkdirSync(linked, { recursive: true });
  writeFileSync(path.join(worktree, '.git'), `gitdir: ${linked}\n`, 'utf8');

  try {
    assert.equal(repositoryGitDirectory(worktree), linked);
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('без .git возвращается путь для создания', () => {
  // В каталоге без git репозитория `.git` не существует вовсе: mkdir создаст
  // обычный каталог с этим именем.
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-gitdir-none-'));

  try {
    assert.equal(repositoryGitDirectory(root), path.join(root, '.git'));
    assert.equal(existsSync(path.join(root, '.git')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
