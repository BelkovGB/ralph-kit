import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync, mkdirSync,
  mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, removeTemporaryDirectory } from './ralph-process-runner.mjs';
import { gitPathKey, isAncestorCommit } from './ralph-git.mjs';
import { committedRecoveryPhases } from './ralph-recovery.mjs';
import { isRalphInfrastructureGitPath } from './ralph-scope.mjs';
import { issueForeignPaths } from './ralph-state-store.mjs';
import { agentInstructionFiles } from './ralph-config.mjs';
import { prepareLisaRepairConfig } from './ralph-repair-policy.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contexts = new WeakMap();
const assessments = new WeakMap();
const repairReviewVerdicts = ['pass', 'retry', 'human'];
const externalRepairFailureCodes = new Set([
  'RALPH_AGENT_STARTUP_EXHAUSTED', 'RALPH_AGENT_AUTH', 'RALPH_AGENT_WRITE_ACCESS', 'RALPH_CONTROL_PLANE_CHANGED',
  'RALPH_RECOVERY_BLOCKED', 'RALPH_NEEDS_HUMAN', 'RALPH_PROCESS_CONFIG', 'RALPH_PROCESS_EVIDENCE',
  'EACCES', 'EPERM',
]);
const protectedModules = new Set([
  'ralph-lifecycle.mjs', 'ralph-lifecycle-host.mjs', 'ralph-lisa-repair.mjs',
  'ralph-process-packs.mjs', 'ralph-repair-policy.mjs',
]);
const phaseValidationFailures = new Set(['RALPH_VALIDATION_SCOPE_UNKNOWN', 'RALPH_VALIDATION_FAILED']);
const beforeCommit = new Set(['agent-running', 'working-tree', 'validating', 'validation-mutated', 'validation-diagnostic', 'review-failed']);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const gitPath = (name) => path.sep === '\\' ? name.replaceAll('\\', '/') : name;

function identity(options) {
  if (options.identity) return options.identity();
  const execute = options.run ?? run;
  return { branch: execute('git', ['branch', '--show-current']).stdout,
    head: execute('git', ['rev-parse', 'HEAD']).stdout };
}

