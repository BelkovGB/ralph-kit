# Project instructions

- Monorepo: `apps/web` is Next.js and `apps/api` is NestJS. Run npm workspace
  commands from the repository root.
- The live contract for meeting-file storage is `docs/api.md`, sections
  `## Meeting files` and `## Local upload configuration`. Read
  `docs/research-meetings-upload.md` only when changing the storage architecture
  itself: it records why the design was chosen, not what it does today.
- Shared validation: `npm run format:check`, `npm run lint`, and `npm run build`.
  Tests: `npm run test:e2e:api`, `npm run test:e2e:web`, and `npm run test:ralph`.
- Update relevant documentation when changing architecture or public contracts.
- Ralph AFK sessions receive their full contract inside the prompt and must not
  read `.agents/RALPH.md`, which is operator documentation. The orchestrator owns
  complete validation runs.

## Token efficiency

- Start with compact output and expand it only when needed to diagnose a failure.
- Use `git status --short`, `git diff --unified=0`, and `git log --oneline -10`.
- Request only needed GitHub fields, for example
  `gh issue list --limit 100 --json number,title`.
- Suppress npm wrapper noise with `npm run --silent <script>`.
- For TypeScript diagnostics, use `npx tsc --noEmit --pretty false` and initially
  show only the last five lines. Preserve the compiler exit code when piping;
  use `Select-Object -Last 5` in PowerShell and `tail -5` with `pipefail` in POSIX.
- Prefer targeted file ranges. Do not dump complete logs, generated files,
  lockfiles, or large JSON documents when a focused query is sufficient.
- Search with the Grep tool rather than a shell `rg`: isolated sessions have no
  `rg`, and the failed command costs a step plus its error output.
- Run repo-wide commands from the repository root. A path resolved against the
  wrong working directory costs a step and reports a misleading "not found".
- A non-interactive `claude` run pays for every tool schema in its cached
  prefix. Deny the tools the task cannot use and pass
  `--exclude-dynamic-system-prompt-sections` so per-machine text stays out of
  that prefix: measured here, 43 442 input tokens per session became 25 741, and
  a repeat session reads the cache instead of rewriting it.

## Writing instructions and documentation

- Prioritise by size times read frequency. A line in every issue prompt costs
  more than a page read once a month.
- Duplicate a short fact; link to a long one. A link costs a step plus the whole
  target file.
- Write what to do. Write why only where a rule looks redundant and would be
  optimised away: security boundaries, deliberate duplication, arbitrary-looking
  limits. A prohibition without a reason gets removed.
- Documentation describing code behaviour needs a test or it starts lying. A
  wrong instruction costs more than a missing one.
- Name the exact path, or the command that finds it. Guessing costs steps.
- Put module instructions in an `AGENTS.md` beside the module, not in a shared
  file, and do not repeat the parent. A new one changes Ralph's trusted set, so
  add it between runs.

## Code structure and naming

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
- Size is a signal, not a target. Split where a unit has more than one reason to
  change, so one subject area lives in one file and can be read without reading
  its neighbours. Do not split into single-method helpers: that makes things
  harder to find, not easier.
