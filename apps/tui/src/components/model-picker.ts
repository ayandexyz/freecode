import chalk from "chalk";
import { palette } from "../palette.js";
import type {
  ProviderInfo,
  ProviderStatus,
} from "@thisisayande/freecode-shared";
import type { ModelInfo } from "../ipc/client.js";
import type { MenuRow } from "./menu-card.js";

const UPDATE_CREDENTIAL = "__update_credential__";

/**
 * Right-hand status column.
 *
 * `ready` is the one that matters: an anonymous web session works with nothing
 * on file, so it is green like any configured provider. Only `needs-setup` is
 * an actual blocker, and it is the only entry that reads as one.
 */
function statusLabel(provider: ProviderInfo): string {
  const status: ProviderStatus =
    provider.status ?? (provider.hasApiKey ? "configured" : "needs-setup");
  switch (status) {
    case "ready":
      return palette.green("✓ ready") + chalk.dim(" · anonymous");
    case "signed-in":
      return palette.green("✓ signed in");
    case "configured":
      return palette.green("✓ configured");
    case "needs-setup":
      return "not configured";
  }
}

/** Provider rows for the /model and /web card; the row id is the provider id. */
export function providerRows(providers: ProviderInfo[]): MenuRow[] {
  return providers.map((p) => ({
    id: p.id,
    label: p.name,
    description: p.id,
    status: statusLabel(p),
  }));
}

/** Whether a picked model row is the credential entry rather than a model. */
export function isCredentialRow(row: MenuRow): boolean {
  return row.id === UPDATE_CREDENTIAL;
}

/** Model rows for one provider; the row id is the model id. */
export function modelRows(
  models: ModelInfo[],
  credential?: {
    /** Wording for the entry — "API key" for /model, "cookie" for /web. */
    label: string;
    /** True when nothing is on file yet, so the entry offers rather than replaces. */
    missing: boolean;
  },
): MenuRow[] {
  const rows: MenuRow[] = models.map((m: ModelInfo) => ({
    id: m.id,
    label: m.name || m.id,
    description: m.description || m.id,
  }));

  if (credential) {
    const noun = credential.label;
    const entry: MenuRow = {
      id: UPDATE_CREDENTIAL,
      label: credential.missing ? `Add ${noun}` : `Update ${noun}`,
      description: credential.missing
        ? `Store a ${noun} for this provider`
        : `Replace the saved ${noun} for this provider`,
    };
    // An optional credential that is not on file goes LAST. The cursor starts
    // on the first row, so putting "Add cookie" there makes Enter open a
    // credential prompt when the user came to pick a model — and for an
    // anonymous web session that credential is not even needed. Replacing one
    // that already exists stays first, which is where /model has always put it.
    if (credential.missing) rows.push(entry);
    else rows.unshift(entry);
  }
  return rows;
}
