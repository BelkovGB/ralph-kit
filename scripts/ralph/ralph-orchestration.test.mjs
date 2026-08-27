import assert from 'node:assert/strict';
import test from 'node:test';

import { executeMode, iterationBudget, printCheck, runContinuousLoop } from './ralph-loop.mjs';
import { runCodexWithTurnLimit } from './ralph-codex-session.mjs';
import { run } from './ralph-process-runner.mjs';
import { actions, context, withFakeCodex } from './ralph-test-support.mjs';

function persistentState({ iterationsUsed = 0, issue = null } = {}) {
  let used = iterationsUsed;
  let currentIssue = issue;

  return {
    get iterationsUsed() {
      return used;
    },
    get issue() {
      return currentIssue;
    },
    reserveIteration() {
      used += 1;
      return used;
    },
    releaseIteration() {
      used = Math.max(0, used - 1);
      return used;
    },
    clearIssue() {
      currentIssue = null;
    },
    finish() {
      currentIssue = null;
    },
  };
}

test('sync command runner enforces its wall-clock timeout', { concurrency: false }, () => {
  const timeoutMs = 100;
  const startedAt = Date.now();

  assert.throws(
    () => run('node', ['-e', 'setInterval(() => {}, 1_000)'], { timeoutMs }),
    (error) => {
      assert.equal(error.code, 'RALPH_COMMAND_TIMEOUT');
      assert.equal(error.timeoutMs, timeoutMs);
      assert.match(error.message, /wall-clock timeout 100 ms/);
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 5_000, 'hung command must be terminated promptly');
});

test(
  'Codex circuit breaker stops a fake process after maxTurns unique steps',
  { concurrency: false },
  async () => {
    const fakeSource = `
const events = [
  { type: "item.completed", item: { id: "step-1", type: "agent_message", text: "first" } },
  { type: "item.completed", item: { id: "step-2", type: "command_execution", aggregated_output: "second" } },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
setInterval(() => {}, 1_000);
`;

    await withFakeCodex(fakeSource, async () => {
      await assert.rejects(
        runCodexWithTurnLimit(['exec', '--json', '-'], {
          input: 'test prompt',
          label: 'Fake Codex',
          maxTurns: 1,
          timeoutMs: 5_000,
          authenticationFile: null,
        }),
        (error) => {
          assert.equal(error.code, 'RALPH_MAX_TURNS');
          assert.equal(error.turns, 1);
          assert.match(error.message, /maxTurns=1/);
          return true;
        },
      );
    });
  },
);

test(
  'Codex wall timeout stops a hung fake process independently of maxTurns',
  { concurrency: false },
  async () => {
    const fakeSource = 'setInterval(() => {}, 1_000);\n';
    const timeoutMs = 100;
    const startedAt = Date.now();

    await withFakeCodex(fakeSource, async () => {
      await assert.rejects(
        runCodexWithTurnLimit(['exec', '--json', '-'], {
          input: 'test prompt',
          label: 'Hung fake Codex',
          maxTurns: 50,
          timeoutMs,
          authenticationFile: null,
        }),
        (error) => {
          assert.equal(error.code, 'RALPH_AGENT_TIMEOUT');
          assert.equal(error.timeoutMs, timeoutMs);
          assert.equal(error.turns, 0);
          assert.match(error.message, /wall-clock timeout 100 ms/);
          return true;
        },
      );
    });

    assert.ok(Date.now() - startedAt < 5_000, 'hung Codex must be terminated promptly');
  },
);

test('Codex 401 is classified as an authentication infrastructure failure', async () => {
  await withFakeCodex(
    `
process.stderr.write('401 Unauthorized: Missing bearer or basic authentication');
process.exit(1);
`,
    async () => {
      await assert.rejects(
        runCodexWithTurnLimit(['exec', '--json', '-'], {
          input: 'test prompt',
          label: 'Unauthorized fake Codex',
          maxTurns: 5,
          timeoutMs: 5_000,
          authenticationFile: null,
        }),
        (error) => {
          assert.equal(error.code, 'RALPH_AGENT_AUTH');
          assert.match(error.message, /401 Unauthorized/);
          return true;
        },
      );
    },
  );
});

test('--check reports state without running an issue or creating a PR', async () => {
  const calls = [];
  const result = await executeMode(
    context({ mode: '--check' }),
    actions({
      openIssues: () => [{ number: 1 }],
      printCheck: () => calls.push('check'),
      runPreflight: () => calls.push('preflight'),
      runAgentOnIssue: async () => calls.push('codex'),
      createPullRequest: () => calls.push('pr'),
    }),
  );

  assert.deepEqual(result, {
    mode: 'check',
    issues: 1,
    iterationBudget: { used: 0, limit: 5, remaining: 5 },
  });
  assert.deepEqual(calls, ['check']);
});

test('--check reports the stored iteration budget, not only the configured limit', async () => {
  let reported = null;
  const result = await executeMode(
    context({ mode: '--check', stateStore: { iterationsUsed: 3 } }),
    actions({
      openIssues: () => [{ number: 1 }],
      printCheck: (...args) => {
        reported = args[5];
      },
    }),
  );

  assert.deepEqual(result.iterationBudget, { used: 3, limit: 5, remaining: 2 });
  assert.deepEqual(reported, { used: 3, limit: 5, remaining: 2 });
});

test('iterationBudget clamps an over-spent state to zero remaining', () => {
  assert.deepEqual(iterationBudget({ maxIterations: 5 }, { iterationsUsed: 9 }), {
    used: 9,
    limit: 5,
    remaining: 0,
  });
  assert.deepEqual(iterationBudget({ maxIterations: 5 }, null), {
    used: 0,
    limit: 5,
    remaining: 5,
  });
});

test('printCheck warns and suggests a config change when the budget is exhausted', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (message) => lines.push(String(message));
  try {
    printCheck(
      {
        maxIterations: 40,
        maxTurns: 120,
        maxTestFixAttempts: 3,
        developmentModel: 'gpt-5.6',
        rulesFile: '.agents/ralph-rules.md',
        review: { enabled: true, model: 'gpt-5.6' },
        milestoneReview: { enabled: false },
      },
      'owner/repository',
      { title: 'Test milestone' },
      { currentBranch: 'feature/test', clean: true },
      [],
      { used: 40, limit: 40, remaining: 0 },
    );
  } finally {
    console.log = originalLog;
  }

  const output = lines.join('\n');
  assert.match(output, /Итерации: использовано 40\/40, осталось 0/);
  assert.match(output, /ВНИМАНИЕ: сохранённый бюджет итераций исчерпан \(40\/40\)/);
  assert.match(output, /увеличьте "maxIterations"/);
  assert.match(output, /ralph\.config\.json/);
  assert.equal(/Лимит итераций/.test(output), false);
});

