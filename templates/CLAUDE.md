# Project instructions for Claude Code

The instructions themselves live in `AGENTS.md` and are imported below, so Codex
and Claude Code read one source and it cannot drift between them. Put a new
project rule there, not here; this file holds only what is true of Claude Code
and of nothing else.

@AGENTS.md

## What lives in `.claude/`

- `.claude/agents/**` is versioned: a subagent decides how and what gets
  reviewed, so changing one changes the result and belongs in history.
- Skills written for this project are versioned too, for the same reason and
  because nothing else holds a copy. A subagent that reads an optional skill or
  rules file must say so and stay usable when it is absent, as
  `security-reviewer` does.
- Files the tool writes itself — the scheduler lock, local permissions — belong
  to the machine and are ignored.
- Skills live under `.claude/skills/`, which is where Claude Code looks;
  `.agents/skills/` is the Codex convention.

Ralph treats `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.agents/**` and
`scripts/ralph/**` as its control plane: an AFK session never edits them, and a
new instruction file changes the trusted set, so add one between runs rather
than during one.
