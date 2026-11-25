import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validationScriptsFor } from './ralph-process-packs.mjs';
import { withPatchedRalphConfig } from './ralph-test-support.mjs';

const config = {
  validationScripts: ['check'], browserValidationScripts: ['browser'], browserValidationPaths: ['web/', 'contracts/public.json'],
  approvedIssueSnapshots: { 9: { body: '<!-- ralph-process: ui-change -->\n' } }, review: { enabled: true },
};

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-browser-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const write = (name, content) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  };
  git('init', '-q');
  git('config', 'user.name', 'Ralph Test');
  git('config', 'user.email', 'ralph@example.test');
  write('web/view.js', 'initial\n');
  write('api/model.js', 'initial\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const options = { baseCommit: git('rev-parse', 'HEAD').trim(), run: (_name, args) => ({ stdout: git(...args), status: 0 }) };
  return { write, git, options };
}

function expectScopes(options, expected) {
  for (const scope of ['issue', 'phase', 'baseSync']) assert.deepEqual(validationScriptsFor(config, scope, 1, options), expected);
}

test('backend, database and similar filenames omit browser commands, while a declared UI issue retains them', t => {
  const { write, options } = fixture(t);
  write('api/model.js', 'updated\n');
  write('db/schema.sql', 'new\n');
  write('web-old/view.js', 'new\n');
  write('contracts/public.json.bak', 'new\n');
  expectScopes(options, ['check']);
  assert.deepEqual(validationScriptsFor(config, 'issue', 9, options), ['check', 'browser']);
  write('contracts/public.json', '{}');
  expectScopes(options, ['check', 'browser']);
});

test('browser selection sees staged, committed, deleted and renamed UI files', t => {
  const { write, git, options } = fixture(t);
  write('web/view.js', 'changed\n');
  git('add', 'web/view.js');
  write('web/view.js', 'initial\n');
  expectScopes(options, ['check', 'browser']);
  git('commit', '-qm', 'stage UI');
  git('add', 'web/view.js');
  expectScopes(options, ['check', 'browser']);
  options.baseCommit = git('rev-parse', 'HEAD').trim();
  git('mv', 'web/view.js', 'api/moved.js');
  expectScopes(options, ['check', 'browser']);
});

test('legacy projects keep their existing selection, and an uncertain diff includes browser checks', () => {
  const legacy = { ...config };
  delete legacy.browserValidationPaths;
  assert.deepEqual(validationScriptsFor(legacy, 'phase', 1), ['check', 'browser']);
  assert.deepEqual(validationScriptsFor(legacy, 'baseSync', 1), ['check']);
  assert.deepEqual(validationScriptsFor(legacy, 'issue', 1), ['check']);
  assert.deepEqual(validationScriptsFor(legacy, 'issue', 9), ['check', 'browser']);
  expectScopes({}, ['check', 'browser']);
  expectScopes({ baseCommit: 'a'.repeat(40), run() { throw Error('unavailable'); } }, ['check', 'browser']);
});

test('the project browser map accepts only concrete relative files and directory prefixes', () => {
  withPatchedRalphConfig({ browserValidationScripts: ['check-ui'], browserValidationPaths: config.browserValidationPaths },
    validated => assert.deepEqual(validated.browserValidationPaths, config.browserValidationPaths));
  for (const value of [[], ['../ui/'], ['C:/ui/'], ['/ui/'], ['web/**'], ['.git/config'], ['a\\b'], [null]]) {
    assert.throws(() => withPatchedRalphConfig({ browserValidationScripts: ['check-ui'], browserValidationPaths: value }, () => {}),
      /browserValidationPaths/);
  }
});
