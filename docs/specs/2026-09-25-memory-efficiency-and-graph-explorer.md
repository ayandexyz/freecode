# Memory efficiency evaluation and graph explorer improvements

**Date:** 2026-09-25  
**Status:** In progress — rendering, attribution, and auxiliary-cost trace slice implemented; remaining items proposed
**Audit baseline:** `f7c83321`  
**Goal:** Establish whether native memory improves completed tasks enough to justify its full token and cost overhead, correct identified gaps, and make `/graph` compact, readable, and useful for inspecting recall.

## 1. Decision to make

Memory is not inherently a token-saving feature. Local search costs no paid model tokens, but injected context, relevance judging, extraction, and consolidation do. Memory earns its cost when it avoids enough repeated explanation, investigation, mistakes, or model turns, or materially improves task quality.

We need to answer three separate questions:

1. Does persistent memory improve task outcomes versus no memory?
2. Does graph traversal improve outcomes beyond simpler lexical/vector retrieval?
3. Does the improvement justify total cost and latency, including background work?

The explorer is a presentation layer. Improving its layout does not itself change retrieval quality or reduce model tokens. Keep these workstreams separately measurable.

## 2. Existing contracts

Follow these documents during implementation:

- [Architecture v4](2026-05-25-architecture-v4.md): business logic stays in core; frontends render and speak IPC.
- [Memory system reference](../MEMORY_SYSTEM.md).
- [Memory graph](2026-07-26-memory-knowledge-graph.md).
- [Write path](2026-08-09-memory-write-path.md).
- [Consolidation, judging, and recall benchmark](2026-08-23-memory-consolidation.md).
- [Explorer design](2026-08-04-memory-graph-explorer-design.md).
- [Observability](2026-08-10-agent-observability.md) and [eval commands](../../EVAL.md).

Preserve markdown as the source of truth and `.graph/` as rebuildable derived state. Keep actual memories after the provider cache anchors, outside the static system prefix. Preserve localhost-only explorer serving and the optional addon distribution. Keep memory bodies, queries, paths, and descriptive memory names out of exported telemetry.

This document proposes changes; it does not silently replace existing specs. When implementing changed retrieval or scheduling behavior, update the corresponding design decisions and record the evaluation evidence before changing defaults.

## 3. Evidence collected

### 3.1 Fresh recall results

Commands run during the audit:

```bash
pnpm bench:recall
pnpm bench:recall -- --judge=oracle
```

Both used the fused retrieval path. Corpus: 40 memories, 22 scored queries, five abstention queries.

| Metric              | Retrieval without judge | Perfect oracle filter |
| ------------------- | ----------------------: | --------------------: |
| Recall@5            |                   81.8% |                 86.4% |
| Recall@10           |                   86.4% |                 86.4% |
| Precision@5         |                   24.5% |                 26.4% |
| MRR                 |                   84.1% |                 95.5% |
| nDCG@10             |                   79.4% |                 88.4% |
| Abstention accuracy |                     0/5 |                   5/5 |

The oracle knows the gold labels. It establishes a filtering ceiling, not the accuracy of a real judge. Precision@5 divides by five even when a query has fewer than five gold memories; do not interpret it as the fraction of returned memories that are useful.

The benchmark calls production retrieval but bypasses session preparation, real judging, prompt rendering, and the agent task. Its cost counters are explicitly zero for these local/oracle runs. They are not evidence that production memory costs zero tokens.

### 3.2 Historical cost experiments

The [experiment ledger](../../evals/experiments.jsonl) records:

- `2026-09-07-trajectory-1`: anti-narration wording in the memory block recorded tokens down 13.5%, cost down 16.1%, and similar trajectory quality.
- `2026-09-05-redirect-1`: dynamic-tail placement preserved cache reuse, but aggregate cost increased with more turns; one turn-matched case cost 22% less. This involved memory, todo, and reminder placement together.

These are historical reports about particular changes. Neither establishes the net effect of enabling persistent memory, and neither closes the auxiliary-call accounting gap.

`pnpm bench:memory` measures process RAM/startup behavior, not persistent-memory effectiveness or token cost.

### 3.3 Explorer evidence

The saved project graph had 79 nodes: 68 memories, five tags, six clusters. Its 75 edges consisted of 68 cluster memberships, six tag links, and one explicit related-memory link. There were six disconnected components, with sizes 27, 16, 16, 11, 6, and 3.

