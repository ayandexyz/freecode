// =============================================================================
// LongMemEval-S external-corpus adapter (ROADMAP.md "Memory: long-horizon
// evaluation" #5). Converts a LongMemEval-cleaned sample into a chronological
// ingestion pass over `extractMemories`, then hands back a scored-question
// prompt with the ground truth kept out of everything the model sees.
//
// This module does NOT download or read the real corpus — it only converts
// already-loaded records. Fetching `longmemeval_s_cleaned.json` and running
// it is ROADMAP #6, deliberately separate ("validate the adapter with tiny
// synthetic fixtures before running the corpus").
// =============================================================================

import { extractMemories } from "../memory/extract.js";
import { priceUsd } from "../providers/pricing.js";
import type { MemoryAuxiliaryObserver } from "../memory/auxiliary.js";

/**
 * Pinned source, checked 2026-09-26 (ROADMAP #5's licence/protocol check).
 * `xiaowu0162/longmemeval` (the original, containing a `longmemeval_s` split)
 * is deprecated by its own maintainer — "removes noisy history sessions that
 * interfere with the answer correctness" — in favor of this cleaned dataset.
 * Re-check `revisionSha` before a real corpus run: a dataset can move without
 * a version bump on Hugging Face.
 */
export const LONGMEMEVAL_SOURCE = {
  dataset: "xiaowu0162/longmemeval-cleaned",
  license: "mit",
  split: "longmemeval_s_cleaned",
  filename: "longmemeval_s_cleaned.json",
  revisionSha: "98d7416c24c778c2fee6e6f3006e7a073259d48f",
  fileChecksumSha256:
    "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
  fileSizeBytes: 277383467,
  officialJudgeModel: "gpt-4o",
} as const;

export interface LongMemEvalTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LongMemEvalHaystackSession {
  session_id: string;
  date: string;
  turns: LongMemEvalTurn[];
}

export interface LongMemEvalSample {
  question_id: string;
  question: string;
  question_type: string;
  question_date: string;
  /** Ground truth. Never pass this into a transcript, prompt, or memory. */
  answer: string;
  haystack_sessions: LongMemEvalHaystackSession[];
  /** Session ids the official answer is grounded in — reference only. */
  answer_session_ids: string[];
}

export class LongMemEvalAdapterError extends Error {}

/**
 * Normalizes a raw JSON record into `LongMemEvalSample`. Defensive against
 * the known schema issue on the Hugging Face card: the `answer` field is
 * mixed-typed across rows (some numeric, some string) and the viewer's own
 * PyArrow conversion fails on it — so it is coerced to a string here rather
 * than assumed.
 */
/**
 * The real `longmemeval_s_cleaned.json` shape (checked against the pinned
 * file, 2026-09-26) is three PARALLEL top-level arrays, not a list of
 * `{session_id, date, turns}` objects: `haystack_sessions[i]` is itself the
 * turn array for session i, matched by index to `haystack_session_ids[i]`
 * and `haystack_dates[i]`. An earlier version of this parser assumed the
 * nested-object shape and would have silently rejected every real record.
 */
export function parseLongMemEvalSample(raw: unknown): LongMemEvalSample {
  if (!raw || typeof raw !== "object") {
    throw new LongMemEvalAdapterError("sample is not an object");
  }
  const r = raw as Record<string, unknown>;
  const question_id = r.question_id;
  const question = r.question;
  const question_type = r.question_type;
  const question_date = r.question_date;
  const answerRaw = r.answer;
  const haystackSessionsRaw = r.haystack_sessions;
  const haystackSessionIdsRaw = r.haystack_session_ids;
  const haystackDatesRaw = r.haystack_dates;
  const answer_session_ids = r.answer_session_ids;

  if (typeof question_id !== "string" || !question_id) {
    throw new LongMemEvalAdapterError("missing question_id");
  }
  if (typeof question !== "string" || !question) {
    throw new LongMemEvalAdapterError(`${question_id}: missing question`);
  }
  if (answerRaw === undefined || answerRaw === null) {
    throw new LongMemEvalAdapterError(`${question_id}: missing answer`);
  }
  if (!Array.isArray(haystackSessionsRaw)) {
    throw new LongMemEvalAdapterError(
      `${question_id}: haystack_sessions must be an array`,
    );
  }
  if (!Array.isArray(haystackSessionIdsRaw) || !Array.isArray(haystackDatesRaw)) {
    throw new LongMemEvalAdapterError(
      `${question_id}: haystack_session_ids and haystack_dates must be arrays`,
    );
  }
  if (
    haystackSessionsRaw.length !== haystackSessionIdsRaw.length ||
    haystackSessionsRaw.length !== haystackDatesRaw.length
  ) {
    throw new LongMemEvalAdapterError(
      `${question_id}: haystack_sessions/haystack_session_ids/haystack_dates length mismatch ` +
        `(${haystackSessionsRaw.length}/${haystackSessionIdsRaw.length}/${haystackDatesRaw.length})`,
    );
  }

  const sessions: LongMemEvalHaystackSession[] = haystackSessionsRaw.map(
    (turnsRaw, i) => {
      const session_id = haystackSessionIdsRaw[i];
      const date = haystackDatesRaw[i];
      if (typeof session_id !== "string" || !session_id) {
        throw new LongMemEvalAdapterError(
          `${question_id}: haystack_session_ids[${i}] is not a non-empty string`,
        );
      }
      if (typeof date !== "string" || !date) {
        throw new LongMemEvalAdapterError(
          `${question_id}: haystack_dates[${i}] is not a non-empty string`,
        );
      }
      if (!Array.isArray(turnsRaw)) {
        throw new LongMemEvalAdapterError(
          `${question_id}: haystack_sessions[${i}] must be an array of turns`,
        );
      }
      const turns: LongMemEvalTurn[] = turnsRaw.map((t, j) => {
        if (!t || typeof t !== "object") {
          throw new LongMemEvalAdapterError(
            `${question_id}: session ${session_id} turn ${j} is not an object`,
          );
        }
        const to = t as Record<string, unknown>;
        const role = to.role;
        const content = to.content;
        if (role !== "user" && role !== "assistant") {
          throw new LongMemEvalAdapterError(
            `${question_id}: session ${session_id} turn ${j} has role ${String(role)}`,
          );
        }
        if (typeof content !== "string") {
          throw new LongMemEvalAdapterError(
            `${question_id}: session ${session_id} turn ${j} content is not a string`,
          );
        }
        return { role, content };
      });
      return { session_id, date, turns };
    },
  );

  return {
    question_id,
    question,
    question_type: typeof question_type === "string" ? question_type : "unknown",
    question_date: typeof question_date === "string" ? question_date : "",
    answer: String(answerRaw),
    haystack_sessions: sessions,
    answer_session_ids: Array.isArray(answer_session_ids)
      ? answer_session_ids.filter((x): x is string => typeof x === "string")
      : [],
  };
}

