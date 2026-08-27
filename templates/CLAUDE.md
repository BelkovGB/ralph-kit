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
- Files the tool writes itself belong to the machine, so `.gitignore` excludes
  `.claude/scheduled_tasks.lock` and `.claude/settings.local.json`. Ralph leaves
  only the lock out of its trusted set; `settings.local.json` stays in it, which
  is why a second Claude Code session during a run stops the run.
- A skill keeps its text in `.agents/skills/<name>/SKILL.md`, where Codex reads
  it, while `.claude/skills/<name>/SKILL.md` holds the frontmatter and a line
  pointing at that text: Claude Code reads its own directory only. The CLI
  substitutes `$ARGUMENTS` in the file it loads, so that placeholder lives in
  the `.claude` file and the `.agents` copy names the argument in words.

Ralph treats `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.agents/**` and
`scripts/ralph/**` as its control plane: an AFK session never edits them. A new
`AGENTS.md`, `CLAUDE.md`, or file under `.claude/` or `.agents/skills/` changes
the trusted set, so add one between runs rather than during one.
