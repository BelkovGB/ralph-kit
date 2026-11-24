import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runFinalChecks } from './ralph-scoped-validation.mjs';

function accept(prd, rules) {
  if (!prd || !rules || process.env.RALPH_AGENT_ROLE || process.env.RALPH_VALIDATION_SCOPE)
    throw new Error('Final acceptance requires a PRD and rules outside the Ralph loop.');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
  const name = git('--literal-pathspecs', 'ls-files', '--error-unmatch', '--', prd);
  if (name !== prd || !prd.endsWith('.md')) throw new Error('Use one tracked, repository-relative PRD path.');
  const sha = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain')) throw new Error('Final acceptance requires a clean integrated commit.');
  const key = createHash('sha256').update(name).digest('hex');
  const runs = resolve(git('rev-parse', '--git-common-dir'), 'ralph-acceptance', key);
  mkdirSync(runs, { recursive: true });
  const run = join(runs, sha);
  const receipt = join(run, 'result.json');
  if (existsSync(receipt)) {
    const result = JSON.parse(readFileSync(receipt, 'utf8'));
    console.log(receipt, result);
    return result.exitCode;
  }
  try { mkdirSync(run); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('An acceptance attempt already started. Inspect the run directory before recovery: ' + run);
  }
  const started = new Date().toISOString();
  let exitCode;
  try { exitCode = runFinalChecks(rules); } catch (error) { console.error(error.message); exitCode = 79; }
  const result = {prd:name, sha, started, finished:new Date().toISOString(), exitCode};
  writeFileSync(receipt + '.tmp', JSON.stringify(result, null, 2));
  renameSync(receipt + '.tmp', receipt);
  console.log(receipt, result);
  return result.exitCode;
}
try { process.exitCode = accept(...process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 79; }
