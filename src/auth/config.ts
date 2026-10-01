/**
 * Access-control configuration, resolved once at startup so a misconfigured
 * deployment fails fast instead of at the first sign-in attempt.
 */

/** The email domain MCP access is restricted to. */
export const ALLOWED_EMAIL_DOMAIN = process.env.MCP_ALLOWED_EMAIL_DOMAIN ?? "amana.id";

/** Granted to every provisioned user; required on every MCP request. */
export const SCOPE_READ = "mcp:read";

/** Additionally unlocks deliverables marked confidential. Role-gated. */
export const SCOPE_CONFIDENTIAL = "corpus:confidential";

/** Requested by Claude to obtain a refresh token. */
export const SCOPE_OFFLINE = "offline_access";

export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_CONFIDENTIAL, SCOPE_OFFLINE];

/**
 * How the server authenticates callers.
 *
 *   oauth — Google sign-in, restricted to ALLOWED_EMAIL_DOMAIN. The only mode
 *           that can attribute a request to a person.
 *   token — the legacy shared bearer token. Kept for machine callers and for
 *           local development; it cannot enforce the domain restriction,
 *           because a static string carries no identity.
 *   both  — accepts either, so a deployment can migrate without downtime.
 */
export type AuthMode = "oauth" | "token" | "both";

function readAuthMode(googleConfigured: boolean): AuthMode {
  const raw = process.env.MCP_AUTH_MODE?.trim().toLowerCase();
  if (raw === "oauth" || raw === "token" || raw === "both") {
    return raw;
  }
  if (raw) {
    throw new Error(`MCP_AUTH_MODE must be one of oauth, token, both (got ${raw})`);
  }
  // Default to the strongest mode the environment can actually support, so
  // configuring Google is all it takes to close the open-token hole.
  return googleConfigured ? "oauth" : "token";
}

/** Roles whose MCP sessions may read confidential deliverables. */
function readConfidentialRoles(): string[] {
  const raw = process.env.MCP_CONFIDENTIAL_ROLES ?? "admin";
  return raw
    .split(",")
    .map((role) => role.trim().toLowerCase())
    .filter((role) => role.length > 0);
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got ${raw})`);
  }
  return value;
}

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  /** Registered in the Google Cloud OAuth client as an authorised redirect URI. */
  redirectUri: string;
};

export type AuthConfig = {
  mode: AuthMode;
  /** Public origin of this server. Also the OAuth issuer identifier. */
  publicUrl: URL | null;
  /** RFC 8707 resource identifier: the MCP endpoint as clients address it. */
  resourceUrl: URL | null;
  google: GoogleConfig | null;
  staticToken: string | null;
  /** Legacy second token that unlocked confidential documents in token mode. */
  staticPrivilegedToken: string | null;
  confidentialRoles: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
  flowTtlSeconds: number;
};

export function loadAuthConfig(): AuthConfig {
  const googleClientId = process.env.MCP_GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = process.env.MCP_GOOGLE_CLIENT_SECRET?.trim();
  const googleConfigured = Boolean(googleClientId && googleClientSecret);
  const mode = readAuthMode(googleConfigured);

  const publicUrlRaw = process.env.MCP_PUBLIC_URL?.trim();
  let publicUrl: URL | null = null;
  if (publicUrlRaw) {
    publicUrl = new URL(publicUrlRaw.replace(/\/+$/, ""));
    if (publicUrl.pathname !== "/") {
      throw new Error(
        `MCP_PUBLIC_URL must be an origin with no path, so it can serve /.well-known (got ${publicUrlRaw})`,
      );
    }
  }

  const staticToken = process.env.MCP_BEARER_TOKEN?.trim() || null;
  const staticPrivilegedToken = process.env.MCP_BEARER_TOKEN_PRIVILEGED?.trim() || null;

  if (mode !== "token") {
    if (!googleConfigured) {
      throw new Error(
        `MCP_AUTH_MODE=${mode} requires MCP_GOOGLE_CLIENT_ID and MCP_GOOGLE_CLIENT_SECRET`,
      );
    }
    if (!publicUrl) {
      throw new Error(
        `MCP_AUTH_MODE=${mode} requires MCP_PUBLIC_URL, which becomes the OAuth issuer and resource identifier`,
      );
    }
    // Claude, and every other MCP client, refuses a non-HTTPS issuer. Allow
    // http only on loopback so the flow can be exercised locally.
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
    if (publicUrl.protocol !== "https:" && !loopback) {
      throw new Error(`MCP_PUBLIC_URL must be https outside loopback (got ${publicUrl.origin})`);
    }
  }

  if (mode !== "oauth" && !staticToken) {
    throw new Error(`MCP_AUTH_MODE=${mode} requires MCP_BEARER_TOKEN`);
  }

  if (staticToken && staticPrivilegedToken && staticToken === staticPrivilegedToken) {
    throw new Error(
      "MCP_BEARER_TOKEN_PRIVILEGED must differ from MCP_BEARER_TOKEN, " +
        "otherwise every client would be granted confidential access",
    );
  }

  const google: GoogleConfig | null = googleConfigured
    ? {
        clientId: googleClientId!,
        clientSecret: googleClientSecret!,
        redirectUri:
          process.env.MCP_GOOGLE_REDIRECT_URI?.trim() ||
          new URL("/oauth/google/callback", publicUrl ?? "http://localhost").toString(),
      }
    : null;

  return {
    mode,
    publicUrl,
    resourceUrl: publicUrl ? new URL("/mcp", publicUrl) : null,
    google,
    staticToken,
    staticPrivilegedToken,
    confidentialRoles: readConfidentialRoles(),
    accessTokenTtlSeconds: readPositiveInt("MCP_ACCESS_TOKEN_TTL_SECONDS", 3600),
    refreshTokenTtlSeconds: readPositiveInt("MCP_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 3600),
    authorizationCodeTtlSeconds: readPositiveInt("MCP_AUTH_CODE_TTL_SECONDS", 120),
    flowTtlSeconds: readPositiveInt("MCP_AUTH_FLOW_TTL_SECONDS", 900),
  };
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Mirrors isAllowedAmanaEmail in amana-ai-operational/src/lib/auth-domain.ts.
 * The two must agree: this server's whole claim is that an MCP session is no
 * broader than the dashboard session of the same person.
 */
export function isAllowedDomain(email: string | null | undefined): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return normalized.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}
