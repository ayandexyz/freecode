import test from "node:test";
import assert from "node:assert/strict";
import { resolveSupersession } from "./supersession.js";
import type { MemoryEntry } from "../mem-types.js";

function m(name: string, supersedes?: string[]): MemoryEntry {
  return {
    type: "project",
    name,
    description: name,
    content: name,
    createdAt: 0,
    updatedAt: 0,
    ...(supersedes ? { supersedes } : {}),
  };
}

const names = (xs: MemoryEntry[]) => xs.map((e) => e.name);

test("an obsolete candidate is replaced by its replacement, in its place", () => {
  const all = [m("old"), m("new", ["old"]), m("other")];
  const got = resolveSupersession([all[0], all[2]], all);
  assert.deepEqual(names(got), ["new", "other"]);
});

test("obsolete and replacement both retrieved: only the replacement, once", () => {
  const all = [m("old"), m("new", ["old"])];
  assert.deepEqual(names(resolveSupersession([all[0], all[1]], all)), ["new"]);
  assert.deepEqual(names(resolveSupersession([all[1], all[0]], all)), ["new"]);
});

test("a chain resolves to its newest live record", () => {
  const all = [m("v1"), m("v2", ["v1"]), m("v3", ["v2"])];
  assert.deepEqual(names(resolveSupersession([all[0]], all)), ["v3"]);
});

test("a missing supersedes target changes nothing", () => {
  const all = [m("new", ["deleted-long-ago"]), m("other")];
  assert.deepEqual(names(resolveSupersession(all, all)), ["new", "other"]);
});

test("mutual supersession is ambiguous: both stay", () => {
  const all = [m("a", ["b"]), m("b", ["a"])];
  assert.deepEqual(names(resolveSupersession(all, all)), ["a", "b"]);
});

test("a longer cycle is ambiguous too, and terminates", () => {
  const all = [m("a", ["c"]), m("b", ["a"]), m("c", ["b"])];
  assert.deepEqual(names(resolveSupersession([all[0]], all)), ["a"]);
});

test("unrelated candidates pass through untouched", () => {
  const all = [m("x"), m("y")];
  const got = resolveSupersession(all, all);
  assert.equal(got[0], all[0]);
  assert.equal(got[1], all[1]);
});