test('printCheck stays quiet about the budget while iterations remain', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (message) => lines.push(String(message));
  try {
    printCheck(
      {
        maxIterations: 40,
        maxTurns: 120,
        maxTestFixAttempts: 3,
        developmentModel: 'gpt-5.6',
        rulesFile: '.agents/ralph-rules.md',
        review: { enabled: false },
        milestoneReview: { enabled: false },
      },
      'owner/repository',
      { title: 'Test milestone' },
      { currentBranch: 'feature/test', clean: true },
      [{ number: 12, title: 'Next issue' }],
      { used: 39, limit: 40, remaining: 1 },
    );
  } finally {
    console.log = originalLog;
  }

  const output = lines.join('\n');
  assert.match(output, /Итерации: использовано 39\/40, осталось 1/);
  assert.equal(/ВНИМАНИЕ/.test(output), false);
});

test('stopAfterFirstIssue runs preflight before reading and implementing an issue', async () => {
  const calls = [];

  const result = await executeMode(
    context({ config: { stopAfterFirstIssue: true } }),
    actions({
      runPreflight: () => calls.push('preflight'),
      openIssues: () => {
        calls.push('issues');
        return [{ number: 11 }];
      },
      runAgentOnIssue: async () => {
        calls.push('codex');
        return { completed: true };
      },
    }),
  );

  assert.deepEqual(result, { mode: 'run', completed: 1 });
  assert.deepEqual(calls, ['preflight', 'issues', 'codex']);
});

