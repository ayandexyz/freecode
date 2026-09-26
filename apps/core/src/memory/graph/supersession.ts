// =============================================================================
// Supersession for automatic injection (spec 2026-09-25 §4.3).
//
// `supersedes` records that one memory replaces another. The graph keeps both
// (the old record stays inspectable and searchable), but a request must never
// carry obsolete guidance next to, or instead of, its replacement: the model
// cannot tell which one is current. So before judging, each retrieved
// candidate is swapped for the newest live record in its chain.
//
// Ambiguity keeps both: a mutual or cyclic `supersedes` has no "newest", and
// guessing would silently hide a live memory. A target that no longer exists
// changes nothing.
// =============================================================================

import type { MemoryEntry } from "../mem-types.js";
import { memoryId, resolveName } from "./builder.js";

/** obsolete id → id of the memory that supersedes it, cycles removed. */
function replacements(all: MemoryEntry[]): Map<string, string> {
  const byName = new Map<string, MemoryEntry[]>();
  for (const e of all) {
    const list = byName.get(e.name) ?? [];
    list.push(e);
    byName.set(e.name, list);
  }
  const next = new Map<string, string>();
  // Sorted so that two records superseding the same one resolve the same way
  // on every run.
  for (const e of [...all].sort((a, b) =>
    memoryId(a.type, a.name).localeCompare(memoryId(b.type, b.name)),
  )) {
    const id = memoryId(e.type, e.name);
    for (const name of e.supersedes ?? []) {
      const target = resolveName(name, byName);
      if (target && target !== id && !next.has(target)) next.set(target, id);
    }
  }
  return next;
}

/** Follow a chain to its end; `undefined` when it loops back on itself. */
function terminal(id: string, next: Map<string, string>): string | undefined {
  const seen = new Set<string>([id]);
  let at = id;
  for (let to = next.get(at); to !== undefined; to = next.get(at)) {
    if (seen.has(to)) return undefined;
    seen.add(to);
    at = to;
  }
  return at;
}

/**
 * `candidates` with each superseded entry replaced by its newest live
 * replacement, order preserved, duplicates removed (first position wins).
 */
export function resolveSupersession(
  candidates: MemoryEntry[],
  all: MemoryEntry[],
): MemoryEntry[] {
  const next = replacements(all);
  if (next.size === 0) return candidates;
  const byId = new Map(all.map((e) => [memoryId(e.type, e.name), e]));

  const out: MemoryEntry[] = [];
  const placed = new Set<string>();
  for (const c of candidates) {
    const id = memoryId(c.type, c.name);
    const end = terminal(id, next) ?? id;
    const entry = end === id ? c : byId.get(end);
    if (!entry || placed.has(end)) continue;
    placed.add(end);
    out.push(entry);
  }
  return out;
}
