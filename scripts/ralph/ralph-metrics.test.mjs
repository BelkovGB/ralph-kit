import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendIssueMetrics,
  beginIssueMetrics,
  currentIssueMetrics,
  finishIssueMetrics,
  formatIssueMetrics,
  recordAgentTelemetry,
  startStage,
  withRecordedTelemetry,
} from './ralph-run-metrics.mjs';

function withMetricsFile(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ralph-metrics-test-'));
  try {
    return run(path.join(directory, 'issue-metrics.json'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Часы задаются списком: замер на реальном Date.now зависел бы от скорости
// диска, и порог пришлось бы ослаблять до бессмысленного.
function clockOf(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test('startStage складывает время повторных прогонов одной стадии', () => {
  withMetricsFile((metricsPath) => {
    beginIssueMetrics({ issue: 7 }, { now: clockOf([0, 100, 400, 1000, 1600, 1600]) });
    startStage('validation')();
    startStage('validation')({ attested: true });
    const record = finishIssueMetrics({ outcome: 'completed' }, { metricsPath });

    assert.equal(record.stages.validation.runs, 2);
    assert.equal(record.stages.validation.ms, 300 + 600);
    assert.equal(record.stages.validation.attested, true);
  });
});

test('завершение стадии идемпотентно: повторный вызов не удваивает время', () => {
  withMetricsFile((metricsPath) => {
    beginIssueMetrics({ issue: 8 }, { now: clockOf([0, 10, 500, 900]) });
    const endStage = startStage('review');
    endStage();
    endStage();
    const record = finishIssueMetrics({ outcome: 'completed' }, { metricsPath });

    assert.equal(record.stages.review.runs, 1);
    assert.equal(record.stages.review.ms, 490);
    assert.equal(record.wallMs, 900);
  });
});

test('totals суммируют только присланные значения и считают, сколько сессий их прислало', () => {
  withMetricsFile((metricsPath) => {
    beginIssueMetrics({ issue: 9 }, { now: clockOf([0, 0]) });
    recordAgentTelemetry('development', {
      turns: 34,
      costUsd: 2.5,
      uncachedInputTokens: 120,
      cacheCreationTokens: 1_000,
      cacheReadTokens: 50_000,
      outputTokens: 40,
    });
    // Codex цену не присылает: сумма обязана остаться суммой известного, а не
    // получить ноль вместо «не сообщено».
    recordAgentTelemetry('review', { turns: 12, uncachedInputTokens: 80, outputTokens: 20 });
    const record = finishIssueMetrics({ outcome: 'completed' }, { metricsPath });

    assert.equal(record.totals.sessions, 2);
    assert.equal(record.totals.costReportedBy, 1);
    assert.equal(record.totals.costUsd, 2.5);
    assert.equal(record.totals.turns, 46);
    // Вход — это все три слагаемых: uncachedInputTokens в одиночку меньше
    // полного входа на порядки.
    assert.equal(record.totals.uncachedInputTokens, 200);
    assert.equal(record.totals.inputTokens, 200 + 1_000 + 50_000);
    assert.equal(record.totals.thinkingTokens, null);
  });
});

test('вход не считается, когда телеметрии нет вовсе', () => {
  withMetricsFile((metricsPath) => {
    beginIssueMetrics({ issue: 11 }, { now: clockOf([0, 0]) });
    recordAgentTelemetry('development', { turns: 5 });
    const record = finishIssueMetrics({ outcome: 'completed' }, { metricsPath });

    assert.equal(record.totals.inputTokens, null);
    assert.equal(record.totals.turns, 5);
  });
});

test('withRecordedTelemetry снимает цену и с упавшей сессии', async () => {
  await withMetricsFile(async (metricsPath) => {
    beginIssueMetrics({ issue: 10 }, { now: clockOf([0, 0]) });
    const failure = new Error('лимит шагов');
    failure.telemetry = { turns: 100, costUsd: 9.75 };

    await assert.rejects(
      withRecordedTelemetry('development', async () => {
        throw failure;
      }),
      /лимит шагов/,
    );
    const record = finishIssueMetrics({ outcome: 'agent-failed' }, { metricsPath });

    assert.deepEqual(record.agents, [{ role: 'development', turns: 100, costUsd: 9.75 }]);
    assert.equal(record.totals.costUsd, 9.75);
  });
});

test('запись вне активной issue ничего не пишет и не бросает', () => {
  recordAgentTelemetry('development', { costUsd: 1 });
  startStage('validation')();

  assert.equal(currentIssueMetrics(), null);
  assert.equal(finishIssueMetrics({ outcome: 'completed' }), null);
});

test('журнал метрик хранится новыми записями вперёд и переживает чужую версию файла', () => {
  withMetricsFile((metricsPath) => {
    appendIssueMetrics({ issue: 1 }, { metricsPath });
    appendIssueMetrics({ issue: 2 }, { metricsPath });
    const stored = JSON.parse(readFileSync(metricsPath, 'utf8'));

    assert.equal(stored.version, 1);
    assert.deepEqual(
      stored.entries.map((entry) => entry.issue),
      [2, 1],
    );
  });
});

test('строка для оператора считает токены, а не деньги', () => {
  const line = formatIssueMetrics({
    issue: 57,
    wallMs: 1_339_000,
    stages: {
      implementation: { ms: 621_000, runs: 1 },
      validation: { ms: 172_000, runs: 1, attested: true },
      review: { ms: 533_000, runs: 1 },
    },
    totals: {
      sessions: 2,
      costReportedBy: 2,
      costUsd: 6.18,
      turns: 88,
      toolResults: 34,
      thinkingTokens: 41_000,
      uncachedInputTokens: 3_199,
      inputTokens: 5_800_762,
      outputTokens: 55_802,
      cacheReadTokens: 5_603_819,
      cacheCreationTokens: 193_744,
    },
    outcome: 'review-failed',
    reason: 'независимое ревью вернуло замечания',
  });

  assert.match(line, /Стоимость issue #57: 22m19s/);
  assert.match(line, /validation 2m52s, из attestation/);
  assert.match(line, /шагов 88, вызовов инструментов 34/);
  // Строка называет только то, что прислал CLI: счётчики по видам обращения.
  // Взвешенной суммы в ней нет — веса пришлось бы подобрать, а подобранное
  // число выглядит как измеренное.
  assert.match(
    line,
    /расход: вход вне кэша 3k, запись кэша 194k, чтение кэша 5\.6M, рассуждения 41k, ответ 15k/,
  );
  assert.doesNotMatch(line, /базовых токенов/);
  // На подписке доллары условны и в строку не идут.
  assert.doesNotMatch(line, /\$/);
  assert.match(line, /независимое ревью вернуло замечания/);
});

test('пропущенный счётчик не превращается в ноль и в строку не идёт', () => {
  // Сессия, убитая лимитом шагов, телеметрию не присылает. Ноль читался бы как
  // измеренный расход, поэтому пропуск остаётся пропуском.
  const line = formatIssueMetrics({
    issue: 59,
    wallMs: 60_000,
    stages: { implementation: { ms: 60_000, runs: 1 } },
    totals: {
      sessions: 1,
      costReportedBy: 1,
      turns: 4,
      toolResults: 1,
      thinkingTokens: null,
      uncachedInputTokens: 120,
      inputTokens: 120,
      outputTokens: 80,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    },
    outcome: 'completed',
    reason: null,
  });

  assert.match(line, /расход: вход вне кэша 120, ответ 80/);
  assert.doesNotMatch(line, /чтение кэша/);
  assert.doesNotMatch(line, /рассуждения/);
});

test('неполная телеметрия помечается числом сессий, а не выдаётся за полную', () => {
  const line = formatIssueMetrics({
    issue: 58,
    wallMs: 60_000,
    stages: { implementation: { ms: 60_000, runs: 1 } },
    totals: {
      sessions: 2,
      costReportedBy: 1,
      costUsd: 1.5,
      turns: 10,
      toolResults: 3,
      thinkingTokens: null,
      uncachedInputTokens: 100,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    },
    outcome: 'completed',
    reason: null,
  });

  assert.match(line, /телеметрию прислали 1\/2/);
  assert.match(line, /расход: вход вне кэша 100, ответ 50/);
});

// Формат сохраняется отдельным тестом: ошибка здесь тихо портит строку, ради
// которой метрики и собирают, а тесты выше проверяют только числа.
test('короткие стадии печатаются в секундах, длинные — в минутах', () => {
  const line = formatIssueMetrics({
    issue: 59,
    wallMs: 45_000,
    stages: { validation: { ms: 8_000, runs: 3 } },
    totals: {
      sessions: 0,
      costReportedBy: 0,
      costUsd: null,
      turns: null,
      toolResults: null,
      thinkingTokens: null,
      uncachedInputTokens: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    },
    outcome: 'validation-failed',
    reason: 'валидация не прошла',
  });

  assert.match(line, /45s — validation 8s ×3/);
  // Ни одной сессии не было: объём печатать нечего, и нулей быть не должно.
  assert.doesNotMatch(line, /вход/);
});
