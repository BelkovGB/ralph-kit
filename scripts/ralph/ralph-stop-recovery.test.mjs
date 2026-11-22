import assert from 'node:assert/strict';
import test from 'node:test';
import { assertScopedHostCommands } from './ralph-validation-runner.mjs';
import { proposalRetry } from './ralph-supervisor.mjs';
import { routeImages, writesEvidence } from './ralph-route-evidence.mjs';

test('a timeout or incomplete escalation gets one new session; external blockers stop', () => {
  const timeout = { code: 'RALPH_AGENT_IDLE_TIMEOUT' };
  const unfinished = { verdict: 'human', reason: 'work unfinished' };
  for (const [cause, answer] of [[timeout, undefined], [null, unfinished]]) {
    assert.ok(proposalRetry(cause, answer, false));
    assert.equal(proposalRetry(cause, answer, true), null);
  }
  assert.equal(proposalRetry(null, { ...unfinished, operatorAction: 'Restore database access' }, false), null);
  assert.equal(proposalRetry({ code: 'RALPH_STOPPED' }, null, false), null);
});

test('validation refuses an E2E file writing directly to evidence', () => {
  assert.equal(writesEvidence("await page.screenshot({path: '../evidence/run/example.png'})"), true);
  assert.equal(writesEvidence("await page.screenshot({path: info.outputPath('example.png')})"), false);
});

test('publish only passing screenshots for the required route and viewport', () => {
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a','hex').copy(bytes);
  bytes.writeUInt32BE(375,16); bytes.writeUInt32BE(812,20);
  const report = { stats: { expected: 1, unexpected: 0, flaky: 0 }, suites: [{ specs: [{ tests: [{
    status: 'expected', results: [{ status: 'passed', attachments: [{
      name: 'ralph-route:' + JSON.stringify({ route: '/example', width: 375, height: 812 }),
      contentType: 'image/png', body: bytes.toString('base64'),
    }] }],
  }] }] }] };
  assert.equal(routeImages(report, '/example', ['375x812']).size, 1);
  assert.throws(() => routeImages(report, '/fixture', ['375x812']), /Unexpected/);
  assert.throws(() => routeImages(report, '/example', ['375x812','1440x900']), /Missing/);
  assert.throws(() => routeImages({...report,stats:{expected:1,unexpected:1}}, '/example', ['375x812']), /successful/);
});

test('host blocks broad commands in project profiles', () => {
  for (const command of ['npm run check', 'npx playwright test', 'pnpm exec playwright test', 'yarn test:all'])
    assert.throws(() => assertScopedHostCommands([command]), {code:'RALPH_VALIDATION_SCOPE_UNKNOWN'});
  assert.throws(() => assertScopedHostCommands(['do-a','do-b'], ['do-b','do-a']));
  assert.doesNotThrow(() => assertScopedHostCommands(['npx playwright test example.spec.ts']));
});
