// =============================================================================
// Trace cost — includes foreground turns and separately-recorded memory calls.
// =============================================================================

import { totalUsd } from "../providers/pricing.js";
import type { Trace } from "./trace.js";

/**
 * Prices every provider call a trace records. An auxiliary event can lack its
 * resolved model (older logs and failed calls); retain it as an unpriceable
 * placeholder so a partial total remains visibly partial instead of silently
 * omitting that call.
 */
export function traceCost(trace: Trace) {
  return totalUsd([
    ...trace.modelSpans,
    ...trace.auxiliarySpans.map((span) => ({
      ...span,
      model: span.model ?? "__unresolved_memory_model__",
    })),
  ]);
}
