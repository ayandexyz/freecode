# Checkpoints / Rewind

> Status: Phases 0–3 built 2026-09-23. Supersedes ROADMAP item 8.
> Undo a turn's file changes, and the conversation that caused them, together.

## 1. The gap

`session.navigate` (`session/store.ts:578`, spec `2026-09-20-pi-parity-plan`
Phase 3) already rewinds the **transcript**: it moves the active leaf back, the
abandoned branch gets a `branch_summary`, and the next turn continues from the
chosen point. It does nothing to **disk**. After navigating back past three
turns of `write`/`edit`/`bash`, the model's view is rewound and the working tree
is not — which is worse than no undo at all, because the transcript now lies
about the files.

This spec adds the file half and pairs the two.

## 2. What was rejected, and why

Three reference harnesses were read before choosing.

- **oh-my-pi `checkpoint`/`rewind`** — despite the name, its own docs state it
  "does not call git and does not snapshot filesystem state". It collapses
  exploratory turns into a report. That is FreeCode's `/tree` +
  `branch_summary`, already built. Not a reference for this feature.
- **claude-code `utils/fileHistory.ts`** — copies each file to
  `~/.claude/file-history/<session>/<sha256(path)[0:16]>@vN` *before* mutating
  it, one snapshot per user message, `MAX_SNAPSHOTS = 100`. Works without git.
  Rejected as the primary: hand-rolled diffing, no dedup across sessions, and a
  retention cap we would have to tune. Its `null`-backup idea ("file did not
  exist, so restore deletes it") is kept — see §4.3.
- **opencode `snapshot.ts` + `session/revert.ts`** — **adopted**. A shadow git
  repository whose `GIT_DIR` lives outside the project and whose work tree *is*
  the project. Captures trees, not commits. Dedup, diffing and selective
  restore all come from git.

## 3. Storage

```
~/.freecode/snapshots/<sha256(realpath(projectRoot))[0:16]>/
    HEAD  objects/  refs/  index      # a git dir; it has no work tree of its own
```

The work tree is the real project root, passed per command. Nothing is ever
written inside the project, and the project's own `.git` — index, HEAD,
stash, reflog, `git status` — is never touched. This is verified by
`shadow-git.test.ts`, which asserts the host repo's `status --porcelain` and
HEAD are byte-identical across a capture/restore cycle.

### 3.1 Why trees, not commits

`git checkout <tree-ish> -- <paths>` accepts a bare tree. Capturing is
`add -A` + `write-tree`; there is no commit object, no parent chain, no branch,
and therefore nothing to garbage-collect incorrectly or to confuse a user who
runs `git log` in the shadow dir. A snapshot id **is** a tree id.

### 3.2 Requires a git repository

`capture()` returns `undefined` when the project is not a git repo, and the
feature is inert. This is deliberate and matches opencode: the shadow repo's
`add -A` relies on the project's `.gitignore` to know what not to snapshot.
Without one, the first capture of a Node project would walk `node_modules`.
A non-git fallback (claude-code's per-file copies) is possible later; it is not
built, and `checkpoints.enabled` on a non-git project logs one line and stays
off rather than failing a turn.

An untracked file larger than `MAX_UNTRACKED_BYTES` (2 MiB, opencode's number)
is excluded from the snapshot, so a stray build artifact or core dump cannot
inflate the shadow repo. Such a file is therefore **not restorable** — it is
reported in the rewind preview as `skipped (too large)`.

## 4. Capture and restore

### 4.1 When a snapshot is taken

Once per **user turn**, in `AgentLoop.run()` immediately before the initial user
message is appended — so the tree reflects disk as it was *before* the model
acted. Keyed by that user message's **session-store entry id**, which is what
`session.tree` lists and what `session.navigate` targets.

Capture is best-effort and never fails a turn: any error is logged, recorded as
`checkpoint.skipped`, and the turn proceeds with no checkpoint for that message.

Not captured for: subagents (`checkpoints: false`, the same convention
`memoryExtraction`/`autoPoke`/`cacheWarming` already use), synthetic user
messages (`steer`, `auto_poke`, `branch_summary` — they are not points a person
asked for), and sessions whose project is not a git repo.

### 4.2 What restore restores

Given a target snapshot, restore computes what changed *since* it by capturing
the current tree and diffing:

```
git diff --name-status <target> <current>
```

- `M` → `git checkout <target> -- <path>`
- `D` → `git checkout <target> -- <path>`   (deleted since; bring it back)
- `A` → `unlink(<path>)`                    (created since; it did not exist)

Only paths in that diff are written; a path identical to the snapshot is not
touched at all.

**This reverts changes the agent did not make.** The diff is target-vs-now, so
it cannot tell an agent edit from one the user made by hand in another window
since the checkpoint — both appear as `M`. Everything that changed since the
snapshot is reverted. opencode avoids this by recording the paths each
*assistant message* touched and restoring only those; that needs per-tool path
tracking, which per-turn capture deliberately does not do (§4.1).

This is why §5.1's preview is not optional. The preview lists every path that
would be written, so a hand-edited file shows up before anything is destroyed
and the user can cancel. Mitigating it properly means per-tool path tracking —
the §9 open question 4 below.

There is no merge and no conflict resolution.

### 4.3 Files that did not exist

Handled by the `A` case above. Restoring a snapshot taken before a file was
created deletes that file, rather than leaving an orphan the transcript no
longer explains. Empty parent directories left behind are removed, bottom-up,
only while they are empty and inside the project root.

## 5. Rewind

`session.rewind` is `restore files` + the existing `session.navigate`, in that
order, and it is the only caller that does both.

```
session.rewind { sessionId, entryId, files?: true, conversation?: true }
  -> { restored: FileChange[], skipped: string[], messages, abandoned, summarized }
```

Order matters: files first. If the file restore throws, the transcript has not
moved and the user is exactly where they were. If `navigate` throws after a
successful restore, the files are back and the transcript is not — reported
plainly rather than silently half-applied.

`files: false` gives conversation-only rewind, which is what the existing
`/tree` already does; `conversation: false` gives file-only undo. Both default
true. `/tree` itself is **unchanged** — it stays conversation-only so an
existing habit does not silently start rewriting the working tree.

### 5.1 Preview before write

`session.rewindPreview { sessionId, entryId }` returns the same `FileChange[]`
without touching disk, by diffing target against current. The TUI shows it and
requires a confirmation. There is no staged/committed state machine (opencode's
`stage`/`clear`/`commit`); a preview plus a confirm is the same guarantee with
one state fewer.

## 6. Retention

Snapshots are cheap (a tree object plus whatever blobs are new) but not free.
`checkpoints.json` is trimmed to the most recent `maxPerSession` (default 100,
claude-code's `MAX_SNAPSHOTS`) entries per session. Trees whose ids are no
longer referenced are left for git; the shadow repo has no refs, so
`git gc --prune` in the snapshot dir collects them. Pruning is manual —
`freecode checkpoint gc` — because running gc on the turn path is exactly the
kind of latency this feature must not add.

## 7. Recording

`checkpoint.captured { entryId, snapshot, durationMs }`,
`checkpoint.skipped { reason }`,
`checkpoint.restored { entryId, snapshot, filesChanged, durationMs }`.

Paths are **not** recorded — the rollout log feeds the OTLP export, which must
stay leak-free (observability spec §5.1, the same rule that keeps message
bodies out). Counts only.

## 8. Settings

```jsonc
{ "checkpoints": { "enabled": true, "maxPerSession": 100 } }
```

`FREECODE_CHECKPOINTS=0|1` beats the files, per the `signals` convention.
Default **on** where it can work, unlike the loop gates: this one does not
change what the model does — it only records state the user may later ask for —
so the `eval ab`-before-flipping-a-default rule in `signals/settings.ts` does
not apply.

## 9. Open questions

1. **Non-git projects.** Left uncovered (§3.2). claude-code's per-file copies
   are the obvious fallback behind the same `SnapshotStore` interface. Wanted
   only if someone actually runs FreeCode outside a repo.
2. **`bash` writing outside the project root.** A snapshot's work tree is the
   project root, so a `bash` command that writes to `~/.config` is outside it
   and is not captured or restored. Correct and intended, but the preview does
   not say so; a turn whose only effect was outside the root previews as "no
   file changes", which reads as "nothing happened".
3. **Restore during a live turn.** `session.rewind` refuses while
   `activeLoops` has the session, reusing `session.navigate`'s existing guard
   and message. Whether a rewind should instead stop the turn first is a UX
   call, deferred.

4. **Reverting the user's own concurrent edits (§4.2).** A file the user edits
   by hand after a checkpoint is reverted along with the agent's work, because
   per-turn capture derives the path set by diffing rather than recording what
   each tool touched. The preview makes it visible and cancellable, which is the
   floor, not the fix. The fix is opencode's shape — record touched paths per
   mutating tool call and intersect them with the diff — and it is a strict
   addition to what is built: the capture, the store and the restore all stay.
