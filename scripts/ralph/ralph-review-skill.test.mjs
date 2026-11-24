import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('both reviewers use the project template only when its full skill is installed and trusted', async (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'ralph-review-skill-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const scripts = path.join(project, 'scripts', 'ralph');
  cpSync(fileURLToPath(new URL('.', import.meta.url)), scripts, {
    recursive: true,
    filter: (entry) => !entry.endsWith('.test.mjs'),
  });
  const { buildIndependentReviewPrompt, buildMilestoneReviewPrompt } =
    await import(pathToFileURL(path.join(scripts, 'ralph-prompts.mjs')).href);
  const config = { agentCli: 'codex', baseBranch: 'main' };
  function verify(expected) {
    const prompts = [
      buildIndependentReviewPrompt(config, { number: 1, title: 'Change' }, 'abc'),
      buildMilestoneReviewPrompt(config, { title: 'Phase' }, { number: 2, url: 'example' }),
    ];
    for (const prompt of prompts) {
      assert.equal(prompt.includes('.agents/skills/requesting-code-review/SKILL.md'), expected);
      assert.equal(prompt.includes('.agents/skills/requesting-code-review/code-reviewer.md'), expected);
    }
  }

  verify(false);
  const skill = path.join(project, '.agents', 'skills', 'requesting-code-review');
  mkdirSync(skill, { recursive: true });
  const instructions = path.join(skill, 'SKILL.md');
  const template = path.join(skill, 'code-reviewer.md');
  writeFileSync(instructions, 'Review the change.');
  verify(false);
  writeFileSync(template, 'Review checklist');
  verify(true);
  config.trustedControlFileHashes = new Map([[instructions, 'test']]);
  verify(false);
  config.trustedControlFileHashes.set(template, 'test');
  verify(true);
});
