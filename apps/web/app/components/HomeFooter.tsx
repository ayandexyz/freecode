import type { OptView } from "../data/jcode-bench";
import type { SignalsReport } from "../data/harness-signals";
import { StatTiles, type StatTile } from "./StatTiles";

export interface FooterSummary {
  signals: SignalsReport;
  opt: OptView;
  matchupCount: number;
}

/**
 * The bench footer: stat tiles + the operator reference paragraph. Rendered
 * once at the very bottom of the home page, after every section, so it never
 * lands in the middle of a scroll.
 */
export function HomeFooter({ signals, opt, matchupCount }: FooterSummary) {
  const tiles: StatTile[] = [
    { value: String(signals.sessionsScanned), label: "sessions scanned", note: "rollout logs folded for the signal sections" },
    { value: String(opt.runCount), label: "optimisation runs", note: opt.latest ? `latest ${opt.latest.slice(0, 10)}` : "none yet" },
    { value: String(matchupCount), label: "agent matchups", note: "on /benchmark" },
    {
      value: signals.window.to ? signals.window.to.slice(0, 10) : null,
      label: "signals as of",
      note: signals.window.from ? `since ${signals.window.from.slice(0, 10)}` : undefined,
    },
  ];

  return (
    <footer className="w-full max-w-4xl mx-auto px-6 pb-16 md:pb-24">
      <div className="border-t border-border pt-8 font-mono text-[11px] text-muted-foreground leading-relaxed">
        <StatTiles tiles={tiles} />
        Every harness lives under <code>bench/</code>; the operator reference is{" "}
        <code>HARNESS-BENCH.md</code> at the repo root. The design and its debts are in the spec{" "}
        <code>docs/specs/2026-09-12-harness-bench.md</code>.
      </div>
    </footer>
  );
}