/**
 * Sessions chronologically, by `date`. LongMemEval's own `haystack_dates`
 * array is documented as parallel to `haystack_sessions`, but "ingest history
 * chronologically" (ROADMAP #5) is load-bearing enough to not trust that
 * without checking — an unparseable date sorts last, never first, so a bad
 * timestamp can't silently jump a session to the front of history.
 */
export function sessionsChronological(
  sample: LongMemEvalSample,
): LongMemEvalHaystackSession[] {
  const withTime = sample.haystack_sessions.map((s) => {
    // Real dates look like "2023/05/30 (Tue) 23:40" — V8 parses that leniently
    // today, but the day-of-week parenthetical is stripped rather than relied
    // on, since nothing pins this to a specific engine.
    const cleaned = s.date.replace(/\s*\([A-Za-z]+\)\s*/, " ");
    const t = Date.parse(cleaned);
    return { s, t: Number.isNaN(t) ? Number.POSITIVE_INFINITY : t };
  });
  withTime.sort((a, b) => a.t - b.t);
  return withTime.map((x) => x.s);
}

/** Plain-text transcript in the shape `extractMemories` expects. */
export function renderSessionTranscript(
  session: LongMemEvalHaystackSession,
): string {
  return session.turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");
}

/**
 * Guards the SCORED QUESTION prompt only — never the haystack. The haystack
 * is where the taught fact legitimately lives (that a session's text
 * contains the answer verbatim is the normal, expected case: it's the
 * source the model is supposed to learn from), so this must never run
 * against `renderSessionTranscript` output. What it catches is the answer,
 * `answer_session_ids`, or other scoring metadata leaking into the question
 * itself — which would trivialize the test rather than measure recall.
 * Advisory, not a proof: a paraphrase ("she only drinks oat milk" vs answer
 * "oat milk") will not trip this. It over-fires on binary-choice questions
 * ("…fixing the fence or trimming the hooves?"), whose answer is one of the
 * options by design — such a question is excluded, not scored.
 */
export function assertNoAnswerLeak(text: string, sample: LongMemEvalSample): void {
  const answer = sample.answer.trim();
  if (answer.length < 3) return; // too short to check without false positives
  if (text.toLowerCase().includes(answer.toLowerCase())) {
    throw new LongMemEvalAdapterError(
      `${sample.question_id}: ground-truth answer leaked into ingested/prompt text`,
    );
  }
}

export interface IngestResult {
  sessionsIngested: number;
  /** null if any session's extraction call was unpriced (never coerced to 0). */
  costUsd: number | null;
  memoriesSavedTotal: number;
}

export interface IngestOptions {
  projectPath: string;
  provider: string;
  model?: string;
}

/**
 * Ingests one sample's haystack, chronologically, directly through
 * `extractMemories` — no live agent turn per session. LongMemEval's haystack
 * is fixed historical dialogue (both roles already said their line); running
 * our own agent "through" it would have it invent fresh replies instead of
 * the recorded ones, which is a different and less faithful experiment than
 * "this memory system had already processed this history." The eventual
 * scored question (not part of this function) is what should run as a real,
 * live turn — that is the part actually being benchmarked.
 */
export async function ingestSampleHaystack(
  sample: LongMemEvalSample,
  options: IngestOptions,
): Promise<IngestResult> {
  const ordered = sessionsChronological(sample);
  let sessionsIngested = 0;
  let memoriesSavedTotal = 0;
  let costUsd = 0;
  let anyUnpriced = false;

  for (const session of ordered) {
    const transcript = renderSessionTranscript(session);
    if (!transcript.trim()) continue;

    const observer: MemoryAuxiliaryObserver = (call) => {
      if (call.purpose !== "extraction") return;
      if (!call.usage) {
        anyUnpriced = true;
        return;
      }
      const price = priceUsd(call.provider, call.model ?? options.model ?? "", {
        inputTokens: call.usage.inputTokens,
        outputTokens: call.usage.outputTokens,
      });
      if (price === undefined) anyUnpriced = true;
      else costUsd += price;
    };

    const saved = await extractMemories({
      transcript,
      projectPath: options.projectPath,
      provider: options.provider,
      model: options.model,
      onAuxiliaryCall: observer,
    });
    memoriesSavedTotal += saved;
    sessionsIngested++;
  }

  return {
    sessionsIngested,
    costUsd: anyUnpriced ? null : costUsd,
    memoriesSavedTotal,
  };
}
