import test from "node:test";
import assert from "node:assert/strict";
import {
  ShellRegistry,
  KILL_ESCALATION_MS,
  MAX_SHELLS_PER_SESSION,
  SHELL_BUFFER_CHARS,
} from "./registry.js";
import type { ShellStatus } from "./types.js";

/** Resolve once the shell leaves `running`, so tests never sleep blindly. */
function whenSettled(
  registry: ShellRegistry,
  id: string,
  timeoutMs = 5000,
): Promise<ShellStatus> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const summary = registry.get(id);
      if (summary && summary.status !== "running")
        return resolve(summary.status);
      if (Date.now() > deadline)
        return reject(new Error(`${id} never settled`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("a background shell settles as completed and its output is readable", async () => {
  const registry = new ShellRegistry();
  const shell = registry.start({ command: "echo hello", cwd: process.cwd() });
  assert.equal(shell.status, "running");

  assert.equal(await whenSettled(registry, shell.id), "completed");
  const read = registry.readForModel(shell.id);
  assert.equal(read.found, true);
  assert.match(read.text, /hello/);
  assert.equal(read.exitCode, 0);
  registry.killAll();
});

test("a non-zero exit is reported as failed, with stderr in the buffer", async () => {
  const registry = new ShellRegistry();
  const shell = registry.start({
    command: "echo oops >&2; exit 3",
    cwd: process.cwd(),
  });
  assert.equal(await whenSettled(registry, shell.id), "failed");
  const read = registry.readForModel(shell.id);
  assert.match(read.text, /oops/);
  assert.equal(read.exitCode, 3);
  registry.killAll();
});

test("readForModel returns only new output, never a re-read", async () => {
  const registry = new ShellRegistry();
  const shell = registry.start({ command: "echo one", cwd: process.cwd() });
  await whenSettled(registry, shell.id);

  assert.match(registry.readForModel(shell.id).text, /one/);
  // The whole point of the cursor: a second poll must not re-bill the model
  // for output it has already seen.
  assert.equal(registry.readForModel(shell.id).text, "");
  registry.killAll();
});

test("readFrom is positional and leaves the model's cursor alone", async () => {
  const registry = new ShellRegistry();
  const shell = registry.start({ command: "echo panel", cwd: process.cwd() });
  await whenSettled(registry, shell.id);

  // The TUI panel reads from 0 …
  const panel = registry.readFrom(shell.id, 0);
  assert.match(panel.text, /panel/);
  assert.ok(panel.nextCursor > 0);
  // … and the model still gets its own full copy.
  assert.match(registry.readForModel(shell.id).text, /panel/);
  registry.killAll();
});

test("killing a running shell stops it and flips the status once it exits", async () => {
  const registry = new ShellRegistry();
  const shell = registry.start({ command: "sleep 30", cwd: process.cwd() });
  assert.equal(registry.kill(shell.id), true);
  // The record stays running until the process really exits — a kill is a
  // request, and remove()/killAll() must still be able to see the process.
  assert.equal(registry.get(shell.id)?.status, "running");
  // A kill is already pending: a second one is a no-op rather than an error.
  assert.equal(registry.kill(shell.id), false);
  assert.equal(await whenSettled(registry, shell.id), "killed");
  assert.equal(registry.kill(shell.id), false);
  registry.killAll();
});

test("kill fires the exit notification exactly once, from the real exit", async () => {
  const registry = new ShellRegistry();
  const seen: Array<[string, ShellStatus]> = [];
  const shell = registry.start({
    command: "sleep 30",
    cwd: process.cwd(),
    onExit: (id, status) => seen.push([id, status]),
  });

  registry.kill(shell.id);
  assert.equal(await whenSettled(registry, shell.id), "killed");
  assert.deepEqual(seen, [[shell.id, "killed"]]);

  // And it stays exactly one notification, after the grace timer too.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(seen.length, 1);
  registry.killAll();
});

test("kill escalates to SIGKILL when the process ignores SIGTERM", async () => {
  const registry = new ShellRegistry();
  const seen: ShellStatus[] = [];
  const shell = registry.start({
    command: "trap '' TERM; sleep 30 & wait",
    cwd: process.cwd(),
    onExit: (_id, status) => seen.push(status),
  });
  // Give the trap time to install before signalling.
  await new Promise((r) => setTimeout(r, 200));
  const started = Date.now();
  assert.equal(registry.kill(shell.id), true);
  assert.equal(
    await whenSettled(registry, shell.id, KILL_ESCALATION_MS + 3000),
    "killed",
  );
  const took = Date.now() - started;
  assert.ok(took >= KILL_ESCALATION_MS - 50, `settled too early: ${took}ms`);
  assert.deepEqual(seen, ["killed"]);
  registry.killAll();
});

test("output written just before exit is visible once status is completed", async () => {
  const registry = new ShellRegistry();
  // Settling on `exit` raced the last stdio chunk: a shell could read as
  // completed with its final line missing. Several runs to make a race bite.
  for (let i = 0; i < 5; i++) {
    const shell = registry.start({
      command: `printf 'x%.0s' $(seq 1 20000); printf '\nLAST_LINE\n'; exit 0`,
      cwd: process.cwd(),
    });
    assert.equal(await whenSettled(registry, shell.id), "completed");
    assert.match(registry.readForModel(shell.id).text, /LAST_LINE/);
  }
  registry.killAll();
});

test("disposeOwned takes only the owner's shells, running or settled", async () => {
  const registry = new ShellRegistry();
  const seen: string[] = [];
  const onExit = (id: string): void => {
    seen.push(id);
  };
  const parent = registry.start({
    command: "sleep 30",
    cwd: process.cwd(),
    owner: "root",
    onExit,
  });
  const running = registry.start({
    command: "sleep 30",
    cwd: process.cwd(),
    owner: "agent_1",
    onExit,
  });
  const done = registry.start({
    command: "true",
    cwd: process.cwd(),
    owner: "agent_1",
    onExit,
  });
  await whenSettled(registry, done.id);

  registry.disposeOwned("agent_1");
  assert.deepEqual(seen.sort(), [done.id, running.id].sort());
  assert.deepEqual(
    registry.list().map((s) => s.id),
    [parent.id],
  );
  assert.equal(registry.get(parent.id)?.status, "running");
  registry.killAll();
});

test("killAll notifies for each shell it stops", () => {
  const registry = new ShellRegistry();
  const seen: string[] = [];
  const onExit = (id: string): void => {
    seen.push(id);
  };
  const a = registry.start({ command: "sleep 30", cwd: process.cwd(), onExit });
  const b = registry.start({ command: "sleep 30", cwd: process.cwd(), onExit });
  registry.killAll();
  assert.deepEqual(seen.sort(), [a.id, b.id].sort());
});

test("an unknown id reads as a miss, never a throw", () => {
  const registry = new ShellRegistry();
  const read = registry.readForModel("bash_404");
  assert.equal(read.found, false);
  assert.equal(registry.kill("bash_404"), false);
  assert.equal(registry.get("bash_404"), undefined);
});

test("the per-session shell ceiling is enforced", () => {
  const registry = new ShellRegistry();
  for (let i = 0; i < MAX_SHELLS_PER_SESSION; i++) {
    registry.start({ command: "sleep 30", cwd: process.cwd() });
  }
  assert.throws(
    () => registry.start({ command: "sleep 30", cwd: process.cwd() }),
    /Too many background shells/,
  );
  // A settled shell frees its slot — the cap is on running processes.
  registry.killAll();
  assert.doesNotThrow(() =>
    registry.start({ command: "true", cwd: process.cwd() }),
  );
  registry.killAll();
});

test("killAll leaves nothing running", async () => {
  const registry = new ShellRegistry();
  registry.start({ command: "sleep 30", cwd: process.cwd() });
  registry.start({ command: "sleep 30", cwd: process.cwd() });
  registry.killAll();
  assert.deepEqual(registry.list(), []);
});

test("the ring buffer drops the OLDEST output and reports what it dropped", async () => {
  const registry = new ShellRegistry();
  // Comfortably more than SHELL_BUFFER_CHARS, so the buffer must trim, with a
  // marker at each end to prove WHICH end survived.
  const shell = registry.start({
    command: `printf 'HEAD_MARKER'; printf 'A%.0s' $(seq 1 ${SHELL_BUFFER_CHARS + 50_000}); printf 'TAIL_MARKER'`,
    cwd: process.cwd(),
  });
  await whenSettled(registry, shell.id);

  const read = registry.readForModel(shell.id);
  assert.ok(
    read.droppedChars > 0,
    "a reader starting at 0 must be told the buffer discarded output it will never see",
  );
  // The newest output is what survives — a dev server's latest lines are the
  // ones worth keeping.
  assert.match(read.text, /TAIL_MARKER$/);
  assert.doesNotMatch(read.text, /HEAD_MARKER/);
  registry.killAll();
});

test("remove drops a settled shell from the roster", async () => {
  const registry = new ShellRegistry();
  const shell = registry.start({ command: "echo bye", cwd: process.cwd() });
  await whenSettled(registry, shell.id);

  assert.equal(registry.remove(shell.id), true);
  assert.equal(registry.get(shell.id), undefined);
  assert.deepEqual(registry.list(), []);
  // Its buffered output goes with it — a later read is a miss, not a stale hit.
  assert.equal(registry.readForModel(shell.id).found, false);
  // Removing twice is a no-op, not an error.
  assert.equal(registry.remove(shell.id), false);
});

test("remove refuses a running shell rather than stranding the process", async () => {
  const registry = new ShellRegistry();
  const shell = registry.start({ command: "sleep 30", cwd: process.cwd() });
  // Dropping the record would leak the process: nothing else holds a handle
  // that can kill it.
  assert.equal(registry.remove(shell.id), false);
  assert.equal(registry.get(shell.id)?.status, "running");

  registry.kill(shell.id);
  // Still running until the signal lands — and still refused until then.
  assert.equal(registry.remove(shell.id), false);
  await whenSettled(registry, shell.id);
  assert.equal(registry.remove(shell.id), true);
  registry.killAll();
});

test("removing a settled shell frees its slot under the ceiling", async () => {
  const registry = new ShellRegistry();
  const ids: string[] = [];
  for (let i = 0; i < MAX_SHELLS_PER_SESSION; i++) {
    ids.push(registry.start({ command: "sleep 30", cwd: process.cwd() }).id);
  }
  registry.kill(ids[0]);
  await whenSettled(registry, ids[0]);
  registry.remove(ids[0]);
  assert.doesNotThrow(() =>
    registry.start({ command: "sleep 30", cwd: process.cwd() }),
  );
  registry.killAll();
});
