import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync,
  mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, removeTemporaryDirectory } from './ralph-process-runner.mjs';
import { agentInstructionFiles } from './ralph-config.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contexts = new WeakMap();
const assessments = new WeakMap();
const protectedModules = new Set(['ralph-lifecycle.mjs', 'ralph-lifecycle-host.mjs', 'ralph-lisa-repair.mjs']);
const beforeCommit = new Set(['agent-running', 'working-tree', 'validating', 'validation-mutated', 'validation-diagnostic', 'review-failed']);
const digest = (value) => createHash('sha256').update(value).digest('hex');

function identity(options) {
  if (options.identity) return options.identity();
  const execute = options.run ?? run;
  return { branch: execute('git', ['branch', '--show-current']).stdout,
    head: execute('git', ['rev-parse', 'HEAD']).stdout };
}

function tree(root, options) {
  const files = options.files ? options.files() : (options.run ?? run)(
    'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  ).stdout.split('\0').filter(Boolean);
  const result = new Map();
  for (const name of [...new Set(files)].sort()) {
    const relative = name.replaceAll('\\', '/');
    const target = path.resolve(root, name);
    if (path.isAbsolute(name) || relative.split('/').includes('..') || !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Lisa: небезопасный путь ${name}.`);
    }
    const stats = lstatSync(target, { throwIfNoEntry: false });
    if (!stats) { result.set(relative, { hash: 'deleted', content: null }); continue; }
    const parent = realpathSync(path.dirname(target));
    const parentRelative = path.relative(realpathSync(root), parent);
    if (parentRelative === '..' || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
      throw new Error(`Lisa: путь выходит за проект ${name}.`);
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) throw new Error(`Lisa: не обычный файл ${name}.`);
    const content = stats.isSymbolicLink() ? Buffer.from(readlinkSync(target)) : readFileSync(target);
    result.set(relative, { hash: `${stats.isSymbolicLink() ? 'link:' : 'file:'}${digest(content)}`, content });
  }
  return result;
}

const treeHash = (entries) => digest(JSON.stringify([...entries].map(([name, entry]) => [name, entry.hash])));
const changedPaths = (before, after) => [...new Set([...before.keys(), ...after.keys()])]
  .filter((name) => before.get(name)?.hash !== after.get(name)?.hash).sort();

export function lisaRepairTreeHash(options = {}) {
  return treeHash(tree(path.resolve(options.projectRoot ?? projectRoot), options));
}

export function lisaFailureFingerprint(error, step) {
  const message = String(error?.message ?? '').replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z\b/gu, '<time>')
    .replace(/\b(?:PID|pid)[=: ]+\d+/gu, 'PID');
  return digest(JSON.stringify([step, error?.code ?? null, message]));
}

export function captureLisaRepairContext(config, store, error, options = {}) {
  const root = path.resolve(options.projectRoot ?? projectRoot);
  const workspace = identity(options);
  const baseline = tree(root, options);
  const controls = new Map(config.trustedControlFileHashes ?? []);
  const currentInstructions = agentInstructionFiles(root);
  if (config.agentInstructionFiles && (currentInstructions.length !== config.agentInstructionFiles.length ||
      currentInstructions.some((file) => !config.agentInstructionFiles.includes(file)))) {
    throw new Error('Lisa: внешняя правка набора инструкций.');
  }
  for (const [file, hash] of controls) {
    if (digest(readFileSync(file)) !== hash) throw new Error(`Lisa: внешняя правка управляющего файла ${file}.`);
  }
  const state = structuredClone(store.state);
  const step = options.failureStep ?? state?.issue?.phase ?? 'phase';
  const context = Object.freeze({
    repairId: options.repairId ?? randomUUID(), runId: state?.runId,
    phaseIndex: state?.phaseIndex, issueNumber: state?.issue?.number ?? null,
    ...workspace, failureStep: step, failureFingerprint: lisaFailureFingerprint(error, step),
    baselineTreeHash: treeHash(baseline), baselineControlHashes: controls,
    policy: structuredClone(config),
  });
  contexts.set(context, { root, baseline, state, config: structuredClone(config),
    instructions: new Map(agentInstructionFiles(root).map((file) => [file, digest(readFileSync(file))])),
    controls: new Map(controls), statePath: options.statePath,
    stateBytes: options.statePath ? readFileSync(options.statePath) : null });
  return context;
}

function checkedContext(context, options) {
  const saved = contexts.get(context);
  if (!saved) throw new Error('Lisa: неизвестный контекст ремонта.');
  const instructions = agentInstructionFiles(saved.root);
  if (instructions.length !== saved.instructions.size || instructions.some((file) =>
    saved.instructions.get(file) !== digest(readFileSync(file)))) {
    throw new Error('Lisa: ремонт инструкций пока требует оператора.');
  }
  const current = identity(options);
  if (current.branch !== context.branch || current.head !== context.head) {
    throw new Error('Lisa изменила ветку или HEAD. Нужен оператор.');
  }
  if (saved.statePath && !readFileSync(saved.statePath).equals(saved.stateBytes)) {
    throw new Error('Lisa изменила сохранённое состояние. Нужен оператор.');
  }
  return saved;
}

export async function assessLisaRepair(context, options = {}) {
  const saved = checkedContext(context, options);
  const after = tree(saved.root, options);
  const paths = changedPaths(saved.baseline, after);
  for (const name of saved.state?.issue?.foreignPaths ?? []) {
    if (paths.includes(name.replaceAll('\\', '/'))) throw new Error(`Lisa изменила чужую работу: ${name}.`);
  }
  const ralphPaths = paths.filter((name) => name.startsWith('scripts/ralph/'));
  if (ralphPaths.length && (!beforeCommit.has(saved.state?.issue?.phase) || saved.state?.issue?.commit)) {
    throw new Error('Lisa: ремонт Ralph после коммита требует оператора.');
  }
  for (const name of paths) {
    if (['AGENTS.md', 'CLAUDE.md'].includes(path.basename(name)) ||
        name.startsWith('.claude/') || name.startsWith('.agents/skills/')) {
      throw new Error(`Lisa: ремонт инструкций пока требует оператора: ${name}.`);
    }
    if (after.get(name)?.hash.startsWith('link:')) throw new Error(`Lisa: новая или изменённая ссылка ${name}.`);
    if (name.startsWith('scripts/ralph/') && protectedModules.has(path.basename(name))) {
      throw new Error(`Lisa: механизм восстановления нельзя ремонтировать: ${name}.`);
    }
  }
  for (const [file, hash] of saved.controls) {
    const relative = path.relative(saved.root, file).replaceAll('\\', '/');
    const stats = lstatSync(file, { throwIfNoEntry: false });
    const current = stats?.isFile() ? digest(readFileSync(file)) : null;
    if (hash === current) continue;
    if (!relative.startsWith('scripts/ralph/') || !relative.endsWith('.mjs')) {
      throw new Error(`Lisa: ремонт конфига или инструкций пока требует оператора: ${relative}.`);
    }
    if (!stats?.isFile()) throw new Error(`Lisa удалила управляющий модуль: ${relative}.`);
  }
  if (!options.review) throw new Error('Lisa: независимое ревью ремонта обязательно.');
  const changes = paths.map((name) => ({ path: name,
    before: saved.baseline.get(name)?.content?.toString('utf8') ?? null,
    after: after.get(name)?.content?.toString('utf8') ?? null,
  }));
  const review = await options.review({ context, policy: structuredClone(saved.config), state: structuredClone(saved.state), changes });
  if (review?.verdict !== 'pass') throw new Error(`Lisa: ремонт не принят: ${review?.reason ?? 'нет вердикта ревью'}.`);
  if (!options.validate) throw new Error('Lisa: проверки ремонта обязательны.');
  await options.validate({ context, changedPaths: paths, config: structuredClone(saved.config) });
  checkedContext(context, options);
  if (treeHash(tree(saved.root, options)) !== treeHash(after)) throw new Error('Lisa: проверки изменили дерево ремонта.');
  const assessment = { changedPaths: paths, ralphChanged: ralphPaths.length > 0, treeHash: treeHash(after), review };
  assessments.set(assessment, { context, result: structuredClone(assessment) });
  return assessment;
}

export function acceptLisaRepair(context, assessment, options = {}) {
  const saved = checkedContext(context, options);
  const checked = assessments.get(assessment);
  if (checked?.context !== context) throw new Error('Lisa: нет принятого ревью ремонта.');
  if (treeHash(tree(saved.root, options)) !== checked.result.treeHash) throw new Error('Lisa: дерево изменилось после приёмки.');
  return { repairId: context.repairId, acceptedTreeHash: checked.result.treeHash,
    changedPaths: [...checked.result.changedPaths], ralphChanged: checked.result.ralphChanged };
}

export function updateLisaRepairContextState(context, update, options = {}) {
  const saved = checkedContext(context, options);
  update();
  if (saved.statePath) saved.stateBytes = readFileSync(saved.statePath);
}

export function createTrustedRepairRuntime(directory = path.dirname(fileURLToPath(import.meta.url))) {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-repair-runtime-'));
  const hashes = new Map();
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    const bytes = readFileSync(path.join(directory, name));
    writeFileSync(path.join(root, name), bytes);
    hashes.set(name, digest(bytes));
  }
  const schemaPath = path.join(root, 'repair-review.schema.json');
  const schema = JSON.stringify({ type: 'object', additionalProperties: false,
    required: ['verdict', 'reason'], properties: {
      verdict: { type: 'string', enum: ['pass', 'human'] }, reason: { type: 'string', minLength: 1 },
    } });
  writeFileSync(schemaPath, schema);
  hashes.set('repair-review.schema.json', digest(schema));
  return {
    root, schemaPath, commandRunnerPath: path.join(root, 'ralph-command-runner.mjs'),
    assertUnchanged() {
      for (const [name, expected] of hashes) {
        const target = path.join(root, name);
        if (!lstatSync(target, { throwIfNoEntry: false })?.isFile() || digest(readFileSync(target)) !== expected) {
          throw new Error(`Lisa: доверенная копия механизма восстановления изменена: ${name}.`);
        }
      }
    },
    cleanup: () => removeTemporaryDirectory(root),
  };
}
