/**
 * Feature flags (PLAN §14.4). Production default: everything risky is OFF until approved.
 * Read from environment so ops can flip them without a deploy; org settings may narrow further.
 */
export interface FeatureFlags {
  billing: boolean;
  reportPublishing: boolean;
  externalIntegrations: boolean;
  referrals: boolean;
  devLogin: boolean;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export function readFlags(env: Record<string, string | undefined> = process.env): FeatureFlags {
  const isProd = env.NODE_ENV === "production";
  return {
    billing: bool(env.FEATURE_BILLING, false),
    reportPublishing: bool(env.FEATURE_REPORT_PUBLISHING, !isProd),
    externalIntegrations: bool(env.FEATURE_EXTERNAL_INTEGRATIONS, false),
    referrals: bool(env.FEATURE_REFERRALS, false),
    // Dev login is hard-disabled in production regardless of env.
    devLogin: !isProd && bool(env.DEV_LOGIN_ENABLED, false),
  };
}
