import test from "node:test";
import assert from "node:assert/strict";
import { available, embed, resetEmbedderForTests } from "./embedder.js";

// A stub fastembed module whose init/embed behaviour each test controls.
function stubModule(behaviour: {
  initFails?: () => boolean;
  embedFails?: () => boolean;
}) {
  return async () => ({
    EmbeddingModel: { AllMiniLML6V2: "stub" },
    FlagEmbedding: {
      init: async () => {
        if (behaviour.initFails?.()) throw new Error("download failed");
        return {
          embed: async function* () {
            if (behaviour.embedFails?.()) throw new Error("session failed");
            yield [Float32Array.from([1, 0, 0])];
          },
        };
      },
    },
  });
}

test("a missing native addon latches the embedder off immediately", async () => {
  resetEmbedderForTests(async () => {
    throw new Error("Cannot find module 'onnxruntime-node'");
  });
  await assert.rejects(() => embed("x"));
  assert.equal(
    available(),
    false,
    "an import failure never recovers in-process, so it must latch on sight",
  );
});

test("a transient init failure is retried, not latched", async () => {
  let attempt = 0;
  resetEmbedderForTests(stubModule({ initFails: () => ++attempt === 1 }));

  await assert.rejects(() => embed("x"), /download failed/);
  assert.equal(
    available(),
    true,
    "one download stumble must not disable recall",
  );

  const vec = await embed("x");
  assert.deepEqual(Array.from(vec), [1, 0, 0]);
  assert.equal(available(), true);
});

test("repeated retryable failures still give up", async () => {
  resetEmbedderForTests(stubModule({ initFails: () => true }));

  await assert.rejects(() => embed("x"));
  assert.equal(available(), true);
  await assert.rejects(() => embed("x"));
  assert.equal(available(), true);
  await assert.rejects(() => embed("x"));
  assert.equal(
    available(),
    false,
    "a backend failing every time must stop being retried every turn",
  );
});

test("a success resets the failure count", async () => {
  let fail = true;
  resetEmbedderForTests(stubModule({ embedFails: () => fail }));

  await assert.rejects(() => embed("x"));
  await assert.rejects(() => embed("x"));
  fail = false;
  await embed("x");
  fail = true;
  await assert.rejects(() => embed("x"));
  await assert.rejects(() => embed("x"));
  assert.equal(
    available(),
    true,
    "the count is consecutive failures, so the success must have cleared it",
  );
});

// Leave the module on the real loader for anything that runs after this file.
test.after(() => resetEmbedderForTests());

test("fixed-length padding is turned off once the model loads", async () => {
  // fastembed pads every input to 512 tokens. We embed one text at a time, so
  // padding buys nothing and cost ~150 ms per query on the hot path, blocking
  // the event loop past the 60 ms cold budget (spec 2026-09-25 §4.3). The
  // vectors are identical without it (cosine 1.000000, measured).
  let disabled = 0;
  resetEmbedderForTests(async () => ({
    EmbeddingModel: { AllMiniLML6V2: "stub" },
    FlagEmbedding: {
      init: async () => ({
        tokenizer: { disablePadding: () => void disabled++ },
        embed: async function* () {
          yield [Float32Array.from([1, 0, 0])];
        },
      }),
    },
  }));
  await embed("a");
  await embed("b");
  assert.equal(disabled, 1, "once per model, not per call");
});

test("a model without a reachable tokenizer still embeds", async () => {
  resetEmbedderForTests(stubModule({}));
  assert.deepEqual(Array.from(await embed("x")), [1, 0, 0]);
});
