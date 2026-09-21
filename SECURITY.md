# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's
private vulnerability reporting on this repository
(Security → Report a vulnerability). You should hear back within a few days.

## Scope

FreeCode is a local coding agent that runs shell commands and edits files on
your machine on a model's instruction. Things we consider in scope:

- Permission-mode bypasses (`plan` / `review` / `explore` executing a mutating
  tool, or an allow/deny rule not being honoured)
- Prompt-injection paths that escalate from file or web content to tool
  execution the user did not approve
- Credential leakage — API keys, OAuth tokens, or memory contents reaching a
  provider, log, trace export, or the graph explorer where they should not
- The graph explorer or web server binding to anything other than `127.0.0.1`

Out of scope: the model doing something unwise in `danger` mode, which
disables the permission layer by design.

## Supported versions

Only the latest release receives fixes.
