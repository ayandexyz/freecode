# Contributing to FreeCode

Thanks for your interest. The short version of how this repo works:

## The one rule

**All intelligence lives in `apps/core`.** The TUI, VS Code extension, web UI
and desktop app are presentation layers that speak JSON-RPC to it. If a change
puts provider calls, file access, or tool logic in a frontend, it will be asked
to move. Full architecture: [`CLAUDE.md`](CLAUDE.md) and
`docs/specs/2026-05-25-architecture-v4.md`.

## Setup

```bash
pnpm install
pnpm --filter @thisisayande/freecode-shared build   # shared types first
pnpm turbo run check-types
pnpm turbo run test
```

Run from source with `pnpm dev`, or build a distributable binary with
`pnpm build:bun`. Details: https://freecode.website/contributing/development

## Before opening a PR

- `pnpm turbo run lint check-types test` is green.
- Tests live next to the code as `*.test.ts`. Anything that needs a real
  model turn is an eval case in `evals/*.jsonl` instead — read
  [`EVAL.md`](EVAL.md) first, every case is a paid turn.
- Changed the agent's behavior (prompt, tool description, loop)? Run the A/B
  comparison `EVAL.md` prescribes and include the delta in the PR.
- Adding a tool or provider? Follow the checklists at
  https://freecode.website/contributing/adding-a-tool and
  https://freecode.website/contributing/adding-a-provider

## Reporting bugs

Open an issue with the `freecode trace <session-id>` output where possible —
see [`TRACE.md`](TRACE.md). Security issues: see [`SECURITY.md`](SECURITY.md).
