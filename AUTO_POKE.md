# Auto-poke — operator reference

> What it does, how to turn it on, how to read the numbers. Design lives in
> `docs/specs/2026-09-12-harness-bench.md` §1; code in
> `apps/core/src/agent/signals/`. Sibling pages: `HARNESS-BENCH.md` (the
> bench commands), `EVAL.md` (how a default gets flipped).

## 1. What it is

Most agent failures are not wrong answers but early exits: the model writes a
todo list, does some of it, answers, and stops. Auto-poke checks the list when
the model ends its turn. If items are still open it sends the model back with
a **user-role message** listing them, and the model gets another go.

```
You stopped with 2 todo items still open (poke 1 of 3): "wire the new flag through settings.ts", "add the test".
Pick the next open item and do it now. Only if an item genuinely cannot proceed, todowrite it: cancelled if you will not do it (say why), blocked only when it needs something from the user (say what). Do not repeat a call that already failed.
```

One line of names (at most six, cut at 80 chars), jcode-style. It used to
print the full checklist with "pick the next open item, do it": on a list
whose items were all waiting on the user that read as an order to retry, and
session `698c5001` (2026-09-19) ran the same 403 `git push` 38 times until
loop-health killed it. The second line then led with "Continue working, or
update the list… mark an item blocked" — and the 2026-09-12→20 rollout fold
showed that offer being taken: of 51 pokes, 16 ended with every item marked
`blocked` and 16 with the model replying in prose and stopping again
(`no_progress`), against 10 that drained the list. Since 2026-09-20 the
action comes first and `blocked` is the last word, gated on "needs something
from the user".

A poke the model answers with **no tool call at all** is a bounce, not a
"cannot finish", and gets one harder re-poke (`retry: true` on the
`poke.triggered` event, "the agent replied without acting" in the notice):

```
You stopped with 2 todo items still open (poke 2 of 3): …
Your last reply had no tool call. Do not reply in prose: this turn must be a tool call — pick the next open item and start it, or todowrite with an honest status for each item. Do not repeat a call that already failed.
```

The retry is spent per fingerprint and rides it across runs, so an identical
list after that — bounced or not — is `no_progress`. A poke the model DID
act on (any tool ran) and still left unchanged is a genuine stop and is never
retried.

Rules, in the order they are checked (`auto-poke.ts` `decidePoke`):

| Outcome | When |
| --- | --- |
| `disabled` | the gate is off — the list was never looked at |
| `nothing_open` | every item is `completed` or `cancelled` |
| `read_only_mode` | the run is in plan/review/explore — the model cannot execute a mutating item, so a poke there only buys a turn of "blocked". Every `all_blocked` in the 2026-09-12→20 fold (16) was a read-only eval case that had been poked first |
| `all_blocked` | every open item is `blocked` — waiting on the user; a poke could only make the model retry or lie |
| `cap_reached` | already poked `maxPerRun` times this run (a run = one prompt; the counter resets per `run()`) |
| `no_budget` | `--max-turns` would land before the poked turn could execute |
| `no_progress` | the open items' ids and statuses match the last poke's — the model ignored it; poking again would burn tokens. Content is deliberately ignored (re-wording "blocked on 403" to "still blocked on 403" is not progress), and the fingerprint **survives across runs**: a user's "continue" on an unchanged list is one more turn, not three fresh pokes. Exception: if no tool ran since the poke (prose-only reply) and this fingerprint has not been retried, it is a bounce and gets one harder re-poke instead |
| **poke** | otherwise |

`cancelled` and `blocked` are the two honest exits. `cancelled` is closed: the
model dropped the item on purpose, which is not an early exit. `blocked` is
still open but parked on the user (credentials, a paste, a decision); the
prompt block renders it `[!]`, the TUI panel as a red `!`, and the model is
told to report it once and not retry. The message tells it to use either
rather than fake `completed`, so the list stays a record of what was done.

Between the 3rd and 6th identical tool call, loop-health also hands the model
one `<system-reminder>` naming the call (`agent/reminders.ts`
`repeatedCallReminder`), so a stuck model hears about it before the hard stop
rather than only from a debug log.

Every poke and every stop reaches the frontend as a one-line `notice`
(`"2 todos still open — sent the agent back (poke 1 of 3)."`).

**Subagents never poke.** Their parent judges their stop.

## 2. Why a user message, not a reminder

