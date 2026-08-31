# Project instructions

Replace this first section with the project's own facts and delete the rest of
this paragraph. Name the stack, where each part of the code lives, the exact
commands that build, lint and test it, and the documents that hold the live
contracts. Keep it short: an agent reads this file on every task.

## Ground rules

- Update relevant documentation when changing architecture or public contracts.
- Ralph AFK sessions receive their full contract inside the prompt and must not
  read `.agents/RALPH.md`, which is operator documentation. The orchestrator owns
  complete validation runs.

## Code structure and naming

- Split by reason to change, not by line count: one subject area lives in one
  file and can be read without reading its neighbours. Size is a signal, not a
  target.
- About 300 lines in a file and about 30 lines in a function are the point to
  stop and ask whether the unit has more than one reason to change. Passing
  either number is not a defect on its own, and it is not a licence to split
  into single-method helpers: a reader who opens five files to follow one
  behaviour pays more than the long file cost.
- A name must not promise more than the code delivers. A misleading name is
  worse than a vague one: a vague name makes the reader open the code, a
  misleading one does not.
- One name, one behaviour. Two same-named functions with different output are a
  silent bug waiting for the next person who deduplicates them.
- Name the unit or the scope whenever more than one exists — `validationTimeoutMs`
  per container next to `validationRunTimeoutMs` per run.
- A shared type belongs to the contract module, not to the component that first
  needed it.
- Do not combine a redesign, a behaviour change and a structural extraction in
  one commit. Each is reviewed against a different question, and together they
  hide each other.

## Token efficiency

- Every byte a tool returns stays in the context and is paid for on every later
  request. Before a call, ask what the context already answers and how to make
  the output smaller.
- Start with compact output and expand it only when needed to diagnose a failure.
- Use `git status --short`, `git diff --unified=0`, and `git log --oneline -10`.
- Request only needed GitHub fields, for example
  `gh issue list --limit 100 --json number,title`.
- Show the last few lines of a long build or test log first. Preserve the exit
  code when piping; use `Select-Object -Last 5` in PowerShell and `tail -5` with
  `pipefail` in POSIX.
- Prefer targeted file ranges. Do not dump complete logs, generated files,
  lockfiles, or large JSON documents when a focused query is sufficient.
- Read a file whole when a range would not return fewer lines, when the task is
  to learn how a module is built, or when the user asked for full output.
- Search with the Grep tool rather than a shell `rg`: isolated sessions have no
  `rg`, and the failed command costs a step plus its error output.
- Run repo-wide commands from the repository root. A path resolved against the
  wrong working directory costs a step and reports a misleading "not found".

## Writing instructions and documentation

- Put the rules that apply to every task at the top of the file and the ones
  that apply to a single kind of change below them. Attention falls off down the
  page, and a reader who stops halfway must already hold the rules that change
  the outcome.
- Prioritise by size times read frequency. A line in every issue prompt costs
  more than a page read once a month.
- Duplicate a short fact; link to a long one. A link costs a step plus the whole
  target file.
- Write what to do. Write why only where a rule looks redundant and would be
  optimised away: security boundaries, deliberate duplication, arbitrary-looking
  limits. A prohibition without a reason gets removed.
- Documentation describing code behaviour needs a test or it starts lying. A
  wrong instruction costs more than a missing one.
- Documentation states the current behaviour; the history of changes lives in
  the changelog. A reader who needs today's answer pays for every superseded
  one on the way to it.
- Name the exact path, or the command that finds it. Guessing costs steps.
- Put module instructions in an `AGENTS.md` beside the module, not in a shared
  file, and do not repeat the parent. A new one changes Ralph's trusted set, so
  add it between runs.