test('--run runs preflight once before starting the continuous loop', async () => {
  const calls = [];

  const result = await executeMode(
    context(),
    actions({
      runPreflight: () => calls.push('preflight'),
      openIssues: () => {
        calls.push('issues');
        return [];
      },
      createPullRequest: () => {
        calls.push('pr');
        return { number: 10, headRefOid: 'head-1' };
      },
      runMilestoneReview: async () => {
        calls.push('review');
        return { verdict: 'pass', summary: 'ok', findings: [] };
      },
      verifyReviewedPullRequestHead: () => calls.push('verify-head'),
      closeMilestone: () => calls.push('close'),
    }),
  );

  assert.equal(result.verdict, 'pass');
  assert.deepEqual(calls, [
    'preflight',
    'issues',
    'pr',
    'review',
    'issues',
    'verify-head',
    'close',
  ]);
});

test('a failed preflight prevents --run from reading or changing GitHub state', async () => {
  const calls = [];

  await assert.rejects(
    executeMode(
      context(),
      actions({
        runPreflight: () => {
          calls.push('preflight');
          throw new Error('database is unavailable');
        },
        openIssues: () => calls.push('issues'),
        runAgentOnIssue: async () => calls.push('codex'),
        createPullRequest: () => calls.push('pr'),
      }),
    ),
    /database is unavailable/,
  );

  assert.deepEqual(calls, ['preflight']);
});

test('stopAfterFirstIssue completes exactly one open issue', async () => {
  const completed = [];
  const result = await executeMode(
    context({ config: { stopAfterFirstIssue: true } }),
    actions({
      openIssues: () => [{ number: 11 }, { number: 12 }],
      runAgentOnIssue: async (_config, _repository, issue) => {
        completed.push(issue.number);
        return { completed: true };
      },
    }),
  );

  assert.deepEqual(result, { mode: 'run', completed: 1 });
  assert.deepEqual(completed, [11]);
});

test('stopAfterFirstIssue exits cleanly when no issue is open', async () => {
  let codexRuns = 0;
  const result = await executeMode(
    context({ config: { stopAfterFirstIssue: true } }),
    actions({ runAgentOnIssue: async () => (codexRuns += 1) }),
  );

  assert.deepEqual(result, { mode: 'run', completed: 0 });
  assert.equal(codexRuns, 0);
});

test('stopAfterFirstIssue reports an issue-level review failure without claiming completion', async () => {
  const result = await executeMode(
    context({ config: { stopAfterFirstIssue: true } }),
    actions({
      openIssues: () => [{ number: 11 }],
      runAgentOnIssue: async () => ({ completed: false }),
    }),
  );

  assert.deepEqual(result, { mode: 'run', completed: 0, reviewFailed: true });
});

test('continuous loop does not spend a development iteration for a linked commit', async () => {
  const commit = 'e'.repeat(40);
  let open = true;
  let receivedIssue;
  const stateStore = persistentState();

  const result = await runContinuousLoop(
    context({ stateStore }),
    actions({
      openIssues: () =>
        open
          ? [
              {
                number: 64,
                title: 'Already implemented',
                updatedAt: '2026-08-14T09:31:03Z',
              },
            ]
          : [],
      linkedCommitForIssue: () => commit,
      runAgentOnIssue: async (_config, _repository, issue) => {
        receivedIssue = issue;
        open = false;
        return { completed: true };
      },
    }),
  );

  assert.equal(receivedIssue.linkedCommit, commit);
  assert.equal(result.iterations, 0);
  assert.equal(stateStore.iterationsUsed, 0);
});

