import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './ralph-process-runner.mjs';
import { validationScriptsFor } from './ralph-process-packs.mjs';
import { hostValidationEnvironment, runConfiguredValidation } from './ralph-validation-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const digest = value => createHash('sha256').update(value).digest('hex');

// The project opts in by listing every mutable local input (or its version
// manifest) outside Git. Hash their contents; never put their values in IPC.
function localInputHashes(directory, names) {
  const canonicalRoot = realpathSync(directory);
  return names.map(name => {
    const target = path.join(canonicalRoot, name);
    const inside = path.relative(canonicalRoot, target);
    if (!inside || inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside) ||
        path.relative(target, realpathSync(target)) !== '' || !lstatSync(target).isFile()) {
      throw new Error('Validation handoff input is not a regular project file.');
    }
    return [name, digest(readFileSync(target))];
  });
}

function workingModes(directory, execute) {
  const tracked = execute('git', ['diff', '--raw', '-z', '--no-renames', 'HEAD'], { rawStdout: true }).stdout;
  const others = execute('git', ['ls-files', '-z', '--others', '--exclude-standard'], { rawStdout: true }).stdout;
  return [tracked, others.split('\0').filter(Boolean).sort().map(name =>
    [name, lstatSync(path.join(directory, name)).mode & 0o111])];
}

export function validationHandoffKey(config, state, paths, options = {}) {
  const issue = state?.issue;
  const inputs = config.validationHandoffInputs;
  if (!inputs?.length || !config.validationProfiles || !issue?.number || !state.runId ||
      !Number.isInteger(state.phaseIndex) || !state.phasePlanId || !config.branch ||
      !state.lisaRepair?.repairId || !/^[a-f0-9]{40}$/u.test(issue.startingCommit ?? '') ||
      !config.trustedControlFileHashes?.size) return null;
  try {
    const commands = validationScriptsFor(config, 'issue', issue.number, { baseCommit: issue.startingCommit, run: options.run });
    if (!commands.length) return null;
    const environment = hostValidationEnvironment(config, options.environment ?? process.env, paths);
    return digest(JSON.stringify({
      run: state.runId, repair: state.lisaRepair.repairId, phase: state.phaseIndex, plan: state.phasePlanId,
      issue: issue.number, base: issue.startingCommit, branch: config.branch,
      contract: config.approvedIssueSnapshots?.[issue.number]?.body ?? issue.body,
      preflight: config.preflightScripts, commands, artifacts: config.validationArtifactPaths,
      controls: [...config.trustedControlFileHashes].sort(), environment: Object.entries(environment).sort(),
      platform: process.platform, arch: process.arch, node: process.version, executable: process.execPath,
      inputs: localInputHashes(options.root ?? root, inputs),
      modes: workingModes(options.root ?? root, options.run ?? run),
    }));
  } catch {
    // A missing input or unavailable tool cannot grant permission to skip a check.
    return null;
  }
}

// Capture the exact prepared inputs. An exception still rejects the repair;
// a successful validation with missing or changing inputs simply cannot travel.
export function validateForHandoff(config, state, target, paths, options = {}) {
  let preparedKey = null;
  const validate = options.validate ?? runConfiguredValidation;
  const validation = validate(config, {
    ...target, validationPathDirectories: paths,
    onPrepared: () => {
      if (target.scope === 'issue') preparedKey = validationHandoffKey(config, state, paths, options);
    },
  });
  if (!preparedKey || !validation.timings?.some(timing => timing.stage === 'check' && timing.passed)) return null;
  return preparedKey === validationHandoffKey(config, state, paths, options) ? preparedKey : null;
}

// The parent supplies this object via its authenticated, in-memory worker IPC.
// On a manual restart only the on-disk state survives and all checks run again.
export function canUseValidationHandoff(receipt, key, workspace) {
  return Boolean(key && receipt?.validationKey === key && !receipt.ralphChanged &&
    receipt.issueHead && receipt.issueHead === workspace.head &&
    typeof workspace.tree === 'string' && receipt.acceptedTreeHash === workspace.tree &&
    typeof workspace.index === 'string' && receipt.acceptedIndexHash === workspace.index);
}
