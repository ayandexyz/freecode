// Serve install/uninstall scripts straight from the repo's scripts/ dir
// (single source of truth) instead of fetching raw.githubusercontent.com —
// that fetch is a single point of failure this endpoint shouldn't have.
import { access, readFile } from "node:fs/promises";
import path from "node:path";

// scripts/ sits at the monorepo root, two levels above apps/web. Where the
// function runs from differs by host: local `next start` uses apps/web as
// cwd, but Vercel runs it from the tracing root (the monorepo root, see
// next.config.js), so a fixed `../../` resolved to `/scripts` there and the
// resulting ENOENT surfaced as a bare 404. Walk up until scripts/ appears.
async function findScript(file: string): Promise<string> {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, "scripts", file);
    try {
      await access(candidate);
      return candidate;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error(`scripts/${file} not found above ${process.cwd()}`);
}

export async function serveScript(
  file: string,
  contentType: string,
): Promise<Response> {
  const text = await readFile(await findScript(file), "utf8");
  return new Response(text, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
    },
  });
}
