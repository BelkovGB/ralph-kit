# Ralph validation isolation

## Approved issues

`approved-issues.json` is the tracked approval ledger for explicitly pinned AFK
issue prompts. By default, `autoApproveConfiguredIssues=true` also treats a
committed `phases` plan as approval of the current title/body of issues in those
milestones, provided their author is trusted. Ralph freezes the exact content in
its persistent run state before the agent starts; later GitHub edits therefore
stop the run. Review issues created by Ralph are frozen through the same
mechanism, so an enabled milestone recovery loop can remain unattended. Set the
option to `false` when every issue must be added to the tracked ledger manually.

## Control plane

Ralph only implements product work. `.agents/**`, `scripts/ralph/**`, and every
`AGENTS.md` are manual control-plane paths: milestone reviews do not create
issues for them, queued infrastructure issues are ignored, and the executor
rejects them.

## Command contract

`preflightScripts` and `validationScripts` hold shell commands, not script
names. Each one runs as written from the repository root inside the container,
for example `npm run lint`, `ruff check .`, or `uv run pytest`. A command must be
non-empty, within the length limit, and free of line breaks: the entrypoint
prints it as a marker line that the failure report parses line by line. Nothing
restricts what a command may invoke — the config lives in the control plane, so
an autonomous agent cannot add one.

## Isolation

Before any command runs, Ralph builds `Dockerfile.validation`. The set runs in a
fresh, unprivileged container with no network, no Docker socket, a read-only
image, and a bind mount containing only tracked or non-ignored workspace files.
The entrypoint copies that snapshot into a writable workspace and initializes a
disposable Git repository, so host Git metadata and host credential helpers stay
out of reach.

The image installs nothing project specific. A project adds its dependencies —
and anything a command needs at run time, such as a database or a browser — to
its own `Dockerfile.validation`, where network access is still available.
