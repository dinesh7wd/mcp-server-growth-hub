import { config, type Config } from "./config.js";

const G = "https://www.googleapis.com/auth";

export const SCOPES = {
  gsc: `${G}/webmasters.readonly`,
  gscWrite: `${G}/webmasters`,
  indexing: `${G}/indexing`,
  ga4: `${G}/analytics.readonly`,
  driveRead: `${G}/drive.readonly`,
  driveFile: `${G}/drive.file`,
  gmailRead: `${G}/gmail.readonly`,
  gmailCompose: `${G}/gmail.compose`,
  gmailSend: `${G}/gmail.send`,
  ads: `${G}/adwords`,
  gbp: `${G}/business.manage`,
} as const;

/** Broader scopes that also satisfy a capability (e.g. users who consented before scopes were narrowed). */
const SATISFIED_BY: Record<string, string[]> = {
  [SCOPES.gsc]: [`${G}/webmasters`],
  [SCOPES.ga4]: [`${G}/analytics`, `${G}/analytics.edit`],
  [SCOPES.driveRead]: [`${G}/drive`],
  [SCOPES.driveFile]: [`${G}/drive`],
  [SCOPES.gmailRead]: [`${G}/gmail.modify`, "https://mail.google.com/"],
  [SCOPES.gmailCompose]: [`${G}/gmail.modify`, "https://mail.google.com/"],
  [SCOPES.gmailSend]: [`${G}/gmail.compose`, `${G}/gmail.modify`, "https://mail.google.com/"],
};

/** Google scopes requested at login, derived from enabled features. */
export function googleScopes(cfg: Config = config): string[] {
  const scopes = ["openid", "email", SCOPES.gsc, SCOPES.ga4];
  if (cfg.gscSubmitEnabled) scopes.push(SCOPES.gscWrite);
  if (cfg.indexingEnabled) scopes.push(SCOPES.indexing);
  if (cfg.driveEnabled) scopes.push(SCOPES.driveRead, SCOPES.driveFile);
  if (cfg.gmailEnabled) {
    scopes.push(SCOPES.gmailRead, SCOPES.gmailCompose);
    if (cfg.gmailSendEnabled) scopes.push(SCOPES.gmailSend);
  }
  if (cfg.ads.developerToken) scopes.push(SCOPES.ads);
  if (cfg.gbpEnabled) scopes.push(SCOPES.gbp);
  return scopes;
}

export function parseScopes(scope: string | null | undefined): string[] | undefined {
  if (!scope) return undefined;
  return scope.split(/\s+/).filter(Boolean);
}

export function hasScope(granted: string[] | undefined, scope: string): boolean {
  if (!granted) return true;
  return granted.includes(scope) || (SATISFIED_BY[scope] ?? []).some((s) => granted.includes(s));
}

export interface Capabilities {
  gsc: boolean;
  gscSubmit: boolean;
  indexing: boolean;
  ga4: boolean;
  driveRead: boolean;
  driveWrite: boolean;
  gmailRead: boolean;
  gmailCompose: boolean;
  gmailSend: boolean;
  ads: boolean;
  gbp: boolean;
}

/**
 * A tool family is available only when the server is configured for it AND the user granted
 * a sufficient scope. `granted === undefined` (scope unknown) trusts the configuration.
 */
export function capabilities(granted: string[] | undefined, cfg: Config = config): Capabilities {
  return {
    gsc: hasScope(granted, SCOPES.gsc),
    gscSubmit: cfg.gscSubmitEnabled && hasScope(granted, SCOPES.gscWrite),
    indexing: cfg.indexingEnabled && hasScope(granted, SCOPES.indexing),
    ga4: hasScope(granted, SCOPES.ga4),
    driveRead: cfg.driveEnabled && hasScope(granted, SCOPES.driveRead),
    driveWrite: cfg.driveEnabled && hasScope(granted, SCOPES.driveFile),
    gmailRead: cfg.gmailEnabled && hasScope(granted, SCOPES.gmailRead),
    gmailCompose: cfg.gmailEnabled && hasScope(granted, SCOPES.gmailCompose),
    gmailSend: cfg.gmailEnabled && cfg.gmailSendEnabled && hasScope(granted, SCOPES.gmailSend),
    ads: !!cfg.ads.developerToken && hasScope(granted, SCOPES.ads),
    gbp: cfg.gbpEnabled && hasScope(granted, SCOPES.gbp),
  };
}

/** Service scopes the user did not grant at consent time (granular consent). */
export function missingScopes(granted: string[] | undefined, cfg: Config = config): string[] {
  return googleScopes(cfg).filter((s) => s.startsWith("https://") && !hasScope(granted, s));
}
