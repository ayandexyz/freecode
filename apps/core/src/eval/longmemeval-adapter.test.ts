// =============================================================================
// Hermetic tests for the LongMemEval-S adapter (ROADMAP.md #5). No model
// calls: the converter, the chronological sort, and the answer-leak guard are
// all pure functions. The end-to-end "does ingestion actually feed recall"
// check needs a real model turn and is run separately as a paid smoke test,
// not here.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert";
import {
  parseLongMemEvalSample,
  sessionsChronological,
  renderSessionTranscript,
  assertNoAnswerLeak,
  LongMemEvalAdapterError,
  LONGMEMEVAL_SOURCE,
} from "./longmemeval-adapter.js";

function rawSample(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    question_id: "q1",
    question: "What does the user drink in the morning?",
    question_type: "single-session-user",
    question_date: "2024/03/01",
    answer: "oat milk latte",
    haystack_sessions: [
      {
        session_id: "s2",
        date: "2024/02/10",
        turns: [
          { role: "user", content: "I switched my morning drink recently." },
          { role: "assistant", content: "Noted, what did you switch to?" },
        ],
      },
      {
        session_id: "s1",
        date: "2024/01/05",
        turns: [
          { role: "user", content: "Every morning I have a coffee." },
          { role: "assistant", content: "Good to know." },
        ],
      },
    ],
    answer_session_ids: ["s2"],
    ...overrides,
  };
}

test("parses a well-formed sample", () => {
  const s = parseLongMemEvalSample(rawSample());
  assert.equal(s.question_id, "q1");
  assert.equal(s.answer, "oat milk latte");
  assert.equal(s.haystack_sessions.length, 2);
});

test("coerces a non-string answer field (the known mixed-type schema issue)", () => {
  const s = parseLongMemEvalSample(rawSample({ answer: 42 }));
  assert.equal(s.answer, "42");
});

test("rejects a sample with no question_id", () => {
  const raw = rawSample();
  delete (raw as Record<string, unknown>).question_id;
  assert.throws(() => parseLongMemEvalSample(raw), LongMemEvalAdapterError);
});

test("rejects a haystack turn with an unknown role", () => {
  const raw = rawSample({
    haystack_sessions: [
      {
        session_id: "s1",
        date: "2024/01/01",
        turns: [{ role: "system", content: "x" }],
      },
    ],
  });
  assert.throws(() => parseLongMemEvalSample(raw), LongMemEvalAdapterError);
});

test("sessionsChronological sorts by date regardless of input order", () => {
  const s = parseLongMemEvalSample(rawSample());
  const ordered = sessionsChronological(s);
  assert.deepEqual(
    ordered.map((x) => x.session_id),
    ["s1", "s2"],
  );
});

test("an unparseable date sorts last, not first", () => {
  const raw = rawSample({
    haystack_sessions: [
      { session_id: "good", date: "2024/01/01", turns: [] },
      { session_id: "bad", date: "not-a-date", turns: [] },
    ],
  });
  const s = parseLongMemEvalSample(raw);
  const ordered = sessionsChronological(s);
  assert.deepEqual(
    ordered.map((x) => x.session_id),
    ["good", "bad"],
  );
});

test("renderSessionTranscript renders both roles in order", () => {
  const s = parseLongMemEvalSample(rawSample());
  const [session] = sessionsChronological(s);
  const text = renderSessionTranscript(session);
  assert.equal(
    text,
    "User: Every morning I have a coffee.\nAssistant: Good to know.",
  );
});

test("assertNoAnswerLeak passes when the answer never appears verbatim", () => {
  const s = parseLongMemEvalSample(rawSample());
  assert.doesNotThrow(() =>
    assertNoAnswerLeak("User: Every morning I have a coffee.", s),
  );
});

test("assertNoAnswerLeak throws when the ground truth is embedded verbatim", () => {
  const s = parseLongMemEvalSample(rawSample());
  assert.throws(
    () => assertNoAnswerLeak("The answer is oat milk latte.", s),
    LongMemEvalAdapterError,
  );
});

test("assertNoAnswerLeak is case-insensitive", () => {
  const s = parseLongMemEvalSample(rawSample());
  assert.throws(
    () => assertNoAnswerLeak("OAT MILK LATTE, every day.", s),
    LongMemEvalAdapterError,
  );
});

test("assertNoAnswerLeak skips answers too short to check safely", () => {
  const s = parseLongMemEvalSample(rawSample({ answer: "no" }));
  assert.doesNotThrow(() => assertNoAnswerLeak("no idea what you mean", s));
});

test("the pinned source records a checksum and a non-deprecated split", () => {
  assert.equal(LONGMEMEVAL_SOURCE.license, "mit");
  assert.equal(LONGMEMEVAL_SOURCE.split, "longmemeval_s_cleaned");
  assert.match(LONGMEMEVAL_SOURCE.revisionSha, /^[0-9a-f]{40}$/);
  assert.match(LONGMEMEVAL_SOURCE.fileChecksumSha256, /^[0-9a-f]{64}$/);
});
