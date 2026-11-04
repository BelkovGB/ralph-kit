import { isDeepStrictEqual } from 'node:util';
import { prepareConfig, configForPhase } from './ralph-config.mjs';

const repairableCommands = new Set(['preflightScripts', 'validationScripts', 'validationProfiles']);

/** Parse a proposal without granting new trust or applying process settings. */
export function prepareLisaRepairConfig(before, after, originalConfig, phaseIndex, options = {}) {
  if (!after || typeof after !== 'object' || Array.isArray(after)) {
    throw new Error('Lisa: конфиг ремонта должен быть объектом.');
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!repairableCommands.has(key) && !isDeepStrictEqual(before[key], after[key])) {
      throw new Error(`Lisa: ремонт меняет исходную политику: ${key}.`);
    }
  }
  for (const name of ['preflightScripts', 'validationScripts']) {
    if (!Array.isArray(after[name] ?? []) || (after[name] ?? []).length < (before[name] ?? []).length) {
      throw new Error(`Lisa: нельзя удалять обязательные команды ${name}.`);
    }
  }
  if (Boolean(before.validationProfiles) !== Boolean(after.validationProfiles)) {
    throw new Error('Lisa: нельзя менять режим обязательных проверок validationProfiles.');
  }
  if (before.validationProfiles) {
    for (const scope of ['issue', 'phase', 'baseSync']) {
      if (!Array.isArray(after.validationProfiles?.[scope]) ||
          after.validationProfiles[scope].length < before.validationProfiles[scope].length) {
        throw new Error(`Lisa: нельзя удалять обязательные проверки профиля ${scope}.`);
      }
    }
  }
  const candidate = (options.prepareConfig ?? prepareConfig)(structuredClone(after), { captureControlPlane: false });
  const effective = candidate.phases ? configForPhase(candidate, phaseIndex) : candidate;
  return { ...structuredClone(originalConfig), ...effective };
}
