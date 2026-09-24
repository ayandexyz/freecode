// =============================================================================
// Oracle judge for the memory benches: a perfect reader that keeps exactly the
// gold set. It measures the CEILING a judge can reach without spending money
// per run — never a claim about any real model, which scores somewhere between
// this and the unjudged row.
// =============================================================================

import { memoryId } from "../graph/builder.js";
import { loadCorpus } from "./pool.js";

/**
 * Returns a verdict function `(query, listedPrompt) => raw verdict`. The judge
 * prompt lists candidates as `N. [type] description`; each line is mapped back
 * to its id through the corpus, and the oracle answers in the real format.
 */
export function makeOracle(
  corpus = loadCorpus(),
): (query: string, listed: string) => Promise<string> {
  const goldByQuery = new Map(
    corpus.queries.map((q) => [q.query, new Set(q.relevant)]),
  );
  const idByDescription = new Map(
    corpus.memories.map((m) => [
      `${m.type}|${m.description}`,
      memoryId(m.type, m.name),
    ]),
  );

  return async (query, listed) => {
    const gold = goldByQuery.get(query) ?? new Set<string>();
    const keep: number[] = [];
    for (const line of listed.split("\n")) {
      const m = line.trim().match(/^(\d+)\.\s+\[(\w+)\]\s+(.*)$/);
      if (!m) continue;
      const [, n, type, description] = m;
      const hit = idByDescription.get(`${type}|${description}`);
      if (hit && gold.has(hit)) keep.push(Number(n));
    }
    return JSON.stringify(keep);
  };
}