Installed `graph.js`, `graph.css`, and `index.html` matched the checkout. No browser was connected, so the audit verified code and stored topology, not rendered screenshots or interaction quality.

The viewer uses many-body repulsion `-180`, fixed link distance `60`, and link strength `0.5`. `forceCenter` translates the graph without compacting its relative positions. There is no positional attraction to restrain disconnected components. `fitToView()` recenters/reheats the simulation but does not fit its bounds to the viewport. A comment describes weight-dependent distance that is not implemented.

## 4. Work packages and order

| Priority | Work package                      | Deliverable                                                             | Dependency                                     |
| -------- | --------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| P0       | Complete memory accounting        | Auxiliary-call usage and request-level injection measurements           | None                                           |
| P0       | Correct rendering and attribution | Strict byte cap and exact rendered-memory identities                    | None                                           |
| P1       | Production-path evaluation        | Isolated retrieval and end-to-end task comparisons                      | Accounting and rendering                       |
| P1       | Retrieval correctness             | Tested freshness, judge carry, supersession, and safe fallback behavior | Reproducers; evaluation before default changes |
| P1       | Explorer layout and interaction   | Compact graph, real fit, local view, readable controls                  | Can proceed independently of retrieval tuning  |
| P2       | Evidence-based cost tuning        | Judge/model/budget choices backed by paired results                     | Evaluation                                     |
| P2       | Multi-session learning evaluation | Capture, consolidation, and amortized cost report                       | Accounting and isolated lifecycle harness      |
| P2       | Documentation and addon release   | Updated references, reproducible reports, installed UI verification     | Relevant implementation complete               |

All work below is pending unless explicitly marked as audit evidence above.

## 5. P0: measure the complete bill

### Required changes

- [x] Introduce a shared core path for metering auxiliary model calls, used by retrieval judging, extraction, final flush, and consolidation.
- [x] Record operation purpose, originating session/run where available, call ID, resolved provider/model, auth mode, timing, success/failure, and provider-returned usage.
- [x] Price calls with existing pricing semantics: unknown price remains unknown; cache-read tokens are not added again to inclusive input usage; auth mode is captured on the call.
- [ ] Include successful retries and any reported usage from failed attempts without double counting. Report unavailable usage explicitly.
- [ ] Attribute project-wide consolidation once to its originating operation, and report how its cost is amortized across a multi-session experiment.
- [ ] Record per-model-request memory bytes, estimated tokens, selected count, rendered count, rendering mode, retrieval outcome, judge outcome, and whether preparation was fresh, carried, pending, or empty.
- [ ] Keep estimated memory-block tokens separate from actual provider usage. The total provider input already includes the block; never add the estimate to that total again.
- [ ] Retain separate counters for unique user-turn exposures and repeated model-request exposures. Repeated exposure is relevant to cost even when the UI notice is deduplicated.
- [ ] Give evaluation runs a bounded way to drain background memory jobs. Pending work or unknown spend makes the full-cost result incomplete; a timeout must not silently look like savings.
- [x] Expose a memory cost breakdown through existing report/trace mechanisms. Keep external quality-grader spend separate from product runtime spend.

Proposed report categories: main agent, retrieval judge, extraction/final flush, consolidation, and evaluation grader. Final field names and event names must align with rollout/OTLP conventions before implementation.

**Implemented 2026-09-25:** `memory.auxiliary` rollout events now capture the
purpose, provider/model, auth mode, duration, outcome, and provider-reported
token/cache usage for retrieval judging, extraction, consolidation, and the
session-end flush. Event IDs identify calls; the rollout aggregate identifies
the originating session, with the originating turn attached where available.
The trace, terminal waterfall, evaluation trial cost, and OTLP export fold
these calls separately from foreground agent turns while pricing their combined
runtime cost with the existing cache and subscription rules. Retry accounting,
request-level exposure data, and background-drain support remain open.

**In progress 2026-09-25:** every foreground provider attempt now writes a
`memory.exposure` event, including attempts made after an overflow compaction
or provider recovery. It records injected bytes, a separately labelled local
token estimate, candidate count, rendered count, and whether a memory block was
actually present. Preparation freshness, judge outcome, unique-turn rollups,
and a bounded background drain are still required before the corresponding
checklist items can be marked complete.

### Acceptance criteria

