import test from "node:test";
import assert from "node:assert/strict";
import {
  createStdioTransport,
  createHttpTransport,
  mcpStderrLogPath,
} from "./transport.js";

test("createStdioTransport builds a transport for a local command", () => {
  const transport = createStdioTransport({
    name: "example",
    command: "npx",
    args: ["-y", "@example/server"],
  });
  assert.ok(transport);
});

test("createHttpTransport builds a transport for a valid URL", () => {
  const transport = createHttpTransport({
    url: "https://api.example.com/mcp",
    headers: { Authorization: "Bearer token" },
  });
  assert.ok(transport);
});

test("createHttpTransport rejects an invalid URL", () => {
  assert.throws(() => createHttpTransport({ url: "not-a-url" }));
});

test("mcpStderrLogPath lives under ~/.freecode/logs/mcp and sanitises the name", () => {
  assert.equal(
    mcpStderrLogPath("my/server", "/h"),
    "/h/.freecode/logs/mcp/my_server.log",
  );
});