test('continuous loop fixes new review issues even while GitHub list remains stale', async () => {
  let reviewRuns = 0;
  const completed = [];
  const pullRequests = [];
  const testActions = actions({
    openIssues: () => [],
    createPullRequest: () => {
      const pullRequest = { number: 61, headRefOid: `head-${completed.length}` };
      pullRequests.push(pullRequest.headRefOid);
      return pullRequest;
    },
    runMilestoneReview: async () => {
      reviewRuns += 1;
      if (reviewRuns === 1) {
        return {
          verdict: 'fail',
          summary: 'two findings',
          findings: [{ title: 'first' }, { title: 'second' }],
        };
      }
      return { verdict: 'pass', summary: 'clean', findings: [] };
    },
    createOrReopenReviewIssues: (_config, _repository, _milestone, _pr, review) => {
      return review.findings.map((finding, index) => ({
        number: 101 + index,
        title: finding.title,
      }));
    },
    runAgentOnIssue: async (_config, _repository, issue) => {
      completed.push(issue.number);
      return { completed: true };
    },
  });

  const result = await runContinuousLoop(context(), testActions);

  assert.equal(result.verdict, 'pass');
  assert.equal(result.iterations, 2);
  assert.deepEqual(completed, [101, 102]);
  assert.deepEqual(pullRequests, ['head-0', 'head-2']);
  assert.equal(reviewRuns, 2);
});

test('continuous loop closes the milestone only after a clean PASS review', async () => {
  let milestoneCloses = 0;

  const result = await runContinuousLoop(
    context(),
    actions({
      closeMilestone: () => {
        milestoneCloses += 1;
      },
    }),
  );

  assert.equal(result.verdict, 'pass');
  assert.equal(milestoneCloses, 1);
});

test('continuous loop treats PASS with findings as recovery work', async () => {
  let reviewRuns = 0;
  const completed = [];

  const result = await runContinuousLoop(
    context(),
    actions({
      openIssues: () => [],
      runMilestoneReview: async () => {
        reviewRuns += 1;
        return reviewRuns === 1
          ? { verdict: 'pass', summary: 'inconsistent', findings: [{ title: 'still broken' }] }
          : { verdict: 'pass', summary: 'clean', findings: [] };
      },
      createOrReopenReviewIssues: () => [{ number: 201, title: 'still broken' }],
      runAgentOnIssue: async (_config, _repository, issue) => {
        completed.push(issue.number);
        return { completed: true };
      },
    }),
  );

  assert.equal(result.verdict, 'pass');
  assert.deepEqual(completed, [201]);
  assert.equal(reviewRuns, 2);
});

test('continuous loop stops when the shared issue iteration budget is exhausted', async () => {
  let open = [{ number: 1 }, { number: 2 }];
  const limitedContext = context({
    config: { branch: 'feature/test', milestone: 'Test milestone', maxIterations: 1 },
  });

  await assert.rejects(
    runContinuousLoop(
      limitedContext,
      actions({
        openIssues: () => [...open],
        runAgentOnIssue: async (_config, _repository, issue) => {
          open = open.filter((candidate) => candidate.number !== issue.number);
        },
      }),
    ),
    /Достигнут лимит 1 итераций/,
  );
});

test('continuous loop does not reset an iteration budget restored from persistent state', async () => {
  const stateStore = persistentState({ iterationsUsed: 1 });
  let codexRuns = 0;

  await assert.rejects(
    runContinuousLoop(
      context({
        config: { branch: 'feature/test', milestone: 'Test milestone', maxIterations: 1 },
        stateStore,
      }),
      actions({
        openIssues: () => [{ number: 8, title: 'Still open' }],
        runAgentOnIssue: async () => {
          codexRuns += 1;
          return { completed: true };
        },
      }),
    ),
    /Достигнут лимит 1 итераций/,
  );

  assert.equal(stateStore.iterationsUsed, 1);
  assert.equal(codexRuns, 0);
});

test('continuous loop stops immediately and refunds an iteration on Codex authentication failure', async () => {
  const stateStore = persistentState();
  let codexRuns = 0;
  const authenticationError = new Error('401 Unauthorized');
  authenticationError.code = 'RALPH_AGENT_AUTH';

  await assert.rejects(
    runContinuousLoop(
      context({ stateStore }),
      actions({
        openIssues: () => [{ number: 67, title: 'Product issue' }],
        runAgentOnIssue: async () => {
          codexRuns += 1;
          throw authenticationError;
        },
      }),
    ),
    (error) => error.code === 'RALPH_AGENT_AUTH',
  );

  assert.equal(codexRuns, 1);
  assert.equal(stateStore.iterationsUsed, 0);
});

