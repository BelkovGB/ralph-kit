import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { printCheck } from './ralph-loop.mjs';

test('inactive CLI diagnoses missing tools without enabling the loop', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-installation-'));
  const source = fileURLToPath(new URL('../..', import.meta.url));
  try {
    cpSync(path.join(source, 'scripts/ralph'), path.join(root, 'scripts/ralph'), { recursive: true });
    mkdirSync(path.join(root, '.agents'));
    mkdirSync(path.join(root, 'docs'));
    writeFileSync(path.join(root, '.agents/RALPH.md'), 'Fixture operator guide.\n');
    // The installed project's paths, skills and account must not affect this fixture.
    const ledger = '{}\n';
    writeFileSync(path.join(root, 'docs/rules.md'), 'Fixture rules.\n');
    writeFileSync(path.join(root, 'docs/approved.json'), ledger);
    const configPath = path.join(root, '.agents/ralph.config.json');
    const config = {
      active: false,
      phases: [{ milestone: 'Fixture phase', branch: 'ralph/fixture' }],
      prompt: 'Implement issue #{issue_number}: {issue_title}',
      rulesFile: 'docs/rules.md',
      approvedIssueSnapshotsFile: 'docs/approved.json',
      approvedIssueSnapshotsHash: createHash('sha256').update(ledger).digest('hex'),
      review: { enabled: false, model: 'fixture-model' },
      milestoneReview: { enabled: false, model: 'fixture-model' },
    };
    writeFileSync(configPath, JSON.stringify(config));
    const before = readFileSync(configPath, 'utf8');
    // No executable tools and no network: diagnostics must reach the tool check,
    // while the disabled mutating modes must still stop before it.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env.PATH = path.join(root, 'no-tools');
    const cli = (...args) => spawnSync(process.execPath, ['scripts/ralph/ralph-loop.mjs', ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 15000,
    });
    for (const args of [[], ['--check']]) {
      const result = cli(...args);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /git/u);
    }
    for (const args of [['--run'], ['--accept-manual-commit', 'a'.repeat(40)]]) {
      const result = cli(...args);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /active=false/u);
    }
    assert.equal(readFileSync(configPath, 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function diagnosticOutput(overrides = {}) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    printCheck({
      active: false, maxIterations: 1, maxTurns: 50, maxTestFixAttempts: 3,
      developmentModel: 'test-model', developmentEffort: 'low',
      rulesFile: '.agents/ralph-rules.md', approvedIssueSnapshotsFile: '.agents/approved-issues.json',
      validationScripts: ['test-command'], stopAfterFirstIssue: false,
      autoApproveConfiguredIssues: false, review: { enabled: false },
      milestoneReview: { enabled: true, model: 'test-model', effort: 'low', maxTurns: 50 },
      ...overrides,
    }, 'owner/repo', { title: 'Phase' }, { currentBranch: 'feature', clean: true },
    [{ number: 1, title: 'First' }, { number: 2, title: 'Second' }]);
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

test('diagnostics distinguish a full phase from a trial and report manual review approval', () => {
  const full = diagnosticOutput();
  assert.match(full, /active=false/u);
  assert.match(full, /ВНИМАНИЕ: бюджета.*меньше.*issues/u);
  assert.match(full, /ВНИМАНИЕ:.*autoApproveConfiguredIssues=false/u);
  assert.match(full, /не запускались/u);
  const trial = diagnosticOutput({ stopAfterFirstIssue: true });
  assert.match(trial, /Пробный режим/u);
  assert.doesNotMatch(trial, /ВНИМАНИЕ: бюджета/u);
  const automatic = diagnosticOutput({ maxIterations: 20, autoApproveConfiguredIssues: true });
  assert.doesNotMatch(automatic, /ВНИМАНИЕ:/u);
});