Controlled provider tests reconcile report totals with returned usage across success, retries, failure, and late background completion. A request with no injected memory records zero memory-block bytes. A ten-request tool loop records all ten exposures if the block was sent ten times. Unknown cost cannot produce a definitive savings verdict.

## 6. P0: fix rendering and attribution

The audit reproduced a 2,061-byte result against the advertised 2,048-byte cap. Section overhead is not fully included in the budget. Existing prompt tests passed but missed that boundary.

- [x] Budget the complete serialized block: headers, sections, separators, bodies/summaries, episodes, and citation footer.
- [x] Return rendering metadata alongside text, including exact rendered entries. Preserve a compatibility wrapper for callers that need a string.
- [x] Base injection notices, exposure attribution, and citation eligibility on rendered entries rather than all retrieved candidates.
- [ ] Give episode summaries an unambiguous citation identity without exceeding the budget.
- [ ] Test exact boundaries, multi-byte text, long names/descriptions, every memory type, omitted entries, and empty output. Preserve whole-entry degradation rather than truncating a fact mid-sentence.

**Acceptance:** every emitted block fits the UTF-8 byte cap; omitted memories receive no exposure credit; citation credit can only reference something actually rendered. Static guidance and provider cache placement remain unchanged.

## 7. P1: evaluate what the model actually receives

### 7.1 Local retrieval and injection benchmark

Keep the current cheap recall benchmark. Extend it or add a companion benchmark that exercises `prepareMemories()` and the production renderer, reporting both candidate recall and rendered recall under the actual budget.

Use deterministic judge doubles for lifecycle tests; keep the oracle explicitly labeled. Add real-judge evaluation as a separately invoked paid mode. Do not replace free regression tests with mandatory paid calls.

Fixtures must cover:

- Relevant preference/fact and irrelevant requests.
- First-message recall and retrieval completing after the 60 ms budget.
- Same-topic follow-ups, abrupt topic switches, and repeated identical prompts.
- Added, edited, deleted, and superseded memories during an active session.
- Duplicate memories, conflicting statements, long bodies, and budget competition.
- Embedding failure, judge outage, malformed verdict, and in-flight topic changes.
- Secret-bearing files introduced outside normal writers, across lexical, vector, fallback, judge, and injection paths.
- Episode decay and whether an important older fact survives rendering.

Report recall@k, ranking metrics, abstention, precision among returned entries, rendered recall, stale/contradictory injection, retrieval latency, and preparation misses. A semantic match that never reaches the request is not a successful injection.

### 7.2 Paired agent-task benchmark

Implement a memory-specific suite and fixture adapter within the existing eval architecture. Real-agent cases belong in `evals/`; pure renderer/retriever checks remain colocated tests. Names for new CLI options and datasets are proposals until implemented and documented in `EVAL.md`.

| Variant | Retrieval              | Real relevance judge | Purpose                     |
| ------- | ---------------------- | -------------------- | --------------------------- |
| A       | Disabled               | No                   | No-memory baseline          |
| B       | BM25 only              | No                   | Simple lexical baseline     |
| C       | BM25 + vectors         | No                   | Incremental embedding value |
| D       | BM25 + vectors + graph | No                   | Incremental graph value     |
| E       | Same as D              | Yes                  | Incremental filtering value |

For the primary read-path comparison, freeze the same memory corpus and disable extraction/consolidation on every side. Use explicit experiment controls for retrieval/injection: disabling extraction or judging alone is not a memory-off switch. Decide separately whether static guidance and the memory tool are held constant or removed; record that choice so automatic recall is not confused with the entire memory subsystem.

- [ ] Give each trial an isolated project, memory store, usage state, graph state, session, and judge carry. Never populate or mutate the developer's real store.
- [ ] Use separate processes or fully reset singleton/configuration state between variants. Drain background work before moving to the next side.
- [ ] Interleave paired trials; pin model, auth mode, prompt, starting files, tool permissions, and corpus hash. Record actual resolved models and all configuration.
- [ ] Separate cold and warm cache/embedding conditions. Do not let one side prewarm the other without reporting it.
- [ ] Start with a small smoke subset, then at least three paired trials per case; use five or more for noisy decisions. Report per-case results and uncertainty rather than declaring a win from one aggregate.
- [ ] Score task outcomes using deterministic checkers where possible. Use an independent quality judge when necessary, following existing judge-independence rules.
- [ ] Include irrelevant/no-memory-needed tasks to measure negative transfer and wasted work, not just tasks built to favor memory.
- [ ] Separate infrastructure failures from quality failures, retain their actual spend, and compare efficiency on matching completed pairs.