The poke is persisted as a real user turn (`SerializedMessage.synthetic:
"auto_poke"`) in history and the session store — not an ephemeral
`<system-reminder>`. jcode's finding, reproduced here: a turn whose only user
content is a reminder reads as empty, and the model replies to it ("Sure,
continuing!") instead of working. A persisted turn also keeps the transcript
alternating on resume. It is append-only, so prompt-cache anchors are
untouched.

Consequences: `freecode eval add` (harvest) skips synthetic messages; the TUI
renders them as a one-line notice on resume; the compaction transcript does
not carry them.

## 3. Turning it on

Off by default. Three ways, highest precedence first:

**Env — beats both files, either direction.** For one shell, one bench trial,
one eval variant:

```bash
FREECODE_AUTO_POKE=1 freecode          # on
FREECODE_AUTO_POKE=0 freecode          # off, even if a settings file says on
```

**User settings — every session on this machine.** `~/.freecode/settings.json`:

```json
{
  "signals": {
    "autoPoke": { "enabled": true, "maxPerRun": 3 }
  }
}
```

**Project settings — this repo only.** `<project>/.freecode/settings.json`,
same shape. Project beats user, the same scope order as `redirect/settings.ts`.

`maxPerRun` defaults to 3 (`AUTO_POKE_MAX_PER_RUN`). The two sibling gates
live in the same block and are documented in `HARNESS-BENCH.md` §1:

```json
{
  "signals": {
    "autoPoke":       { "enabled": true, "maxPerRun": 3 },
    "confidenceGate": { "enabled": false, "spike": 40 },
    "hillClimbGate":  { "enabled": false, "threshold": 90 }
  }
}
```

Note: this file is `settings.json`, not `config.json` (providers, keys). The
loop reads it once per `AgentLoop` instance (`loadSignalSettings`), so a
change takes effect on the next session, not mid-turn.

## 4. What is recorded (always, gate on or off)

The rollout log (`~/.freecode/rollout/sessions/<id>/events.jsonl`) carries a
`poke.triggered` or `poke.skipped` (with the reason above) on **every** model
stop while a todo list exists — `disabled` included. That is what makes the
before/after measurable: sessions from before the gate existed are the
baseline. Item text never enters the log, only ids.

`pnpm bench:signals` folds those into `apps/web/app/data/harness/signals.json`
→ `/bench` §06:

| Number | Meaning |
| --- | --- |
| sessions with a todo list | denominator |
| ended with items open | the number poke exists to move. From the LAST todowrite of each session, so it is measurable on gate-off logs |
| pokes / productive | fired, and followed by at least one tool call before the run ended |
| items completed after a poke | did the poked work close anything |
| skip reasons | why the gate declined, per the table above |
| ended-open, gate on vs off | the comparison that decides the default |

## 5. What we know so far (2026-09-16)

- Baseline on this machine: **58 of 135 todo sessions (43%) ended with items
  open.** 43 of those 58 end on a plain `model.response` — the model answered
  and stopped; not an interrupt, not an error. That is the early-exit shape.
- `pnpm eval ab coding` with `FREECODE_AUTO_POKE=0` vs `=1`, 3 trials, 12
  cases: **0 pokes fired on either side.** The coding cases are too short for
  an early exit — the model finishes them. Ledger `2026-09-16-coding-1`,
  verdict `rejected` (as a measurement, not as a feature). Cost was flat
  (−5.8%, noise).
- The utf16-transcode bench run this morning stopped on its own with open
  todos at turn 606 (`poke.skipped: disabled`) — the gate would have fired.
  A gate-on run of the same task is the next data point.
- A gate-on utf16 run (12:09 UTC, `FREECODE_AUTO_POKE=1`) ended at 72 min on
  a provider error — `Token Plan usage limit reached (2056)` — with 4 items
  open and **no stop, so no poke**. Best +0.381, final +0.333 (cut off
  mid-edit). Not published: a "poke on → lower score" row would say nothing
  about poke. A poke needs a model stop; a provider cut-off is not one.
- Gate-on real sessions: **0** before today. The `on` column on §06 is empty
  until someone runs with it enabled — hence the settings-file snippet above.

## 6. Flipping the default

Per `EVAL.md`: a default flips on an `eval ab` delta, not on `/bench`. The
blocker is that no eval case exercises an early exit. The cheapest fix is to
harvest a few of the 43 sessions above:

```bash
freecode eval add <session-id> --write --suite coding
```

then fill in `failureCategory` / `whyModelBacked` and re-run the A/B. Until
then, enabling it per-user via `settings.json` is the way to collect the
`on` column.

## 7. Not built

- **Retry on transient network error** — jcode retries a poked turn that
  fails on a transient error and stops the loop on a non-retryable one. Here
  a failed poked turn is just a failed turn.
- **Poke on headless `freecode run`** works (same loop), but nothing reports
  the notice on stdout; read the rollout log.