test('continuous loop refunds an iteration when the agent cannot write the workspace', async () => {
  const stateStore = persistentState();
  const writeError = new Error('workspace is read-only');
  writeError.code = 'RALPH_AGENT_WRITE_ACCESS';

  await assert.rejects(
    runContinuousLoop(
      context({ stateStore }),
      actions({
        openIssues: () => [{ number: 67, title: 'Product issue' }],
        runAgentOnIssue: async () => {
          throw writeError;
        },
      }),
    ),
    (error) => error.code === 'RALPH_AGENT_WRITE_ACCESS',
  );

  assert.equal(stateStore.iterationsUsed, 0);
});

test('continuous loop refunds an iteration when issue approval fails before development', async () => {
  const stateStore = persistentState();
  const approvalError = new Error('missing immutable snapshot');
  approvalError.code = 'RALPH_UNTRUSTED_ISSUE';

  await assert.rejects(
    runContinuousLoop(
      context({ stateStore }),
      actions({
        openIssues: () => [{ number: 26, title: 'Unapproved product issue' }],
        runAgentOnIssue: async () => {
          throw approvalError;
        },
      }),
    ),
    (error) => error.code === 'RALPH_UNTRUSTED_ISSUE',
  );

  assert.equal(stateStore.iterationsUsed, 0);
});

test('once mode refunds an iteration when issue approval fails before development', async () => {
  const stateStore = persistentState();
  const approvalError = new Error('missing immutable snapshot');
  approvalError.code = 'RALPH_UNTRUSTED_ISSUE';

  await assert.rejects(
    executeMode(
      context({ config: { stopAfterFirstIssue: true }, stateStore }),
      actions({
        openIssues: () => [{ number: 26, title: 'Unapproved product issue' }],
        runAgentOnIssue: async () => {
          throw approvalError;
        },
      }),
    ),
    (error) => error.code === 'RALPH_UNTRUSTED_ISSUE',
  );

  assert.equal(stateStore.iterationsUsed, 0);
});

test('continuous loop prioritizes a persisted recovery issue over a lower issue number', async () => {
  const stateStore = persistentState({
    issue: {
      number: 20,
      title: 'Resume interrupted work',
      url: 'https://example.test/issues/20',
      phase: 'working-tree',
    },
  });
  let visibleIssues = [
    { number: 2, title: 'Lower number' },
    { number: 20, title: 'Resume interrupted work' },
  ];
  const completed = [];

  const result = await runContinuousLoop(
    context({ stateStore }),
    actions({
      openIssues: () => [...visibleIssues],
      runAgentOnIssue: async (_config, _repository, issue) => {
        completed.push(issue.number);
        visibleIssues = visibleIssues.filter((candidate) => candidate.number !== issue.number);
        if (issue.number === 20) stateStore.clearIssue();
        return { completed: true };
      },
    }),
  );

  assert.equal(result.verdict, 'pass');
  assert.deepEqual(completed, [20, 2]);
  assert.equal(result.iterations, 2);
});

test('continuous loop retries the same issue after an issue-level review finding', async () => {
  let open = [{ number: 8 }];
  let attempts = 0;

  const result = await runContinuousLoop(
    context(),
    actions({
      openIssues: () => [...open],
      runAgentOnIssue: async () => {
        attempts += 1;
        if (attempts === 2) {
          open = [];
          return { completed: true };
        }
        return { completed: false };
      },
    }),
  );

  assert.equal(result.verdict, 'pass');
  assert.equal(result.iterations, 2);
  assert.equal(attempts, 2);
});