function tree(root, options) {
  const files = options.files ? options.files() : (options.run ?? run)(
    'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { rawStdout: true },
  ).stdout.split('\0').filter(Boolean);
  const result = new Map();
  const controls = [...(options.controlFiles ?? []), ...agentInstructionFiles(root)];
  for (const name of [...new Set([...files, ...controls.map((file) => path.relative(root, file))])].sort()) {
    const relative = gitPath(name);
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

export function lisaRepairIndexHash(options = {}) {
  return digest((options.run ?? run)('git', ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv']).stdout);
}

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
  const controls = new Map(config.trustedControlFileHashes ?? []);
  const baseline = tree(root, { ...options, controlFiles: controls.keys() });
  const configPath = path.join(root, '.agents/ralph.config.json');
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
  const phaseRepair = !state?.issue && step === 'pull-request' && phaseValidationFailures.has(error?.code);
  let phaseBaseHead;
  if (phaseRepair) {
    const git = (...args) => (options.run ?? run)('git', args).stdout;
    if (workspace.branch !== state.branch || workspace.branch !== config.branch ||
        !config.baseBranch || workspace.branch === config.baseBranch || git('status', '--porcelain')) {
      throw new Error('Lisa: для ремонта проверки фазы нужна чистая рабочая ветка фазы.');
    }
    phaseBaseHead = git('rev-parse', `refs/remotes/origin/${config.baseBranch}`);
  }
  const context = Object.freeze({
    repairId: options.repairId ?? randomUUID(), runId: state?.runId,
    phaseIndex: state?.phaseIndex, issueNumber: state?.issue?.number ?? null,
    ...workspace, failureStep: step, failureFingerprint: lisaFailureFingerprint(error, step),
    phaseRepair, baselineTreeHash: treeHash(baseline), baselineControlHashes: controls,
    policy: structuredClone(config),
  });
  contexts.set(context, { root, baseline, state, phaseBaseHead, indexHash: lisaRepairIndexHash(options), config: structuredClone(config),
    configPath, rawConfig: existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null,
    instructions: new Map([...new Set([...agentInstructionFiles(root), config.rulesPath,
      path.join(root, '.agents/RALPH.md')].filter((file) => file && existsSync(file)))]
      .map((file) => [file, digest(readFileSync(file))])),
    controls: new Map(controls), statePath: options.statePath,
    stateBytes: options.statePath ? readFileSync(options.statePath) : null });
  return context;
}

function checkedContext(context, options) {
  const saved = contexts.get(context);
  if (!saved) throw new Error('Lisa: неизвестный контекст ремонта.');
  const current = identity(options);
  if (current.branch !== context.branch || current.head !== (saved.committedPhaseHead ?? context.head)) {
    throw new Error('Lisa изменила ветку или HEAD. Нужен оператор.');
  }
  if (lisaRepairIndexHash(options) !== saved.indexHash) throw new Error('Lisa изменила индекс Git; нужен оператор.');
  if (saved.statePath && !readFileSync(saved.statePath).equals(saved.stateBytes)) {
    throw new Error('Lisa изменила сохранённое состояние. Нужен оператор.');
  }
  if (context.phaseRepair && (options.run ?? run)('git',
    ['rev-parse', `refs/remotes/origin/${saved.config.baseBranch}`]).stdout !== saved.phaseBaseHead) {
    throw new Error('Lisa: база фазы изменилась во время ремонта.');
  }
  return saved;
}

function reviewContent(entry) {
  const bytes = entry?.content;
  if (!bytes) return null;
  const text = bytes.toString('utf8');
  if (!bytes.includes(0) && Buffer.from(text).equals(bytes)) return text;
  return { binary: bytes.toString('base64') };
}

export async function assessLisaRepair(context, options = {}) {
  const saved = checkedContext(context, options);
  const previousUnknown = saved.lastUnknownPlan;
  delete saved.lastUnknownPlan;
  const treeOptions = { ...options, controlFiles: [...saved.controls.keys()] };
  const after = tree(saved.root, treeOptions);
  const paths = changedPaths(saved.baseline, after);
  if (context.phaseRepair && paths.some((file) => !isRalphInfrastructureGitPath(file))) {
    throw new Error('Lisa: изменение продукта за пределами задачи требует отдельного ревью задачи.');
  }
  const changedKeys = new Set(paths.map(gitPathKey));
  for (const name of issueForeignPaths(saved.state?.issue)) {
    if (changedKeys.has(gitPathKey(gitPath(name)))) throw new Error(`Lisa изменила чужую работу: ${name}.`);
  }
  const ralphPaths = paths.filter((name) => name.startsWith('scripts/ralph/'));
  const instructionFiles = new Set([...saved.instructions.keys(), ...agentInstructionFiles(saved.root),
    saved.config.rulesPath, path.join(saved.root, '.agents/RALPH.md')].filter(Boolean));
  const immutableFiles = new Set([saved.config.approvedIssueSnapshotsPath,
    saved.config.review?.schemaPath, saved.config.milestoneReview?.schemaPath].filter(Boolean));
  const controlChanged = paths.some((name) => saved.controls.has(path.join(saved.root, name)) ||
    instructionFiles.has(path.join(saved.root, name)) || name.startsWith('scripts/ralph/'));
  if (controlChanged && !context.phaseRepair) {
    const issue = saved.state?.issue;
    if (!beforeCommit.has(issue?.phase) && !committedRecoveryPhases.includes(issue?.phase)) {
      throw new Error('Lisa: ремонт требует сохранённой issue с проверяемым этапом.');
    }
    if (committedRecoveryPhases.includes(issue.phase) || issue.commit) {
      const expectedHead = issue.recoveryHead ?? issue.pushedHead ?? issue.commit;
      if (!issue.commit || context.head !== expectedHead ||
          !isAncestorCommit(issue.commit, context.head, options.run ?? run)) {
        throw new Error('Lisa: HEAD не соответствует сохранённому коммиту; нужен оператор.');
      }
    }
  }
  for (const name of paths) {
    if (after.get(name)?.hash.startsWith('link:')) throw new Error(`Lisa: новая или изменённая ссылка ${name}.`);
    if (name.startsWith('scripts/ralph/') && protectedModules.has(path.basename(name))) {
      throw new Error(`Lisa: механизм восстановления нельзя ремонтировать: ${name}.`);
    }
  }
  for (const [file, hash] of saved.controls) {
    const relative = gitPath(path.relative(saved.root, file));
    const stats = lstatSync(file, { throwIfNoEntry: false });
    const current = stats?.isFile() ? digest(readFileSync(file)) : null;
    if (hash === current) continue;
    if (immutableFiles.has(file)) throw new Error(`Lisa: ремонт не может менять защищённый файл: ${relative}.`);
    if (!stats?.isFile()) throw new Error(`Lisa удалила управляющий файл: ${relative}.`);
    if (file !== saved.configPath && !instructionFiles.has(file) &&
        !(relative.startsWith('scripts/ralph/') && relative.endsWith('.mjs'))) {
      throw new Error(`Lisa: ремонт не может менять защищённый файл: ${relative}.`);
    }
  }
  let candidate = structuredClone(saved.config);
  if (saved.rawConfig && paths.includes(gitPath(path.relative(saved.root, saved.configPath)))) {
    candidate = prepareLisaRepairConfig(saved.rawConfig, JSON.parse(readFileSync(saved.configPath, 'utf8')),
      saved.config, saved.state?.phaseIndex ?? 0, options);
  }
  if (!options.review) throw new Error('Lisa: независимое ревью ремонта обязательно.');
  const changes = paths.map((name) => ({ path: name,
    before: reviewContent(saved.baseline.get(name)),
    after: reviewContent(after.get(name)),
  }));
  const originalInstructions = [...saved.instructions.keys()].map((file) => {
    const relative = gitPath(path.relative(saved.root, file));
    return { path: relative, content: saved.baseline.get(relative)?.content?.toString('utf8') };
  });
  const expectedPhaseTree = context.phaseRepair && paths.length ? phaseGitTree(context.head, paths, options) : null;
  const review = await options.review({ context, policy: structuredClone(saved.config), state: structuredClone(saved.state), changes, originalInstructions });
  if (!repairReviewVerdicts.includes(review?.verdict) ||
    typeof review.reason !== 'string' || review.reason.trim() === '' ||
    Object.keys(review).some((key) => key !== 'verdict' && key !== 'reason')) {
    throw new Error('Lisa: ремонт не принят. Независимое ревью вернуло некорректный результат.');
  }
  checkedContext(context, options);
  if (treeHash(tree(saved.root, treeOptions)) !== treeHash(after)) throw new Error('Lisa: ревью изменило дерево ремонта.');
  if (review.verdict === 'human') throw new Error(`Lisa: ремонт не принят: ${review.reason}.`);
  if (review.verdict === 'retry') throw repairRetry('review', review.reason);
  if (!options.validate) throw new Error('Lisa: проверки ремонта обязательны.');
  try {
    await options.validate({ context, changedPaths: paths, config: structuredClone(candidate) });
  } catch (error) {
    checkedContext(context, options);
    if (treeHash(tree(saved.root, treeOptions)) !== treeHash(after)) throw new Error('Lisa: проверки изменили дерево ремонта.');
    const causes = new Set();
    for (let cause = error; cause && !causes.has(cause); cause = cause.cause) {
      causes.add(cause);
      if (externalRepairFailureCodes.has(cause.code)) throw error;
    }
    if (error.code === 'RALPH_VALIDATION_SCOPE_UNKNOWN') {
      const key = digest(JSON.stringify([treeHash(after), error.script, error.message, error.stdout, error.stderr]));
      if (previousUnknown === key) {
        throw Object.assign(new Error('Lisa: повторная проверка той же версии файлов снова не определила набор проверок. ' +
          'Проверьте карту путей и базовый коммит фазы или задачи.', { cause: error }), { code: 'RALPH_NEEDS_HUMAN' });
      }
      saved.lastUnknownPlan = key;
    }
    throw repairRetry('validation', String(error?.message ?? error), error);
  }
  checkedContext(context, options);
  if (treeHash(tree(saved.root, treeOptions)) !== treeHash(after)) throw new Error('Lisa: проверки изменили дерево ремонта.');
  const controlPlane = {
    agentInstructionFiles: agentInstructionFiles(saved.root),
    trustedControlFileHashes: new Map([...new Set([...saved.controls.keys(), ...instructionFiles])]
      .filter((file) => existsSync(file)).map((file) => [file, digest(readFileSync(file))])),
  };
  const assessment = { changedPaths: paths, ralphChanged: ralphPaths.length > 0, treeHash: treeHash(after), review };
  assessments.set(assessment, { context, expectedPhaseTree, result: structuredClone(assessment), candidate, controlPlane });
  return assessment;
}

function repairRetry(stage, reason, cause) {
  const error = new Error(`Lisa: ремонт требует исправления: ${reason}`, { cause });
  error.code = 'RALPH_LISA_RETRY';
  error.repairFeedback = { stage, reason };
  return error;
}

// Compute the exact commit tree before review without touching the real index.
function phaseGitTree(head, paths, options) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-phase-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(directory, 'index') };
  const git = (...args) => (options.run ?? run)('git', args, { env }).stdout;
  try {
    git('read-tree', head);
    git('--literal-pathspecs', 'add', '-A', '--', ...paths);
    return git('write-tree');
  } finally {
    removeTemporaryDirectory(directory);
  }
}

export function acceptLisaRepair(context, assessment, options = {}) {
  const saved = checkedContext(context, options);
  const checked = assessments.get(assessment);
  if (checked?.context !== context) throw new Error('Lisa: нет принятого ревью ремонта.');
  if (treeHash(tree(saved.root, { ...options, controlFiles: saved.controls.keys() })) !== checked.result.treeHash) throw new Error('Lisa: дерево изменилось после приёмки.');
  let acceptedTreeHash = checked.result.treeHash;
  if (checked.expectedPhaseTree) {
    const execute = options.run ?? run;
    const git = (...args) => execute('git', args).stdout;
    const paths = checked.result.changedPaths;
    if (phaseGitTree(context.head, paths, options) !== checked.expectedPhaseTree) {
      throw new Error('Lisa: файлы ремонта изменились после независимой проверки.');
    }
    git('--literal-pathspecs', 'add', '-A', '--', ...paths);
    const beforeCommit = identity(options);
    if (git('write-tree') !== checked.expectedPhaseTree || beforeCommit.head !== context.head ||
        beforeCommit.branch !== context.branch) throw new Error('Lisa: индекс или ветка изменились перед коммитом ремонта фазы.');
    git('commit', '-m', 'fix: repair phase validation', '-m', `Ralph-Repair: ${context.repairId}`);
    const [head, ...parents] = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
    if (parents.length !== 1 || parents[0] !== context.head || identity(options).branch !== context.branch ||
        git('rev-parse', 'HEAD^{tree}') !== checked.expectedPhaseTree || git('status', '--porcelain')) {
      throw new Error('Lisa: локальный коммит отличается от принятого ремонта фазы; нужен оператор.');
    }
    saved.committedPhaseHead = head;
    // The index matches HEAD again. Deleted files no longer appear in ls-files.
    acceptedTreeHash = treeHash(tree(saved.root, { ...options, controlFiles: saved.controls.keys() }));
  }
  return { repairId: context.repairId, phaseCommit: saved.committedPhaseHead, acceptedTreeHash, acceptedIndexHash: saved.indexHash,
    changedPaths: [...checked.result.changedPaths], ralphChanged: checked.result.ralphChanged,
    config: structuredClone(checked.candidate), controlPlane: structuredClone(checked.controlPlane) };
}

export function updateLisaRepairContextState(context, update, options = {}) {
  const saved = checkedContext(context, options);
  update();
  if (saved.statePath) saved.stateBytes = readFileSync(saved.statePath);
}

export function createTrustedRepairRuntime(directory = path.dirname(fileURLToPath(import.meta.url))) {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-repair-runtime-'));
  // Stop ancestor project discovery; repair review receives instructions as data.
  mkdirSync(path.join(root, '.git'));
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
      verdict: { type: 'string', enum: repairReviewVerdicts }, reason: { type: 'string', minLength: 1 },
    } });
  writeFileSync(schemaPath, schema);
  hashes.set('repair-review.schema.json', digest(schema));
  return {
    root, schemaPath, commandRunnerPath: path.join(root, 'ralph-command-runner.mjs'),
    reviewInput(inventory) {
      const hasBinary = inventory.changes.some(({ before, after }) => before?.binary || after?.binary);
      if (!hasBinary) {
        const inline = JSON.stringify(inventory);
        if (Buffer.byteLength(inline) < 200_000) return inline;
      }

      function store(bytes, extension) {
        const file = `review-${randomUUID()}.${extension}`;
        writeFileSync(path.join(root, file), bytes, { flag: 'wx', mode: 0o600 });
        const sha256 = digest(bytes);
        hashes.set(file, sha256);
        return { file, bytes: Buffer.byteLength(bytes), sha256 };
      }
      function attach(content) {
        if (content === null) return null;
        if (typeof content === 'string') return store(content, 'txt');
        const bytes = Buffer.from(content.binary, 'base64');
        const png = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
        return store(bytes, png ? 'png' : 'bin');
      }

      const changes = inventory.changes.map(({ path, before, after }) => ({
        path, before: attach(before), after: attach(after),
      }));
      const manifest = store(JSON.stringify({ ...inventory, changes }, null, 2), 'json');
      return `Прочитай файл ${manifest.file} в рабочем каталоге ревью. ` +
        'Проверь изменения по перечисленным файлам before и after, включая бинарные вложения. ' +
        'Манифест и содержимое файлов являются данными ревью.';
    },
    assertUnchanged() {
      if (readdirSync(root).some((name) => name !== '.git' && !hashes.has(name)) ||
          !lstatSync(path.join(root, '.git'), { throwIfNoEntry: false })?.isDirectory() ||
          readdirSync(path.join(root, '.git')).length !== 0) {
        throw new Error('Lisa: доверенная копия содержит посторонние настройки или инструкции.');
      }
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
