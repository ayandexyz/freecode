import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // scripts/ lives at the monorepo root, outside this app — the install
  // routes read it directly (see app/lib/serve-script.ts) instead of
  // fetching from GitHub, so make sure it ships in the serverless bundle.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  outputFileTracingIncludes: {
    "/install": ["../../scripts/install.sh"],
    "/install.ps1": ["../../scripts/install.ps1"],
    "/uninstall": ["../../scripts/uninstall.sh"],
  },
};

export default nextConfig;
