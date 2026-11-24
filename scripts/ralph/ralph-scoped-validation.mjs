import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve, win32 } from 'node:path';
import { hasValidationCommandShape, usesValidationControlOperator } from './ralph-config.mjs';
import { verifyVisualContract, writesEvidence } from './ralph-route-evidence.mjs';
import { assertScopedHostCommands, hostShellCommand } from './ralph-validation-runner.mjs';

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

function planChecks({ full, rules }, changes, root, scope) {
  if (!changes.size && scope === 'issue') throw new Error('Пустой diff задачи. Проверьте базовый SHA.');
  const matched = new Set();
  for (const [path, statuses] of changes) {
    if ([...statuses].some((status) => !['A', 'M', 'D', '?'].includes(status))
      || !statuses.has('D') && !lstatSync(resolve(root, path), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('Особый путь требует адресной проверки: ' + path);
    }
    const matches = rules.filter(({ paths }) => paths.some((prefix) =>
      prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix));
    if (!matches.length) throw new Error('Нет адресного правила для ' + path);
    console.log('[scoped]', path, '=>', matches.flatMap(rule => rule.commands).join(', '));
    for (const rule of matches) matched.add(rule);
  }
  const commands = [...new Set(rules.filter((rule) => matched.has(rule)).flatMap((rule) => rule.commands))];
  assertScopedHostCommands(commands, full);
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

export function runFinalChecks(file) {
  if (process.env.RALPH_VALIDATION_SCOPE || process.env.RALPH_AGENT_ROLE) throw new Error('Final acceptance is external to Ralph.');
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trimEnd();
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const changes = changedFiles(root, head);
  if (changes.size) throw new Error('Final acceptance requires a clean commit.');
  return runChecks({commands: readRules(root, head, file, changes).full, reason: 'FinalAcceptance'}, root);
}

function main() {
  const args = process.argv.slice(2);
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trimEnd();
  const preview = args[0] === '--plan';
  if (args[0] === '--full') {
    const [, purpose, file, ...reasons] = args;
    const role = process.env.RALPH_AGENT_ROLE;
    const reason = reasons.join(' ').trim();
    if (process.env.RALPH_VALIDATION_SCOPE ||
        !(purpose === 'LisaEmergency' && role === 'supervisor' && reason)) throw new Error('Полный прогон недоступен в этой роли или без обоснования Lisa.');
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    const changes = changedFiles(root, head);
    return runChecks({commands: readRules(root, head, file, changes).full, reason: purpose + ' ' + reason}, root);
  }
  const [file, base, scope] = preview ? args.slice(1) :
    [args[0], process.env.RALPH_VALIDATION_BASE_COMMIT, process.env.RALPH_VALIDATION_SCOPE];
  if (args.length !== (preview ? 4 : 1) || !['issue', 'phase', 'baseSync'].includes(scope) ||
      !/^[0-9a-f]{40}$/u.test(base ?? '')) throw new Error('Укажите файл правил, область и полный SHA базы.');
  const changes = changedFiles(root, base);
  const config = readRules(root, base, file, changes);
  console.log('[scoped] paths:', JSON.stringify([...changes.keys()].sort()));
  const plan = planChecks(config, changes, root, scope);
  const fingerprint = createHash('sha256').update(JSON.stringify([base, [...changes.keys()].sort(), plan.commands]));
  console.log('[scoped]', scope, base, fingerprint.digest('hex'));
  if (preview) return 0;
  if (process.env.RALPH_VISUAL_CONTRACT) verifyVisualContract(process.env.RALPH_VISUAL_CONTRACT, [...changes.keys()], root);
  for (const [path, statuses] of changes) {
    if (!statuses.has('D') && /[.]spec[.][cm]?[jt]sx?$/u.test(path) &&
        writesEvidence(readFileSync(resolve(root, path), 'utf8'))) throw new Error('Use the Playwright output directory for screenshots: ' + path);
  }
  return runChecks(plan, root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) try {
  process.exitCode = main();
} catch (error) {
  console.error('[scoped]', error.message);
  process.exitCode = 79;
}
