import { readFileSync, rmSync, writeFileSync } from 'node:fs';

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

export async function runDevelopmentSession(config, options, metricsRole = 'development') {
  const backend = agentBackend(config);
  return withRecordedTelemetry(metricsRole, () =>
    runAgentSession(backend, backend.developmentArguments(config), options),
  );
}

/**
 * В роли заданы модель, усилие, схема и путь к артефакту. Адаптер задаёт
 * доступ ревьюера к файлам, аргументы CLI и источник результата.
 *
 * Возвращается объект свежего ревью. Он же сохраняется в `role.outputPath`.
 * Форму вердикта проверяет вызывающая роль по своему контракту.
 */
export async function runReviewSession(config, role, options) {
  const backend = agentBackend(config);
  const { review } = backend;
  rmSync(role.outputPath, { force: true });
  // Роль различается по тождеству объекта конфигурации, а не по имени поля:
  // обе роли приходят сюда одной и той же формой, и отдельного признака у них
  // нет. Разделение нужно только метрикам — цена milestone-ревью на порядок
  // отличается от цены ревью одной issue.
  const metricsRole = role === config?.milestoneReview ? 'milestone-review' : 'review';
  const session = await withRecordedTelemetry(metricsRole, () =>
    runAgentSession(backend, review.arguments({ ...role, workingDirectory: options.workingDirectory }), options),
  );

  const fromEvent = review.resultChannel === 'structured-event';
  const result = fromEvent ? session.structuredOutput : readReviewFile(role.outputPath, options.label);
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    fail(`${options.label} не вернул структурированный результат в виде JSON-объекта.`);
  }
  if (fromEvent) writeFileSync(role.outputPath, JSON.stringify(result), 'utf8');
  return result;
}

function readReviewFile(outputPath, label) {
  try {
    return JSON.parse(readFileSync(outputPath, 'utf8'));
  } catch (cause) {
    if (cause.code === 'ENOENT') throw new Error(`${label} не создал файл результата.`, { cause });
    if (cause instanceof SyntaxError) {
      throw new Error(`${label} вернул некорректный структурированный результат.`, { cause });
    }
    throw cause;
  }
}