Measure task pass rate, correctness of remembered facts, tool calls/repeated reads, turns, latency, uncached/cache-read/cache-write/output usage as available, full runtime cost, auxiliary cost, and cost per successful task. Report raw totals and paired deltas; do not hide expensive failures behind successful-only averages.

### 7.3 Multi-session learning benchmark

Run a second experiment with extraction and consolidation enabled. Feed the same scripted histories, restart sessions, change facts, and ask later tasks whose answers require prior context. Allow memory changes only inside isolated stores.

Measure durable-fact capture, false memories, duplicate growth, corrections, consolidation retention, later task quality, and cumulative cost at increasing session counts. Compare frozen snapshots before/after consolidation to isolate its retrieval effect from new learning.

Add an external held-out corpus such as LongMemEval-S after validating its license and adapter. Report it separately from repository-specific coding tasks and the hand-written corpus; do not tune thresholds on the held-out set.

### Decision policy

```text
runtime cost with memory = main agent + judge + extraction/flush + consolidation
net savings = runtime cost without memory - runtime cost with memory
```

Injected tokens are already inside main-agent input usage. Background work is included even if it completes after the visible answer. Subscription runs should report token/quota usage and billing mode, without presenting API-equivalent prices as actual subscription charges.

Predeclare the hypothesis, quality tolerance, and minimum worthwhile savings before a paid comparison. Keep existing release-gate semantics; `eval ab` is evidence, not a new automatic gate. Label results **saves cost at comparable quality**, **improves quality at additional cost**, **regresses**, or **inconclusive**. A smaller token count alone is insufficient when cache behavior or models differ.

## 8. P1: retrieval correctness and freshness

These are source-level concerns; implement focused reproducers before choosing fixes.

- [ ] **Cold recall:** compare bounded waiting, immediate local candidates, and current asynchronous preparation. Distinguish explicit requests to remember prior context from ordinary prompts. Do not make every turn wait for a remote judge by default without latency/quality evidence.
- [ ] **Judge carry:** invalidate or refresh verdicts when candidate identities/content or store generation changes; bound verdict lifetime. Avoid blindly rejudging unchanged candidates every iteration.
- [ ] **Store updates:** invalidate stale prepared entries when memories are edited/deleted, including when the user's query text is unchanged. Preserve session isolation and in-flight topic checks.
- [ ] **Supersession:** define directed replacement semantics for automatic injection. Keep old records inspectable; prefer the valid replacement and avoid treating obsolete guidance as another positive neighbor. Specify chain, cycle, and missing-target behavior.
- [ ] **Cascade scoring:** verify whether first-visit BFS is the intended policy when multiple paths reach a memory. Test competing paths before changing aggregation or graph weights.
- [ ] **Sensitive content:** ensure filtering protects all model-bound recall paths, not only writes, embeddings, and explorer detail responses.
- [ ] **Judge input quality:** measure whether description-only judging loses necessary distinctions. Evaluate compact excerpts only under an explicit token budget.

**Acceptance:** focused regressions pass, the production-path benchmark reports the expected rendered memories, and changed defaults have paired quality/cost/latency evidence.

## 9. P1: explorer redesign

### Layout and controls

- [ ] Add gentle positional attraction and size-aware spacing/packing for disconnected components. Preserve separation without leaving large empty regions.
- [ ] Implement true fit-to-bounds after initial settling and on explicit reset; account for padding and the open detail panel. Do not override user zoom continuously.
- [ ] Handle viewport resize without restarting into an unreadable layout.
- [ ] Make link distance/strength intentional by edge type, or remove the misleading weight-distance claim. Layout weights must not change retrieval weights.
- [ ] Add accessible controls for compactness, repulsion, link spacing, labels, fit/reset, and pause/resume; provide sane defaults.
- [ ] Add selected-memory neighborhood views with one/two-hop depth, node/edge filters, and a clear return to the full graph.
- [ ] Use subtle edges and readable topic/type colors. Show labels by zoom/hover/selection; keep selected-node labels legible.
- [ ] Hide synthetic cluster hubs visually by default if usability testing supports it, while retaining layout grouping and an inspection toggle. Never fabricate semantic relationships just to connect islands.
- [ ] Use descriptive cluster labels derived locally from member tags/names where useful; do not add a paid labeling call merely for appearance.

