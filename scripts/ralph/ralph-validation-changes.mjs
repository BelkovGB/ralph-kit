import { isAbsolute, win32 } from 'node:path';

export function repoPath(value, prefix = false) {
  if (typeof value !== 'string' || isAbsolute(value) || win32.isAbsolute(value)
    || /[:\\]/u.test(value) || [...value].some((character) => character.charCodeAt(0) < 32)) return false;
  const path = prefix ? value.replace(/\/$/u, '') : value;
  return path.split('/').every((part) => part && !['.', '..', '.git'].includes(part.toLowerCase()));
}

function nulFields(output) {
  const fields = output.split('\0');
  if (fields.pop() !== '') throw new Error('Git вернул неполный список изменений.');
  return fields;
}

export function validationChanges(base, git) {
  if (!/^[0-9a-f]{40}$/u.test(base ?? '')) throw new Error('Не указан базовый SHA.');
  git(['merge-base', '--is-ancestor', base, 'HEAD']);
  if (git(['ls-files', '--unmerged', '-z'])) throw new Error('В индексе есть конфликт слияния.');
  const changes = new Map();
  const diffOptions = ['--name-status', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none'];
  for (const comparison of [[base, 'HEAD'], ['--cached', base], [base]]) {
    const fields = nulFields(git(['diff', ...diffOptions, ...comparison, '--']));
    if (fields.length % 2) throw new Error('В выводе Git отсутствует изменённый путь.');
    for (let index = 0; index < fields.length; index += 2) {
      const status = fields[index], file = fields[index + 1];
      if (!changes.has(file)) changes.set(file, new Set());
      changes.get(file).add(status);
    }
  }
  for (const file of nulFields(git(['ls-files', '--others', '--exclude-standard', '-z']))) {
    if (!changes.has(file)) changes.set(file, new Set(['?']));
  }
  return changes;
}
