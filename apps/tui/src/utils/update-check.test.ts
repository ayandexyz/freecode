import assert from "node:assert/strict";
import test from "node:test";
import { checkForUpdate, isNewerVersion } from "./update-check.js";

test("isNewerVersion only fires when there is something newer to move to", () => {
  assert.equal(isNewerVersion("0.39.0", "0.38.0"), true);
  assert.equal(isNewerVersion("1.0.0", "0.38.0"), true);
  assert.equal(isNewerVersion("0.38.1", "0.38.0"), true);
  // Equal, and behind, both stay quiet.
  assert.equal(isNewerVersion("0.38.0", "0.38.0"), false);
  assert.equal(isNewerVersion("0.37.9", "0.38.0"), false);
  // 10 > 9 numerically, where a string compare would say otherwise.
  assert.equal(isNewerVersion("0.10.0", "0.9.0"), true);
  // A prerelease does not advertise itself over its own release.
  assert.equal(isNewerVersion("0.38.0-rc1", "0.38.0"), false);
  // Garbage answers false rather than claiming an update.
  assert.equal(isNewerVersion("", "0.38.0"), false);
});

/** Swap in a fake fetch/env for one case and restore afterwards. */
async function withEnv(
  env: Record<string, string | undefined>,
  fetchImpl: typeof globalThis.fetch | null,
  run: () => Promise<void>,
): Promise<void> {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
  }
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
  }
}

const okResponse = (tag: string) =>
  (async () =>
    ({ ok: true, json: async () => ({ tag_name: tag }) }) as Response) as
    unknown as typeof globalThis.fetch;

test("checkForUpdate reports the newer release", async () => {
  await withEnv(
    { FREECODE_BUNDLED: "1", FREECODE_NO_UPDATE: undefined },
    okResponse("v0.39.0"),
    async () => {
      assert.equal(await checkForUpdate("0.38.0"), "0.39.0");
    },
  );
});

test("checkForUpdate stays quiet when already current", async () => {
  await withEnv(
    { FREECODE_BUNDLED: "1", FREECODE_NO_UPDATE: undefined },
    okResponse("v0.38.0"),
    async () => {
      assert.equal(await checkForUpdate("0.38.0"), null);
    },
  );
});

test("checkForUpdate makes no request when running from source", async () => {
  let called = false;
  const spy = (async () => {
    called = true;
    return { ok: true, json: async () => ({ tag_name: "v9.9.9" }) } as Response;
  }) as unknown as typeof globalThis.fetch;
  await withEnv(
    { FREECODE_BUNDLED: undefined, FREECODE_NO_UPDATE: undefined },
    spy,
    async () => {
      assert.equal(await checkForUpdate("0.38.0"), null);
      assert.equal(called, false, "dev builds must not hit the network");
    },
  );
});

test("FREECODE_NO_UPDATE pins the version and skips the request", async () => {
  let called = false;
  const spy = (async () => {
    called = true;
    return { ok: true, json: async () => ({ tag_name: "v9.9.9" }) } as Response;
  }) as unknown as typeof globalThis.fetch;
  await withEnv({ FREECODE_BUNDLED: "1", FREECODE_NO_UPDATE: "1" }, spy, async () => {
    assert.equal(await checkForUpdate("0.38.0"), null);
    assert.equal(called, false);
  });
});

test("checkForUpdate swallows a failing request", async () => {
  const boom = (async () => {
    throw new Error("offline");
  }) as unknown as typeof globalThis.fetch;
  await withEnv(
    { FREECODE_BUNDLED: "1", FREECODE_NO_UPDATE: undefined },
    boom,
    async () => {
      assert.equal(await checkForUpdate("0.38.0"), null);
    },
  );

  const rateLimited = (async () => ({ ok: false }) as Response) as unknown as
    typeof globalThis.fetch;
  await withEnv(
    { FREECODE_BUNDLED: "1", FREECODE_NO_UPDATE: undefined },
    rateLimited,
    async () => {
      assert.equal(await checkForUpdate("0.38.0"), null);
    },
  );
});
