# Memory efficiency: measure it, prove it, fix what the proof finds

**Date:** 2026-09-25 (rescoped same day)
**Status:** P0 complete · §4 injection bench built and its findings fixed 2026-09-25 (12/12 scenarios) · §6 paired eval next
**Audit baseline:** `f7c83321`
**Goal:** Know, with evidence, whether automatic memory makes the agent better or cheaper, and by how much, backed by free tests, a free local bench, and a paid paired eval.

> **Rescoped 2026-09-25.** Earlier drafts also covered a graph-explorer
> redesign, an explorer "why was this injected" view, and open-ended tuning.
> None of that measures or improves memory quality; the explorer is
> presentation. It moved to `ROADMAP.md` ("Memory graph explorer"). The file
> name is kept so existing links resolve.

## 1. The question

Memory is not free. Local retrieval costs no model tokens, but the injected
block rides every provider request, and the judge, extraction, and
consolidation are real model calls. Memory earns its cost only if it avoids
enough re-explanation, re-investigation, mistakes, or turns, or materially
improves the outcome.

Three questions, answered in this order:

1. **Does the model receive the right memories?** Free, local, deterministic (§4).
2. **Does receiving them change task outcomes and cost?** Paid, paired (§6).
3. **Does learning across sessions pay back its own cost?** Paid, multi-session (§7).

```text
runtime cost with memory = main agent + judge + extraction/flush + consolidation
net savings              = runtime cost without memory − runtime cost with memory
```

Injected tokens are already inside main-agent input usage and are never added
again. Background calls count even when they finish after the answer. Unknown
cost never produces a savings verdict (P0 made that mechanical).

## 2. Contracts

- [Architecture v4](2026-05-25-architecture-v4.md): logic in core; frontends render.
- [Memory system reference](../MEMORY_SYSTEM.md), [graph](2026-07-26-memory-knowledge-graph.md), [write path](2026-08-09-memory-write-path.md), [consolidation + judge + recall bench](2026-08-23-memory-consolidation.md).
- [Observability](2026-08-10-agent-observability.md), [`EVAL.md`](../../EVAL.md), [`TRACE.md`](../../TRACE.md).

Invariants: markdown is the source of truth and `.graph/` is rebuildable;
memories ride the ephemeral tail after the cache anchors, never the static
prefix; memory bodies, queries, paths, and names never enter exported
telemetry; free regression checks never become mandatory paid calls; a default
changes only with paired evidence.

## 3. Plan

| # | Work | Deliverable | Cost to run | State |
| - | ---- | ----------- | ----------- | ----- |
| P0 | Measure the whole bill; strict rendering | §5 | free | ✅ done 2026-09-25 |
| P1 | Injection bench | `pnpm bench:inject`: rendered recall, wasted bytes, lifecycle scenarios | free | ✅ built 2026-09-25 |
| P1 | Correctness fixes | one fix per failing bench scenario, each with a regression test | free | ✅ done 2026-09-25 |
| P1 | Recall-off switch + paired eval | memory off vs on, per-case quality and cost deltas | paid | proposed |
| P2 | Multi-session savings | capture, consolidation, cumulative cost over N sessions | paid | proposed |

Order matters: the bench finds the bugs, the fixes make the injection correct,
and only then is a paid comparison worth its money. A paired eval of a
retriever that injects deleted memories measures the bug.

## 4. P1: injection bench (`pnpm bench:inject`)

`pnpm bench:recall` scores what `retrieve()` ranks. The model never sees that
list. It sees what `prepareMemories()` returned *for this session at this
moment*, cut by the renderer's byte budget. A match that never reaches the
request is not a successful injection. This bench measures that.

**Constraints.** Calls production code (`MemoryGraphService.prepareMemories`,
`judgeMemories`, `renderRetrievedMemoriesDetailed`), never a reimplementation.
Throwaway temp store, never the developer's. Zero model calls by default: the
judge is off or an explicitly labelled oracle. A paid `--judge=real` mode may be
added later behind an explicit flag; it is not required for P1.

### 4.1 Corpus metrics

Same corpus as `bench:recall` (40 memories, 22 scored + 5 abstention queries),
one fresh session per query, preparation drained before scoring.