### Explain actual recall

Current explorer search is permissive and does not reproduce automatic injection: it bypasses the real judge, session carry, episode score adjustment, and rendering budget.

- [ ] Label search results as retrieval candidates rather than “what was injected.”
- [ ] Add a core-provided view of an actual session/request's preparation and rendering decision: candidates, filtering outcome, rendered subset, budget drops, freshness, and cost availability.
- [ ] Read recorded/in-memory decisions for inspection; opening the graph or selecting a node must not trigger a paid judge call.
- [ ] Keep memory content on demand through the node-detail endpoint. If decision history is needed, bound its retention and keep descriptive identifiers local rather than exporting them through OTLP.
- [ ] Keep selected details, filters, and graph highlighting consistent. Add keyboard access and visible focus states.

### Visual acceptance

Test empty/single-node graphs, the current six-component topology, long labels, and fixtures of roughly 50, 100, and 500 nodes. At normal desktop sizes, fit must place every visible component inside the available viewport. Verify search, drag, zoom, reset, local view, filters, detail panel, and resize in a connected browser. Save representative before/after screenshots and record the browser/device used for responsiveness checks.

Use Obsidian as a reference for compactness controls and local graph navigation, not a requirement to clone its application. Reference: [Obsidian graph view](https://obsidian.md/help/plugins/graph), [D3 center force](https://d3js.org/d3-force/center), [D3 position forces](https://d3js.org/d3-force/position).

The addon ships separately: release the updated `graph-ui.tar.gz`, then verify `freecode memory ui-install` installs assets matching the intended release. A source-only UI change does not update installed binaries' explorer assets.

## 10. P2: tune only after measurement

Candidate experiments, not predetermined improvements:

- Dedicated configurable auxiliary model versus the main session model for judging.
- Local relevance gating or reranking versus a paid judge, including abstention failures.
- Smaller candidate sets and different injection budgets.
- Reusing verdicts keyed by query/topic plus candidate content versions.
- Graph depth zero/one/two and tag/cluster-edge ablations.
- Duplicate suppression and consolidation at equal rendered-token budgets.
- Reducing repeated block exposure only if context remains correct across compaction, retries, and changing model requests.

Choose the simplest configuration that meets the quality target at the measured cost. Do not add a remote vector service, a graph database, more models, or a new UI framework without a demonstrated need.

## 11. Suggested implementation sequence

1. **Rendering patch:** strict budget, rendered IDs, accurate exposure/citation attribution, focused regression tests.
2. **Metering patch:** auxiliary-call accounting, request-level exposure data, bounded background drain, trace/report integration.
3. **Evaluation patch:** isolated memory fixtures, variant controls, production-path metrics, paired task suite, reproducible report format.
4. **Correctness patches:** one behavior at a time, with reproducers and before/after evidence.
5. **Explorer patch:** layout and navigation; verify independently of changes to retrieval behavior.
6. **Inspection patch:** actual injection decisions and cost availability in the explorer.
7. **Tuning and release:** run predeclared comparisons, record outcomes, update docs, package and verify the addon.

The explorer layout work can proceed alongside accounting/evaluation work, but it must not be presented as evidence of improved memory efficiency.

## 12. Completion checklist

- [ ] Full runtime memory cost is measurable, including late/background calls.
- [ ] The byte cap is strict and exposure attribution matches rendered content.
- [ ] Cold recall, topic changes, updates, supersession, and failures have meaningful regression coverage.
- [ ] A reproducible report compares no memory, lexical, vector, graph, and real-judge variants.
- [ ] A multi-session report measures capture/consolidation benefits and cumulative cost.
- [ ] Reports distinguish measured savings, quality gains, unknown costs, and inconclusive outcomes.
- [ ] The graph is visually verified with disconnected components and representative sizes.
- [ ] Inspection distinguishes retrieval candidates from actual injection and never causes hidden paid calls.
- [ ] `MEMORY_SYSTEM.md`, benchmark README, relevant specs, `EVAL.md`, and `TRACE.md` agree with shipped behavior. Remove stale statements that all retrieval is network-free or that built write-side features are absent.
- [ ] New defaults have evidence; installed addon assets match the released design.
