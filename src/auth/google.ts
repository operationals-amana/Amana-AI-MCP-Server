import type { GoogleConfig } from "./config.js";
import { ALLOWED_EMAIL_DOMAIN } from "./config.js";

const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Builds the Google sign-in URL for one in-flight authorization.
 *
 * `hd` restricts the account chooser to AMANA's Workspace domain, matching what
 * the dashboard sends. It is a hint to the UI and not a security control —
 * a user can still authenticate elsewhere and arrive here — so the callback
 * re-checks the domain on the claims Google returns.
 */
export function buildGoogleAuthorizeUrl(
  google: GoogleConfig,
  args: { state: string; nonce: string; loginHint?: string },
): string {
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", google.clientId);
  url.searchParams.set("redirect_uri", google.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", args.state);
  url.searchParams.set("nonce", args.nonce);
  url.searchParams.set("hd", ALLOWED_EMAIL_DOMAIN);
  // No refresh token is wanted: this server never calls a Google API on the
  // user's behalf, it only needs the identity assertion from the ID token.
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  if (args.loginHint) {
    url.searchParams.set("login_hint", args.loginHint);
  }
  return url.toString();
}

export type GoogleIdentity = {
  email: string;
  emailVerified: boolean;
  name: string | null;
  /** The Google Workspace domain, present only for Workspace accounts. */
  hostedDomain: string | null;
  nonce: string | null;
  subject: string;
};

type IdTokenClaims = {
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  hd?: string;
  nonce?: string;
  sub?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
};

function decodeIdTokenClaims(idToken: string): IdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("malformed Google ID token");
  }
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as IdTokenClaims;
}

/**
 * Exchanges a Google authorization code for the user's identity.
 *
 * The ID token's signature is deliberately not verified here. OpenID Connect
 * Core 3.1.3.7 allows it: the token came back over a TLS connection this server
 * opened directly to Google's token endpoint, authenticated with the client
 * secret, so there is no third party in a position to have substituted it. What
 * still has to be checked, and is checked below, are the claims — audience,
 * issuer, nonce, expiry — because a token minted for a different client or
 * replayed from an earlier flow would otherwise pass.
 */
export async function exchangeGoogleCode(
  google: GoogleConfig,
  args: { code: string; expectedNonce: string },
): Promise<GoogleIdentity> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: google.clientId,
    client_secret: google.clientSecret,
    redirect_uri: google.redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Google token exchange failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as { id_token?: string };
  if (!payload.id_token) {
    throw new Error("Google token response carried no id_token");
  }

  const claims = decodeIdTokenClaims(payload.id_token);

  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(google.clientId)) {
    throw new Error("Google ID token audience does not match this client");
  }
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw new Error(`unexpected Google ID token issuer: ${claims.iss}`);
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) {
    throw new Error("Google ID token has expired");
  }
  if (claims.nonce !== args.expectedNonce) {
    throw new Error("Google ID token nonce does not match this sign-in");
  }
  if (!claims.email || !claims.sub) {
    throw new Error("Google ID token carried no email");
  }

  return {
    email: claims.email,
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: claims.name ?? null,
    hostedDomain: claims.hd ?? null,
    nonce: claims.nonce ?? null,
    subject: claims.sub,
  };
}
