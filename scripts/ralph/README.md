# Ralph validation isolation

`approved-issues.json` is the tracked approval ledger for explicitly pinned AFK
issue prompts. By default, `autoApproveConfiguredIssues=true` also treats a
committed `phases` plan as approval of the current title/body of issues in those
milestones, provided their author is trusted. Ralph freezes the exact content in
its persistent run state before Codex starts; later GitHub edits therefore stop
the run. Review issues created by Ralph are frozen through the same mechanism, so
an enabled milestone recovery loop can remain unattended. Set the option to
`false` when every issue must be added to the tracked ledger manually.

Ralph only implements product work. `.agents/**`, `scripts/ralph/**`, and every
`AGENTS.md` are manual control-plane paths: milestone reviews do not create issues
for them, queued infrastructure issues are ignored, and the executor rejects them.

Before any npm preflight or validation script, Ralph builds
`Dockerfile.validation`. Each script runs in a fresh, unprivileged container with
no network, no Docker socket, a read-only image, and a bind mount containing only
tracked or non-ignored workspace files. The container starts an ephemeral local
PostgreSQL instance and uses `.env.example`, so host `.env` secrets and host
credential helpers are never available to generated scripts.

The dependency image generates Prisma Client while network access is available
and then proves that client regeneration and migrations succeed with networking
disabled. Runtime validations mount the reviewed source snapshot, initialize a
disposable Git repository without host metadata or credentials, reuse the pinned
client and Linux engine, and build both workspaces without downloading
binaries from mutable product scripts. Web E2E runs in Playwright CI mode with
one worker and retries so the constrained container does not overload the Next.js
development server.
