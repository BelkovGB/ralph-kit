import { runAgentSession } from './ralph-agent-session.mjs';
import { claudeBackend } from './ralph-claude-session.mjs';
import { codexBackend } from './ralph-codex-session.mjs';
import { withRecordedTelemetry } from './ralph-run-metrics.mjs';
import { fail } from './ralph-scope.mjs';

/**
 * Выбор backend по конфигурации.
 *
 * Отдельный модуль, а не функция внутри `ralph-agent-session.mjs`: тот
 * импортируется обоими backend, и таблица в нём замкнула бы цикл ESM — при
 * загрузке backend первым `codexBackend` попал бы в temporal dead zone.
 */

const backends = new Map([
  [codexBackend.cli, codexBackend],
  [claudeBackend.cli, claudeBackend],
]);

export const agentClis = [...backends.keys()];

export function agentBackend(config) {
  const cli = config?.agentCli ?? 'codex';
  const backend = backends.get(cli);
  if (!backend) {
    fail(`Поле "agentCli" должно быть одним из: ${agentClis.join(', ')}.`);
  }
  return backend;
}

export function reasoningEffortsFor(agentCli) {
  return backends.get(agentCli)?.reasoningEfforts ?? [];
}

export function agentBinary(config) {
  return agentBackend(config).binary;
}

export function verifyAgentAuthentication(config, dependencies = {}) {
  return agentBackend(config).verifyAuthentication(dependencies);
}

export async function runDevelopmentSession(config, options) {
  const backend = agentBackend(config);
  return withRecordedTelemetry('development', () =>
    runAgentSession(backend, backend.developmentArguments(config), options),
  );
}

/**
 * role — это `config.review` или `config.milestoneReview`: модель, усилие, путь
 * к схеме и путь к файлу результата.
 *
 * Контракт для вызывающего один: после успешного возврата результат лежит в
 * `role.outputPath`. Codex пишет его сам флагом `--output-last-message`, у
 * Claude такого флага нет, поэтому файл пишет backend.
 */
export async function runReviewSession(config, role, options) {
  const backend = agentBackend(config);
  // Роль различается по тождеству объекта конфигурации, а не по имени поля:
  // обе роли приходят сюда одной и той же формой, и отдельного признака у них
  // нет. Разделение нужно только метрикам — цена milestone-ревью на порядок
  // отличается от цены ревью одной issue.
  const metricsRole = role === config?.milestoneReview ? 'milestone-review' : 'review';
  const session = await withRecordedTelemetry(metricsRole, () =>
    runAgentSession(backend, backend.reviewArguments(role), options),
  );
  backend.writeReviewOutput?.(role, session);
  return session;
}
