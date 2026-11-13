import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';
import { hasValidationCommandShape, usesValidationControlOperator } from './ralph-config.mjs';
import { hostShellCommand } from './ralph-validation-runner.mjs';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
}

function repoPath(value, prefix = false) {
  if (typeof value !== 'string' || isAbsolute(value) || win32.isAbsolute(value)
    || /[:\\]/u.test(value) || [...value].some((character) => character.charCodeAt(0) < 32)) return false;
  const path = prefix ? value.replace(/\/$/u, '') : value;
  return path.split('/').every((part) => part && !['.', '..', '.git'].includes(part.toLowerCase()));
}

function isCommandList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((command) =>
    hasValidationCommandShape(command) && !usesValidationControlOperator(command));
}

function readRules(root, base, file, changes) {
  if (!repoPath(file)) throw new Error('Укажите путь к JSON с проверками относительно корня Git.');
  const entry = git(root, ['--literal-pathspecs', 'ls-tree', '-z', base, '--', file]);
  if (!/^100(?:644|755) blob /u.test(entry) || changes.has(file)) {
    throw new Error('Правила проверок изменились после базового коммита задачи. Зафиксируйте настройки отдельно.');
  }
  const { full, rules } = JSON.parse(git(root, ['show', `${base}:${file}`]));
  if (!isCommandList(full) || !Array.isArray(rules) || !rules.every((rule) =>
    rule && Array.isArray(rule.paths) && rule.paths.length > 0
    && rule.paths.every((path) => repoPath(path, true)) && isCommandList(rule.commands))) {
    throw new Error('Нужны непустые команды full и массив rules с полями paths и commands.');
  }
  return { full, rules };
}

function changedFiles(root, base) {
  git(root, ['merge-base', '--is-ancestor', base, 'HEAD']);
  if (git(root, ['ls-files', '--unmerged', '-z'])) throw new Error('В индексе есть конфликт слияния.');
  const changes = new Map();
  const diffOptions = [
    '--name-status', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none',
  ];
  for (const comparison of [[base, 'HEAD'], ['--cached', base], [base]]) {
    const fields = git(root, ['diff', ...diffOptions, ...comparison, '--']).split('\0');
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [status, file] = fields.slice(index, index + 2);
      if (!changes.has(file)) changes.set(file, new Set());
      changes.get(file).add(status);
    }
  }
  for (const path of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    if (!changes.has(path)) changes.set(path, new Set(['?']));
  }
  return changes;
}

function planChecks({ full, rules }, changes, root) {
  if (!changes.size) return { commands: full, reason: 'пустой diff' };
  const matched = new Set();
  for (const [path, statuses] of changes) {
    if ([...statuses].some((status) => !['A', 'M', '?'].includes(status))
      || !lstatSync(resolve(root, path), { throwIfNoEntry: false })?.isFile()) {
      return { commands: full, reason: `удаление, смена типа или особый путь ${JSON.stringify(path)}` };
    }
    const matches = rules.filter(({ paths }) => paths.some((prefix) =>
      prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix));
    if (!matches.length) return { commands: full, reason: `нет правила для ${JSON.stringify(path)}` };
    for (const rule of matches) matched.add(rule);
  }
  const commands = [...new Set(rules.filter((rule) => matched.has(rule)).flatMap((rule) => rule.commands))];
  return { commands, reason: 'все пути покрыты правилами' };
}

function runChecks({ commands, reason }, root) {
  console.log(`[scoped] ${reason}`);
  for (const command of commands) {
    const options = { cwd: root, stdio: 'inherit', windowsHide: true };
    const startedAt = Date.now();
    console.log(`[scoped] > ${command}`);
    const shell = hostShellCommand(command);
    const result = process.platform === 'win32'
      ? spawnSync(shell.command, [...shell.args.slice(0, -1), `"${command}"`], {
        ...options, windowsVerbatimArguments: true,
      })
      : spawnSync(shell.command, shell.args, options);
    if (result.error) console.error(result.error.message);
    const status = result.status ?? 75;
    console.log(`[scoped] ${Date.now() - startedAt} ms, exit ${status}`);
    if (status !== 0) return status;
  }
  return 0;
}

function main() {
  const scope = process.env.RALPH_VALIDATION_SCOPE;
  const base = process.env.RALPH_VALIDATION_BASE_COMMIT;
  const configFile = process.argv[2];
  if (process.argv.length !== 3 || scope !== 'issue'
    || !/^[0-9a-f]{40}$/u.test(base ?? '')) {
    throw new Error('Нужны путь к JSON, RALPH_VALIDATION_SCOPE=issue и полный RALPH_VALIDATION_BASE_COMMIT.');
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trimEnd();
  const changes = changedFiles(root, base);
  const config = readRules(root, base, configFile, changes);
  const plan = planChecks(config, changes, root);
  const paths = [...changes.keys()].sort();
  const fingerprint = createHash('sha256').update(JSON.stringify([base, paths, plan.commands]));
  console.log(`[scoped] ${scope}; base=${base}; plan=${fingerprint.digest('hex')}; rerun=always`);
  console.log('[scoped] paths:', JSON.stringify(paths));
  return runChecks(plan, root);
}

try {
  process.exitCode = main();
} catch (error) {
  console.error('[scoped]', error.message);
  process.exitCode = 79;
}
