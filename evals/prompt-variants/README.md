# Prompt variants

Candidate system prompts for `freecode eval ab`. A file here is applied per
side with `env:FREECODE_APPEND_SYSTEM_FILE=<path>` (an append, after the
user's own `APPEND_SYSTEM.md`) or `env:FREECODE_SYSTEM_FILE=<path>` (a full
replacement of the shipped prompt, for an edit that has to *retract* a rule);
both are read every turn by `session/prompt.ts`. Nothing in this
directory ships: a variant that wins is folded into
`apps/core/src/session/prompt/system.md` and its ledger entry in
`experiments.jsonl` marked `kept`; one that loses stays here with `rejected`.

| File | Hypothesis | Ledger |
| --- | --- | --- |
| `todo-threshold.md` (replacement) | §Planning rewritten to the Claude Code / opencode rule — 3+ distinct steps, never for one task, look before you plan. The shipped "non-trivial… or ambiguous; write the plan first, before exploring" makes a list for nearly every request, and speculative items are what is left open when the model stops (09-12→20 fold: 65 sessions with a list, 51 pokes, 10 drained). | `2026-09-20-trajectory-2` / `2026-09-20-coding-1` — **rejected**: threshold change cost nothing, but "look before you plan" added reads (+7.6% tokens ex-outliers) and regressed `ask-when-the-answer-is-off-repo`; coding neutral |
| `batch-reads.md` (append) | Rollout fold 2026-09-16→20 (873 sessions): 61% of responses carry one tool call and 264 of 2810 turns were serial read-only chains a single batch would have avoided. A pointed nudge cuts turns without costing pass rate. | `2026-09-20-trajectory-1` — **rejected**: turns 240→239, tokens +2.8% on MiniMax-M3; batching unchanged |
