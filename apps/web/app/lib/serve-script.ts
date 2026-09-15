// Serve install/uninstall scripts straight from the repo's scripts/ dir
// (single source of truth) instead of fetching raw.githubusercontent.com —
// that fetch is a single point of failure this endpoint shouldn't have.
import { readFile } from "node:fs/promises";
import path from "node:path";

const SCRIPTS_DIR = path.join(process.cwd(), "../../scripts");

export async function serveScript(
  file: string,
  contentType: string,
): Promise<Response> {
  const text = await readFile(path.join(SCRIPTS_DIR, file), "utf8");
  return new Response(text, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
    },
  });
}
