import * as fs from "fs";
import * as path from "path";
import type { Metadata } from "next";
import { LandingPage } from "./components/LandingPage";
import { BenchSections } from "./components/BenchSections";
import { HomeFooter } from "./components/HomeFooter";
import { Footer } from "./components/Footer";
import { deriveView, type RawBenchmark } from "./data/agent-bench";
import { deriveOptView, type RawOptTask } from "./data/jcode-bench";
import { EMPTY_SIGNALS, type SignalsReport } from "./data/harness-signals";

export const metadata: Metadata = {
  title: "FreeCode",
  description:
    "A harness that is trying to push the frontier of intelligence — and the benchmarks that prove what it does.",
};

const DATA = path.join(process.cwd(), "app", "data");

function readJsonDir<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as T);
}

function readJson<T>(file: string, fallback: T): T {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as T) : fallback;
}

export default function Home() {
  const opt = deriveOptView(readJsonDir<RawOptTask>(path.join(DATA, "jcode-bench")));
  const signals = readJson<SignalsReport>(
    path.join(DATA, "harness", "signals.json"),
    EMPTY_SIGNALS,
  );
  const matchups = readJsonDir<RawBenchmark>(path.join(DATA, "benchmarks"))
    .map(deriveView)
    .filter((v) => v.agents.length >= 2)
    .map((v) => ({
      slug: v.slug,
      title: v.title,
      model: v.model,
      graded: v.graded,
      isolation: v.isolation,
      instances: v.sharedInstances.length,
      agents: v.agents.map((a) => ({
        id: a.id,
        isFreeCode: a.isFreeCode,
        rate: a.rate,
        successes: a.successes,
        trials: a.trials,
        meanTokens: a.meanTokens,
        meanUsd: a.meanUsd,
      })),
      metric: v.metric.label,
    }));

  return (
    <>
      <LandingPage />
      <BenchSections opt={opt} signals={signals} matchups={matchups} />
      <HomeFooter signals={signals} opt={opt} matchupCount={matchups.length} />
      <div className="h-10 w-full flex items-end justify-start px-[max(80px,calc((100vw-1024px)/2))]">
        <span className="text-muted-foreground/50 text-xl md:text-2xl font-mono font-medium tracking-tight ml-8">#Footer</span>
      </div>
      <div className="px-[max(80px,calc((100vw-1024px)/2))] pt-4 pb-12">
        <Footer />
      </div>
    </>
  );
}