| Metric | Meaning |
| --- | --- |
| candidate recall | gold ids present in the prepared set (what retrieval handed over) |
| **rendered recall** | gold ids present in the block the model actually receives |
| full-body recall | gold ids rendered with their body, not degraded to a one-liner |
| rendered precision | gold ÷ rendered entries (not ÷ k; see bench:recall's precision@5 caveat) |
| abstention | off-topic queries that inject nothing |
| block bytes / est. tokens | per request; the recurring cost of the block |
| **wasted bytes** | bytes spent on non-gold entries: pure cost, zero benefit |
| budget drops | gold entries retrieved but cut by the byte cap |
| prepare latency | p50 / max for `prepareMemories` |
| cold misses | first call returned before retrieval landed (`pending`) |

Report both `--judge=none` (as shipped with the judge off) and
`--judge=oracle` (the ceiling). Labels say which.

### 4.2 Lifecycle scenarios

Deterministic scripts over the production service. Each reports pass/fail and
a one-line reason; **a failure is a finding for §4.3, not a crashed bench**.
The bench prints all of them and exits non-zero only on an internal error, so
a known-failing scenario is visible without blocking unrelated work.

| Scenario | Pass means |
| --- | --- |
| first message, fast retrieval | gold injected on the first request |
| retrieval slower than the 60 ms cold budget | first request empty (`pending`); next request carries gold |
| same-topic follow-up | set carried, no new judge call |
| abrupt topic switch | old topic's memories are not injected |
| repeated identical prompt | one judge call total |
| memory **edited** mid-session | next injection carries the new text |
| memory **deleted** mid-session | never injected again |
| memory **superseded** | the replacement is injected, the obsolete one is not |
| duplicate memories competing for budget | block stays under cap; the gold entry keeps its body |
| judge outage | fails closed: nothing injected, decision `failed` |
| malformed verdict | fails closed: decision `unparseable` |
| secret-bearing file written outside the normal writers | secret text never appears in any block |

### 4.3 Findings (first run 2026-09-25)

Full tables: `memory/bench/README.md`.

**Metrics, judge off → oracle judge.** Rendered recall 84.1% in both, equal
to candidate recall, so the byte budget costs no recall. With the judge off
the block averages **1962 B (~490 tokens) per request, 62.5% of it on
memories that did not apply**, and abstention is 0/5. A perfect filter cuts the
block to 597 B (−70%) with 100% abstention; the fixed header + footer is then
two thirds of what remains.

**Scenarios: 7/12 on the first run, 12/12 after fixes.**

| Finding | Fix | Regression test |
| --- | --- | --- |
| Edit/delete staleness: `onChange` never touched a session's stash and a resolved query was not re-fetched | `invalidateSessions` patches every session holding the memory synchronously (remove / swap, re-judge), and a store generation makes an in-flight prefetch discard pre-change results | `graph/prepared-memories.test.ts` |
| Supersession: obsolete and replacement both injected | `graph/supersession.ts`: each candidate becomes the newest live record in its chain before judging; mutual/cyclic chains keep both; missing targets change nothing | `graph/supersession.test.ts`, `prepared-memories.test.ts` |
| Secret filter gap: a secret in a hand-written file reached the block via BM25 | `modelSafe` drops secret-bearing entries from every prefetch (so the judge never sees them either) and from the stash patch on an edit | `prepared-memories.test.ts` |
| Cold wait overrun: first `prepareMemories` blocked 110–160 ms vs a 60 ms budget | fastembed padded every input to 512 tokens, synchronously; the embedder disables padding. Query embed ~150 ms → ~4 ms, identical vectors (cosine 1.000000); p50 prepare 134 → 6 ms | `graph/embedder.test.ts` |
| Near-duplicates out-rank a matching fact, which loses its body | Not a bug: ranking of similar memories is retrieval's job and suppression is tuning that needs §6 evidence. Recorded in `docs/DECISIONS.md`; the scenario now checks the renderer contract | the scenario |

Passing from the start, as designed: slow retrieval surfaces on the next
request, same-topic follow-ups and repeated prompts cost one judge call, topic
switches drop the old set, and judge outage / malformed verdicts fail closed.

**What this says about savings, before any paid eval:** the judge is the
component that decides the block's cost. Off, most injected bytes are waste on
every request; the paid eval (§6) should therefore compare against the judge
*on* as well as off, not treat it as an afterthought variant.

### 4.4 Deliverables

- `memory/bench/inject.ts`: pure metric fold (tested like `metrics.ts`).
- `memory/bench/scenarios.ts`: the §4.2 scripts.
- `memory/bench/inject-run.ts`: entrypoint; `--json`, `--verbose`, `--judge=none|oracle`.
- `pnpm bench:inject` in the root `package.json`; results table in `memory/bench/README.md`.

## 5. P0: measure the whole bill (done 2026-09-25)

Summary of what shipped; the code and tests are the reference.

- **Auxiliary calls.** `memory.auxiliary` rollout event per judge, extraction,
  consolidation, and final-flush call: purpose, provider/model, auth mode,
  duration, outcome, usage. One event = one attempt (`PROVIDER_MAX_RETRIES` is
  0). A call that failed or reported no usage prices as **unknown** and marks
  the total partial (`rollout/cost.ts`).
- **Per-request exposure.** `memory.exposure` per provider request: block
  bytes, local token estimate (never added to provider usage), candidate /
  rendered / full / summary counts, preparation state
  (`fresh|carried|pending|empty`), judge decision. No text or identities.
- **Rollups.** Trace, terminal waterfall (`memory`, `memory tokens`,
  `memory context`, `by op`), OTLP, and `TrialResult.costByOperation`. Grader
  spend stays in `judgeCostUsd`.
- **Eval completeness.** Extraction, consolidation, and the judge prefetch are
  tracked background jobs; the runner drains them
  (`FREECODE_EVAL_MEMORY_DRAIN_TIMEOUT_MS`, 10 s). Pending work leaves
  `costUsd` undefined; a partial price sets `costPartial`. Comparisons count
  both as unpriced and refuse a cost delta.
- **Rendering.** Whole serialized block fits the UTF-8 cap; exact rendered
  entries drive notices, exposure, and citation eligibility; episodes render
  their name so `episode/<name>` is citable.
- **Tests.** `cost.test.ts`, `background-jobs.test.ts`,
  `loop-memory-exposure.test.ts` (real loop: one exposure per request that
  carried the block, zero bytes when none), byte-boundary sweep in
  `mem-prompt.test.ts`, unpriced cases in `compare`/`ab` tests.

## 6. P1: paired eval: does memory pay?

**Prerequisite: a recall-off switch.** Today extraction, judge, and
consolidation can be disabled, but automatic recall cannot. Add
`memory.autoRecall` / `FREECODE_DISABLE_MEMORY_RECALL=1`, re-read per request
so `eval ab` accepts it (`VARIABLE_ENV_KEYS`), and have exposure record
`preparation: "disabled"` so an off trial is distinguishable from an empty one.
Static memory guidance and the `memory` tool stay constant on both sides;
record that choice in the experiment.

**Start with two variants, not five:**

| Variant | Recall | Judge | Purpose |
| --- | --- | --- | --- |
| A | off | — | baseline |
| D | as shipped | as shipped | does memory help at all? |

Add B (BM25 only), C (+ vectors), E (± judge) **only if A vs D shows a real
difference**; they answer "which part helps", which is moot until something does.

**Suite.** `evals/memory.jsonl`, 6–10 cases, each with a frozen memory fixture
loaded into an isolated per-trial store (never the real one; extraction and
consolidation off on both sides):

- tasks where a remembered fact decides the right answer (a convention, a
  forbidden command, a past decision), scored by a deterministic checker;
- tasks where memory saves investigation (the answer is findable in the repo
  but costs reads), scored on outcome **and** tool calls/turns;
- 2–3 tasks where memory is irrelevant, to catch negative transfer and pure
  block cost.

**Protocol.** Interleaved pairs (`eval ab` already does this), pinned model and
auth mode, ≥3 trials per case (5 for anything close). Report per case:
pass rate, turns, tool calls, input/cache/output tokens, `costByOperation`,
and cost per successful task, on comparable pairs only. Predeclare with
`--hypothesis` before running.

**Verdict labels:** *saves cost at comparable quality*, *improves quality at
additional cost*, *regresses*, *inconclusive*. A lower token count alone is not
a verdict when cache behaviour or models differ.

## 7. P2: multi-session savings

The paired eval freezes the corpus. This experiment lets memory learn: scripted
histories run as consecutive sessions in one isolated store with extraction and
consolidation on, then later tasks that need earlier context.

Measure durable-fact capture, false memories, duplicate growth, correction of
changed facts, later-task quality, and **cumulative runtime cost vs a no-memory
run of the same sessions** at increasing session counts, the "how much has
memory saved us over N sessions" curve. Consolidation cost is amortized across
the sessions it served. The harness must call `endSession` so the final flush
runs (single-trial evals never do).

An external held-out set (LongMemEval-S, after a licence check) may be added
later and reported separately; never tune on it.

## 8. Completion checklist

- [x] Full runtime memory cost is measurable, including background calls.
- [x] The byte cap is strict and exposure attribution matches rendered content.
- [x] `pnpm bench:inject` reports rendered recall, wasted bytes, and every §4.2 scenario.
- [x] Every failing scenario is fixed with a regression test, or recorded in `docs/DECISIONS.md` as intended.
- [ ] Recall can be switched off per request, and `eval ab` accepts the switch.
- [ ] A recorded A-vs-D experiment in `evals/experiments.jsonl` with a verdict.
- [ ] A multi-session report gives cumulative cost with and without memory.
- [ ] `MEMORY_SYSTEM.md`, bench README, `EVAL.md`, `TRACE.md` match shipped behaviour.