test('continuous loop keeps fresh retry context and ignores a stale completed issue', async () => {
  const seenBodies = [];
  const staleIssue = { number: 8, title: 'Retry me', body: 'stale body' };
  let attempts = 0;

  const result = await runContinuousLoop(
    context(),
    actions({
      // Имитируем eventual consistency: GitHub продолжает возвращать старый объект
      // даже после обновления body и закрытия issue.
      openIssues: () => [{ ...staleIssue }],
      runAgentOnIssue: async (_config, _repository, issue) => {
        attempts += 1;
        seenBodies.push(issue.body);
        if (attempts === 1) {
          issue.body = 'fresh review context';
          return { completed: false };
        }
        return { completed: true };
      },
    }),
  );

  assert.equal(result.verdict, 'pass');
  assert.equal(result.iterations, 2);
  assert.deepEqual(seenBodies, ['stale body', 'fresh review context']);
});

test('continuous loop processes an issue that was genuinely reopened', async () => {
  const issue = { number: 8, title: 'Reopened', body: 'requirements' };
  let codexRuns = 0;
  let visible = true;

  const result = await runContinuousLoop(
    context(),
    actions({
      openIssues: () => (visible ? [{ ...issue }] : []),
      issueState: () => 'OPEN',
      runAgentOnIssue: async () => {
        codexRuns += 1;
        // После первого закрытия GitHub возвращает эту issue как действительно
        // переоткрытую; после второй реализации она исчезает из списка.
        if (codexRuns === 2) {
          visible = false;
        }
        return { completed: true };
      },
    }),
  );

  assert.equal(result.verdict, 'pass');
  assert.equal(result.iterations, 2);
  assert.equal(codexRuns, 2);
});

test('continuous loop rejects FAIL without queued recovery issues', async () => {
  let milestoneCloses = 0;

  await assert.rejects(
    runContinuousLoop(
      context(),
      actions({
        closeMilestone: () => {
          milestoneCloses += 1;
        },
        runMilestoneReview: async () => ({
          verdict: 'fail',
          summary: 'invalid empty recovery',
          findings: [],
        }),
      }),
    ),
    /ни одной issue исправления не создано/,
  );

  assert.equal(milestoneCloses, 0);
});

test('отложенная issue уходит из очереди прогона и не съедает бюджет целиком', async () => {
  // Issue, работу по которой ревью отклоняет раз за разом, без этого выбирает
  // весь бюджет фазы: число замечаний скачет и до нуля не доходит.
  const attempts = [];
  const stateStore = persistentState();

  await runContinuousLoop(
    context({ stateStore, config: { maxIterations: 20 } }),
    actions({
      openIssues: () => [{ number: 84, title: 'Отклоняется всегда' }],
      runAgentOnIssue: async (_config, _repository, issue) => {
        attempts.push(issue.number);
        // Третий отказ подряд помечает issue отложенной.
        return attempts.length >= 3 ? { completed: false, parked: true } : { completed: false };
      },
    }),
  );

  // Три захода, а не двадцать: остаток бюджета остался нетронутым.
  assert.equal(attempts.length, 3);
  assert.ok(stateStore.iterationsUsed < 20, 'бюджет не должен быть исчерпан');
});

test('milestone не закрывается, пока есть отложенная issue', async () => {
  // Отложенная issue выпадает из очереди по построению, поэтому без отдельной
  // проверки цикл доходит до закрытия milestone и падает там: closeMilestone
  // перечитывает issues без этого фильтра.
  const attempts = [];
  let closed = false;
  const stateStore = persistentState();

  const result = await runContinuousLoop(
    context({ stateStore, config: { maxIterations: 20, maxReviewFixAttempts: 3 } }),
    actions({
      openIssues: () => [{ number: 97, title: 'Отклоняется всегда' }],
      runAgentOnIssue: async () => {
        attempts.push(1);
        return attempts.length >= 3 ? { completed: false, parked: true } : { completed: false };
      },
      runMilestoneReview: async () => ({ verdict: 'pass', summary: 'clean', findings: [] }),
      closeMilestone: () => {
        closed = true;
      },
    }),
  );

  assert.equal(attempts.length, 3);
  assert.equal(closed, false, 'milestone не должен закрываться с незавершённой задачей');
  assert.equal(result.verdict, 'parked');
  assert.deepEqual(result.parkedIssues, [97]);
});
