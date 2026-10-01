import express, { type Request, type Response, type Router } from "express";
import {
  SCOPE_CONFIDENTIAL,
  SCOPE_OFFLINE,
  SCOPE_READ,
  SUPPORTED_SCOPES,
  isAllowedDomain,
  normalizeEmail,
  type AuthConfig,
} from "./config.js";
import { hashToken, randomId, randomToken, secretsMatch, verifyPkce } from "./crypto.js";
import { buildGoogleAuthorizeUrl, exchangeGoogleCode } from "./google.js";
import { errorPage, escapeHtml, htmlPage } from "./html.js";
import { scopesForUser, type DashboardUser } from "./principal.js";
import {
  isLoopbackRedirect,
  isValidRedirectUri,
  matchesRegisteredRedirectUri,
  redirectHost,
} from "./redirect-uri.js";
import * as store from "./store.js";

const ACCESS_TOKEN_PREFIX = "amana_at_";
const REFRESH_TOKEN_PREFIX = "amana_rt_";
const AUTH_CODE_PREFIX = "amana_ac_";
const CLIENT_ID_PREFIX = "amana_client_";
const CLIENT_SECRET_PREFIX = "amana_cs_";

function clientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.ip ?? null;
}

function userAgent(req: Request): string | null {
  const value = req.headers["user-agent"];
  return typeof value === "string" ? value.slice(0, 500) : null;
}

/** Discovery documents are fetched cross-origin by browser-based clients. */
function allowCors(res: Response): void {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "content-type, authorization, mcp-protocol-version");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Max-Age", "86400");
}

function oauthError(
  res: Response,
  status: number,
  error: string,
  description?: string,
): void {
  allowCors(res);
  res.status(status).json({
    error,
    ...(description ? { error_description: description } : {}),
  });
}

/**
 * Sends an OAuth error back to the client's redirect URI.
 *
 * Only safe once client_id and redirect_uri have been validated — redirecting an
 * unvalidated URI would turn this endpoint into an open redirector.
 */
function redirectWithError(
  res: Response,
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): void {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  res.redirect(302, url.toString());
}

function firstValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

/**
 * Narrows the scopes a client asked for to those the signed-in user actually
 * holds. This is where "no broader access than the authenticated AMANA user"
 * becomes mechanical: a client is free to request corpus:confidential, and an
 * analyst's token simply will not carry it.
 *
 * `ceiling` is the scope of the grant being refreshed. OAuth 2.1 forbids a
 * refresh from widening a grant, and it matters here for a reason beyond the
 * spec: the consent screen told the user in plain words whether confidential
 * documents were included, so a later promotion in the dashboard must not
 * quietly turn a session they approved into a wider one. They reconnect, see the
 * screen say something different, and approve that instead.
 */
function grantScopes(
  requested: string | null,
  userScopes: string[],
  ceiling?: string[],
): string[] {
  const asked = (requested ?? "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  const granted = new Set<string>([SCOPE_READ]);
  for (const scope of asked) {
    if (scope === SCOPE_OFFLINE) {
      granted.add(SCOPE_OFFLINE);
      continue;
    }
    if (userScopes.includes(scope)) {
      granted.add(scope);
    }
  }
  // A client that asks for nothing still gets a usable session, and a refresh
  // token, because every MCP client needs one and none of them survive an hour.
  if (asked.length === 0) {
    granted.add(SCOPE_OFFLINE);
  }
  if (ceiling) {
    for (const scope of granted) {
      if (!ceiling.includes(scope)) granted.delete(scope);
    }
  }
  return [...granted];
}

/** RFC 8707: a token is bound to one resource, and this server is the only one. */
function resourceMismatch(config: AuthConfig, requested: string | null): boolean {
  if (!requested || !config.resourceUrl) return false;
  try {
    const url = new URL(requested);
    url.hash = "";
    const expected = new URL(config.resourceUrl.toString());
    expected.hash = "";
    // Trailing-slash differences are not a mismatch anybody means.
    const normalize = (value: string) => value.replace(/\/+$/, "");
    return normalize(url.toString()) !== normalize(expected.toString());
  } catch {
    return true;
  }
}

export type AuthenticatedToken = {
  token: string;
  clientId: string;
  clientName: string | null;
  user: DashboardUser;
  scopes: string[];
  expiresAt: number;
};

/**
 * Verifies an MCP access token and re-resolves the user behind it.
 *
 * The re-resolution matters: scope was frozen when the token was issued, but a
 * person removed from the dashboard must lose MCP access immediately rather than
 * at the next refresh, so a token whose user no longer exists is rejected here.
 * The effective scopes are the intersection of the token's and the user's
 * current role, so a demotion in the dashboard also takes effect at once.
 */
export async function authenticateOAuthToken(
  config: AuthConfig,
  token: string,
): Promise<{ ok: true; auth: AuthenticatedToken } | { ok: false; reason: string }> {
  const record = await store.verifyAccessToken(hashToken(token));
  if (!record) {
    return { ok: false, reason: "token is unknown, expired, or revoked" };
  }
  if (resourceMismatch(config, record.resource)) {
    return { ok: false, reason: "token was issued for a different resource" };
  }
  if (!record.user) {
    return { ok: false, reason: "the user behind this token no longer has an AMANA account" };
  }
  if (!isAllowedDomain(record.user.email)) {
    return { ok: false, reason: "the user behind this token is outside the allowed domain" };
  }

  const tokenScopes = record.scope.split(/\s+/).filter((scope) => scope.length > 0);
  const currentScopes = scopesForUser(record.user, config.confidentialRoles);
  const effective = tokenScopes.filter(
    (scope) => scope === SCOPE_OFFLINE || currentScopes.includes(scope),
  );
  if (!effective.includes(SCOPE_READ)) {
    return { ok: false, reason: "token does not carry the mcp:read scope" };
  }

  return {
    ok: true,
    auth: {
      token,
      clientId: record.clientId,
      clientName: record.clientName,
      user: record.user,
      scopes: effective,
      expiresAt: Math.floor(record.expiresAt.getTime() / 1000),
    },
  };
}

export function protectedResourceMetadataUrl(config: AuthConfig): string {
  // RFC 9728 inserts the well-known segment ahead of the resource's path, so the
  // document for https://host/mcp lives at
  // https://host/.well-known/oauth-protected-resource/mcp.
  return new URL("/.well-known/oauth-protected-resource/mcp", config.publicUrl!).toString();
}

export function createOAuthRouter(config: AuthConfig): Router {
  const router = express.Router();
  const issuer = config.publicUrl!.origin;
  const google = config.google!;

  const authorizationServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 only. RFC 7636 "plain" is no protection at all against an attacker
    // who can read the authorization request.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: SUPPORTED_SCOPES,
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    service_documentation: `${issuer}/`,
  };

  const protectedResourceMetadata = {
    resource: config.resourceUrl!.toString(),
    authorization_servers: [issuer],
    scopes_supported: [SCOPE_READ, SCOPE_CONFIDENTIAL],
    bearer_methods_supported: ["header"],
    resource_name: "AMANA Knowledge",
    resource_documentation: `${issuer}/`,
  };

  router.options(/.*/, (_req, res) => {
    allowCors(res);
    res.status(204).end();
  });

  // -------------------------------------------------------------------------
  // discovery
  // -------------------------------------------------------------------------

  // Both the path-suffixed form (what a client derives from the resource URL)
  // and the bare form (what older clients probe) are served.
  router.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    (_req, res) => {
      allowCors(res);
      res.json(protectedResourceMetadata);
    },
  );

  router.get(
    [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/openid-configuration",
    ],
    (_req, res) => {
      allowCors(res);
      res.json(authorizationServerMetadata);
    },
  );

  // -------------------------------------------------------------------------
  // dynamic client registration (RFC 7591)
  // -------------------------------------------------------------------------
  //
  // Open registration, which is what DCR is for: the registration itself grants
  // nothing. A client that registers still cannot read anything until a real
  // @amana.id person signs in and consents, and the token it then receives
  // carries that person's scopes and no more.

  router.post("/oauth/register", express.json({ limit: "64kb" }), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string")
      : [];
    if (redirectUris.length === 0) {
      oauthError(res, 400, "invalid_redirect_uri", "redirect_uris is required");
      return;
    }
    const invalid = redirectUris.find((uri) => !isValidRedirectUri(uri));
    if (invalid) {
      oauthError(
        res,
        400,
        "invalid_redirect_uri",
        `redirect_uri must be https, or http on loopback: ${invalid}`,
      );
      return;
    }

    const requestedAuthMethod =
      typeof body.token_endpoint_auth_method === "string"
        ? body.token_endpoint_auth_method
        : "none";
    if (!authorizationServerMetadata.token_endpoint_auth_methods_supported.includes(
      requestedAuthMethod,
    )) {
      oauthError(
        res,
        400,
        "invalid_client_metadata",
        `unsupported token_endpoint_auth_method: ${requestedAuthMethod}`,
      );
      return;
    }

    const grantTypes = Array.isArray(body.grant_types)
      ? body.grant_types.filter((value): value is string => typeof value === "string")
      : ["authorization_code", "refresh_token"];
    const unsupportedGrant = grantTypes.find(
      (grant) => !authorizationServerMetadata.grant_types_supported.includes(grant),
    );
    if (unsupportedGrant) {
      oauthError(
        res,
        400,
        "invalid_client_metadata",
        `unsupported grant_type: ${unsupportedGrant}`,
      );
      return;
    }

    const clientId = randomToken(CLIENT_ID_PREFIX);
    const needsSecret = requestedAuthMethod !== "none";
    const clientSecret = needsSecret ? randomToken(CLIENT_SECRET_PREFIX) : null;
    const clientName =
      typeof body.client_name === "string" ? body.client_name.slice(0, 200) : null;

    await store.insertClient({
      clientId,
      clientSecretHash: clientSecret ? hashToken(clientSecret) : null,
      clientName,
      redirectUris,
      grantTypes,
      responseTypes: ["code"],
      tokenEndpointAuthMethod: requestedAuthMethod,
      scope: typeof body.scope === "string" ? body.scope : null,
      clientUri: typeof body.client_uri === "string" ? body.client_uri : null,
      softwareId: typeof body.software_id === "string" ? body.software_id : null,
      softwareVersion: typeof body.software_version === "string" ? body.software_version : null,
      metadata: body,
    });

    void store.recordAuthEvent({
      event: "client_registered",
      clientId,
      clientName,
      ip: clientIp(req),
      userAgent: userAgent(req),
      detail: { redirectUris, tokenEndpointAuthMethod: requestedAuthMethod },
    });

    allowCors(res);
    res.status(201).json({
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: requestedAuthMethod,
      scope: [SCOPE_READ, SCOPE_CONFIDENTIAL, SCOPE_OFFLINE].join(" "),
    });
  });

  // -------------------------------------------------------------------------
  // authorization
  // -------------------------------------------------------------------------

  router.get("/oauth/authorize", async (req, res) => {
    const clientId = firstValue(req.query.client_id);
    const redirectUri = firstValue(req.query.redirect_uri);
    const state = firstValue(req.query.state);
    const responseType = firstValue(req.query.response_type);
    const codeChallenge = firstValue(req.query.code_challenge);
    const codeChallengeMethod = firstValue(req.query.code_challenge_method);
    const scope = firstValue(req.query.scope);
    const resource = firstValue(req.query.resource);

    if (!clientId) {
      res.status(400).type("html").send(
        errorPage("Invalid request", "The authorization request carried no client_id."),
      );
      return;
    }

    const client = await store.findClient(clientId);
    if (!client) {
      res.status(400).type("html").send(
        errorPage(
          "Unknown client",
          "This client is not registered with the AMANA knowledge server.",
          "If you are reconnecting an existing connector, remove it and add it again so it registers afresh.",
        ),
      );
      return;
    }

    if (!redirectUri || !matchesRegisteredRedirectUri(redirectUri, client.redirectUris)) {
      // Deliberately not redirected: bouncing to an unregistered URI is how an
      // authorization server becomes an open redirector.
      res.status(400).type("html").send(
        errorPage(
          "Invalid redirect URI",
          "The redirect_uri does not match one registered by this client.",
        ),
      );
      return;
    }

    if (responseType !== "code") {
      redirectWithError(
        res,
        redirectUri,
        "unsupported_response_type",
        "only response_type=code is supported",
        state,
      );
      return;
    }
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      redirectWithError(
        res,
        redirectUri,
        "invalid_request",
        "PKCE with code_challenge_method=S256 is required",
        state,
      );
      return;
    }
    if (resourceMismatch(config, resource)) {
      redirectWithError(
        res,
        redirectUri,
        "invalid_target",
        `this authorization server only issues tokens for ${config.resourceUrl!.toString()}`,
        state,
      );
      return;
    }

    const flowId = randomToken("");
    const nonce = randomId();
    await store.insertFlow({
      id: flowId,
      clientId,
      redirectUri,
      clientState: state,
      codeChallenge,
      codeChallengeMethod,
      scope: scope ?? "",
      resource: resource ?? config.resourceUrl!.toString(),
      googleNonce: nonce,
      ttlSeconds: config.flowTtlSeconds,
    });

    void store.recordAuthEvent({
      event: "sign_in_started",
      clientId,
      clientName: client.clientName,
      ip: clientIp(req),
      userAgent: userAgent(req),
      detail: { redirectUri, scope },
    });

    res.redirect(
      302,
      buildGoogleAuthorizeUrl(google, {
        state: flowId,
        nonce,
        loginHint: firstValue(req.query.login_hint) ?? undefined,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Google callback
  // -------------------------------------------------------------------------

  router.get("/oauth/google/callback", async (req, res) => {
    const flowId = firstValue(req.query.state);
    const code = firstValue(req.query.code);
    const googleError = firstValue(req.query.error);

    if (!flowId) {
      res.status(400).type("html").send(
        errorPage("Sign-in could not be completed", "The sign-in response carried no state."),
      );
      return;
    }

    const flow = await store.findFlow(flowId);
    if (!flow) {
      res.status(400).type("html").send(
        errorPage(
          "Sign-in expired",
          "This sign-in took too long, or has already been completed.",
          "Start the connection again from Claude.",
        ),
      );
      return;
    }

    if (googleError || !code) {
      void store.recordAuthEvent({
        event: "consent_denied",
        clientId: flow.clientId,
        ip: clientIp(req),
        userAgent: userAgent(req),
        detail: { stage: "google", googleError },
      });
      await store.deleteFlow(flowId);
      redirectWithError(
        res,
        flow.redirectUri,
        "access_denied",
        googleError ?? "Google sign-in was not completed",
        flow.clientState,
      );
      return;
    }

    let identity;
    try {
      identity = await exchangeGoogleCode(google, { code, expectedNonce: flow.googleNonce });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({ ts: new Date().toISOString(), msg: "google_exchange_failed", error: message }),
      );
      void store.recordAuthEvent({
        event: "domain_rejected",
        clientId: flow.clientId,
        ip: clientIp(req),
        userAgent: userAgent(req),
        detail: { reason: "google_exchange_failed", error: message },
      });
      await store.deleteFlow(flowId);
      redirectWithError(
        res,
        flow.redirectUri,
        "access_denied",
        "Google sign-in could not be verified",
        flow.clientState,
      );
      return;
    }

    const email = normalizeEmail(identity.email);
    const ip = clientIp(req);
    const agent = userAgent(req);

    // Three independent checks, all of which must hold. The hosted-domain claim
    // is the one that cannot be spoofed by a personal Gmail account whose
    // address merely ends in the right string.
    const domainOk =
      isAllowedDomain(email) &&
      identity.emailVerified &&
      (identity.hostedDomain === null || isAllowedDomain(`x@${identity.hostedDomain}`));

    if (!domainOk) {
      void store.recordAuthEvent({
        event: "domain_rejected",
        email,
        clientId: flow.clientId,
        clientName: flow.clientName,
        ip,
        userAgent: agent,
        detail: {
          emailVerified: identity.emailVerified,
          hostedDomain: identity.hostedDomain,
        },
      });
      await store.deleteFlow(flowId);
      res.status(403).type("html").send(
        errorPage(
          "Account not permitted",
          "The AMANA knowledge server is only available to AMANA staff signing in with their @amana.id Google account.",
          email ? `You signed in as ${email}.` : undefined,
        ),
      );
      return;
    }

    const user = await store.lookupUser(email!);
    if (!user) {
      void store.recordAuthEvent({
        event: "not_provisioned",
        email,
        clientId: flow.clientId,
        clientName: flow.clientName,
        ip,
        userAgent: agent,
      });
      await store.deleteFlow(flowId);
      res.status(403).type("html").send(
        errorPage(
          "No AMANA account yet",
          `${email} has an @amana.id address but no AMANA account, so there is no set of permissions to apply.`,
          "Sign in to the AMANA dashboard once to create your account, then connect again.",
        ),
      );
      return;
    }

    const updated = await store.attachIdentityToFlow(flowId, user);
    if (!updated) {
      res.status(400).type("html").send(
        errorPage(
          "Sign-in expired",
          "This sign-in has already been completed.",
          "Start the connection again from Claude.",
        ),
      );
      return;
    }

    void store.recordAuthEvent({
      event: "sign_in_succeeded",
      email: user.email,
      userId: user.id,
      clientId: flow.clientId,
      clientName: flow.clientName,
      ip,
      userAgent: agent,
      detail: { role: user.role },
    });

    res.type("html").send(renderConsentPage(config, flow, user));
  });

  // -------------------------------------------------------------------------
  // consent
  // -------------------------------------------------------------------------
  //
  // The MCP authorization spec requires the user to be shown the redirect URI's
  // hostname before a code is issued, with an extra warning for loopback
  // redirects, because any local process can bind a port and claim to be the
  // client. Google's own screen cannot carry that, so it lives here.

  router.post("/oauth/consent", express.urlencoded({ extended: false }), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const flowId = typeof body.flow === "string" ? body.flow : null;
    const decision = typeof body.decision === "string" ? body.decision : null;

    if (!flowId) {
      res.status(400).type("html").send(errorPage("Invalid request", "No sign-in was identified."));
      return;
    }

    const flow = await store.findFlow(flowId);
    if (!flow || flow.stage !== "awaiting_consent" || !flow.userEmail) {
      res.status(400).type("html").send(
        errorPage(
          "Sign-in expired",
          "This sign-in has expired or has already been completed.",
          "Start the connection again from Claude.",
        ),
      );
      return;
    }

    if (decision !== "approve") {
      void store.recordAuthEvent({
        event: "consent_denied",
        email: flow.userEmail,
        userId: flow.userId,
        clientId: flow.clientId,
        ip: clientIp(req),
        userAgent: userAgent(req),
      });
      await store.deleteFlow(flowId);
      redirectWithError(
        res,
        flow.redirectUri,
        "access_denied",
        "the user declined the request",
        flow.clientState,
      );
      return;
    }

    // Re-resolved rather than trusted from the flow row, so a dashboard change
    // made during the consent step is reflected in the scopes issued.
    const user = await store.lookupUser(flow.userEmail);
    if (!user) {
      await store.deleteFlow(flowId);
      res.status(403).type("html").send(
        errorPage("No AMANA account", "This account no longer has access to AMANA systems."),
      );
      return;
    }

    const code = randomToken(AUTH_CODE_PREFIX);
    const issued = await store.consumeFlowAndIssueCode({
      flowId,
      codeHash: hashToken(code),
      user,
      ttlSeconds: config.authorizationCodeTtlSeconds,
    });
    if (!issued) {
      res.status(400).type("html").send(
        errorPage("Sign-in expired", "This sign-in has already been completed."),
      );
      return;
    }

    void store.recordAuthEvent({
      event: "consent_granted",
      email: user.email,
      userId: user.id,
      clientId: flow.clientId,
      clientName: flow.clientName,
      ip: clientIp(req),
      userAgent: userAgent(req),
      detail: { redirectHost: redirectHost(flow.redirectUri) },
    });

    const target = new URL(flow.redirectUri);
    target.searchParams.set("code", code);
    if (flow.clientState) target.searchParams.set("state", flow.clientState);
    res.redirect(302, target.toString());
  });

  // -------------------------------------------------------------------------
  // token
  // -------------------------------------------------------------------------

  router.post(
    "/oauth/token",
    // RFC 6749 requires form encoding here, and Claude sends it for both the
    // initial exchange and every refresh. The json parser mounted on /oauth/register
    // would answer 415.
    express.urlencoded({ extended: false }),
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const grantType = typeof body.grant_type === "string" ? body.grant_type : null;

      const auth = await authenticateClient(req, body);
      if (!auth.ok) {
        allowCors(res);
        if (auth.status === 401) {
          res.set("WWW-Authenticate", 'Basic realm="amana-mcp"');
        }
        res.status(auth.status).json({ error: auth.error, error_description: auth.description });
        return;
      }
      const client = auth.client;

      if (grantType === "authorization_code") {
        await handleAuthorizationCodeGrant(req, res, client, body);
        return;
      }
      if (grantType === "refresh_token") {
        await handleRefreshGrant(req, res, client, body);
        return;
      }
      oauthError(
        res,
        400,
        "unsupported_grant_type",
        `grant_type must be authorization_code or refresh_token (got ${grantType ?? "nothing"})`,
      );
    },
  );

  // -------------------------------------------------------------------------
  // revocation (RFC 7009)
  // -------------------------------------------------------------------------

  router.post("/oauth/revoke", express.urlencoded({ extended: false }), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token : null;
    if (!token) {
      oauthError(res, 400, "invalid_request", "token is required");
      return;
    }

    // RFC 7009 requires the client to identify itself, and the revocation is
    // scoped to its own tokens: without that, anyone who caught sight of a token
    // in a log could revoke somebody else's session.
    const auth = await authenticateClient(req, body);
    if (!auth.ok) {
      allowCors(res);
      res.status(auth.status).json({ error: auth.error, error_description: auth.description });
      return;
    }

    const revoked = await store.revokeToken(hashToken(token), auth.client.clientId);
    if (revoked) {
      void store.recordAuthEvent({
        event: "token_revoked",
        clientId: auth.client.clientId,
        clientName: auth.client.clientName,
        ip: clientIp(req),
        userAgent: userAgent(req),
      });
    }
    // RFC 7009: an unknown token is still a success, so a caller cannot use this
    // endpoint to test whether a token exists.
    allowCors(res);
    res.status(200).end();
  });

  // -------------------------------------------------------------------------
  // helpers closed over config
  // -------------------------------------------------------------------------

  type ClientAuthResult =
    | { ok: true; client: store.OAuthClient }
    | { ok: false; status: number; error: string; description: string };

  async function authenticateClient(
    req: Request,
    body: Record<string, unknown>,
  ): Promise<ClientAuthResult> {
    let clientId = typeof body.client_id === "string" ? body.client_id : null;
    let clientSecret = typeof body.client_secret === "string" ? body.client_secret : null;

    const header = req.headers.authorization;
    if (typeof header === "string" && header.toLowerCase().startsWith("basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        clientId = decodeURIComponent(decoded.slice(0, separator));
        clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      }
    }

    if (!clientId) {
      return {
        ok: false,
        status: 401,
        error: "invalid_client",
        description: "client_id is required",
      };
    }

    const client = await store.findClient(clientId);
    if (!client) {
      return { ok: false, status: 401, error: "invalid_client", description: "unknown client" };
    }

    if (client.clientSecretHash) {
      if (!clientSecret || !secretsMatch(hashToken(clientSecret), client.clientSecretHash)) {
        return {
          ok: false,
          status: 401,
          error: "invalid_client",
          description: "client authentication failed",
        };
      }
    }

    return { ok: true, client };
  }

  async function handleAuthorizationCodeGrant(
    req: Request,
    res: Response,
    client: store.OAuthClient,
    body: Record<string, unknown>,
  ): Promise<void> {
    const code = typeof body.code === "string" ? body.code : null;
    const verifier = typeof body.code_verifier === "string" ? body.code_verifier : null;
    const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : null;

    if (!code || !verifier) {
      oauthError(res, 400, "invalid_request", "code and code_verifier are required");
      return;
    }

    const record = await store.redeemAuthorizationCode(hashToken(code));
    if (!record) {
      oauthError(res, 400, "invalid_grant", "authorization code is unknown, expired, or used");
      return;
    }
    if (record.clientId !== client.clientId) {
      oauthError(res, 400, "invalid_grant", "authorization code was issued to another client");
      return;
    }
    if (redirectUri && redirectUri !== record.redirectUri) {
      oauthError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request");
      return;
    }
    if (!verifyPkce(verifier, record.codeChallenge)) {
      oauthError(res, 400, "invalid_grant", "PKCE verification failed");
      return;
    }

    const user = await store.lookupUser(record.userEmail);
    if (!user) {
      oauthError(res, 400, "invalid_grant", "the user is no longer provisioned for AMANA systems");
      return;
    }

    const granted = grantScopes(record.scope, scopesForUser(user, config.confidentialRoles));
    const tokens = await issueTokens({
      clientId: client.clientId,
      user,
      scopes: granted,
      resource: record.resource,
    });

    void store.touchClient(client.clientId);
    void store.recordAuthEvent({
      event: "token_issued",
      email: user.email,
      userId: user.id,
      clientId: client.clientId,
      clientName: client.clientName,
      ip: clientIp(req),
      userAgent: userAgent(req),
      detail: { scope: granted.join(" "), role: user.role },
    });

    allowCors(res);
    res.set("Cache-Control", "no-store");
    res.json(tokens);
  }

  async function handleRefreshGrant(
    req: Request,
    res: Response,
    client: store.OAuthClient,
    body: Record<string, unknown>,
  ): Promise<void> {
    const presented = typeof body.refresh_token === "string" ? body.refresh_token : null;
    if (!presented) {
      oauthError(res, 400, "invalid_request", "refresh_token is required");
      return;
    }

    const record = await store.findRefreshToken(hashToken(presented));
    if (!record) {
      oauthError(res, 400, "invalid_grant", "refresh token is unknown");
      return;
    }
    if (record.clientId !== client.clientId) {
      oauthError(res, 400, "invalid_grant", "refresh token was issued to another client");
      return;
    }

    if (record.rotatedTo) {
      // The token was already exchanged. Either the client lost the successor
      // and retried, or somebody else is replaying a stolen token; there is no
      // way to tell which, so OAuth 2.1 says drop the whole family.
      await store.revokeTokenFamily(record.clientId, record.userId);
      void store.recordAuthEvent({
        event: "refresh_replay_detected",
        email: record.userEmail,
        userId: record.userId,
        clientId: client.clientId,
        clientName: client.clientName,
        ip: clientIp(req),
        userAgent: userAgent(req),
      });
      oauthError(res, 400, "invalid_grant", "refresh token has already been used");
      return;
    }
    if (record.revoked || record.expired) {
      oauthError(res, 400, "invalid_grant", "refresh token is expired or revoked");
      return;
    }

    const user = await store.lookupUser(record.userEmail);
    if (!user) {
      oauthError(res, 400, "invalid_grant", "the user is no longer provisioned for AMANA systems");
      return;
    }

    // Re-derived from the current role, so a demotion in the dashboard narrows
    // the session at its next refresh even though the old token said otherwise —
    // but bounded by the original grant, so it can only ever narrow.
    const requested = typeof body.scope === "string" ? body.scope : record.scope;
    const granted = grantScopes(
      requested,
      scopesForUser(user, config.confidentialRoles),
      record.scope.split(/\s+/).filter((scope) => scope.length > 0),
    );

    const tokens = await issueTokens({
      clientId: client.clientId,
      user,
      scopes: granted,
      resource: record.resource,
      rotatedFromHash: hashToken(presented),
    });

    void store.recordAuthEvent({
      event: "token_refreshed",
      email: user.email,
      userId: user.id,
      clientId: client.clientId,
      clientName: client.clientName,
      ip: clientIp(req),
      userAgent: userAgent(req),
      detail: { scope: granted.join(" ") },
    });

    allowCors(res);
    res.set("Cache-Control", "no-store");
    res.json(tokens);
  }

  async function issueTokens(args: {
    clientId: string;
    user: DashboardUser;
    scopes: string[];
    resource: string | null;
    rotatedFromHash?: string;
  }) {
    const accessToken = randomToken(ACCESS_TOKEN_PREFIX);
    const withRefresh = args.scopes.includes(SCOPE_OFFLINE);
    const refreshToken = withRefresh ? randomToken(REFRESH_TOKEN_PREFIX) : null;

    await store.insertTokenPair({
      accessTokenHash: hashToken(accessToken),
      refreshTokenHash: refreshToken ? hashToken(refreshToken) : null,
      clientId: args.clientId,
      userId: args.user.id,
      userEmail: args.user.email,
      scope: args.scopes.join(" "),
      resource: args.resource,
      accessTtlSeconds: config.accessTokenTtlSeconds,
      refreshTtlSeconds: config.refreshTokenTtlSeconds,
      rotatedFromHash: args.rotatedFromHash,
    });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: config.accessTokenTtlSeconds,
      scope: args.scopes.join(" "),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  return router;
}

function renderConsentPage(
  config: AuthConfig,
  flow: store.OAuthFlow,
  user: DashboardUser,
): string {
  const host = redirectHost(flow.redirectUri);
  const clientLabel = flow.clientName ?? "An MCP client";
  const scopes = scopesForUser(user, config.confidentialRoles);
  const confidential = scopes.includes(SCOPE_CONFIDENTIAL);

  return htmlPage(
    "Connect to AMANA Knowledge",
    `<h1>Connect to AMANA Knowledge</h1>
     <p class="muted">${escapeHtml(clientLabel)} is asking to search AMANA's institutional
       knowledge as you.</p>
     <dl>
       <dt>Signed in as</dt><dd>${escapeHtml(user.email)}</dd>
       <dt>Your role</dt><dd>${escapeHtml(user.role)}</dd>
       <dt>Will send data to</dt><dd>${escapeHtml(host)}</dd>
     </dl>
     <p>It will be able to:</p>
     <ul>
       <li>Search deliverables, past projects, the talent roster, partners and internal knowledge</li>
       <li>Read the full text of any record it finds</li>
       ${
         confidential
           ? "<li>Read deliverables marked <strong>confidential</strong>, because your role allows it</li>"
           : "<li>It will <strong>not</strong> be able to read deliverables marked confidential</li>"
       }
     </ul>
     <p class="muted">It cannot change anything. Every search it runs is logged against your name.</p>
     ${
       isLoopbackRedirect(flow.redirectUri)
         ? `<p class="warn">This connection sends data to <code>${escapeHtml(host)}</code>, a program
             running on your own computer. Any local program can claim that address, so only continue
             if you started this yourself.</p>`
         : ""
     }
     <form method="post" action="/oauth/consent">
       <input type="hidden" name="flow" value="${escapeHtml(flow.id)}">
       <div class="actions">
         <button class="secondary" type="submit" name="decision" value="deny">Cancel</button>
         <button class="primary" type="submit" name="decision" value="approve">Connect</button>
       </div>
     </form>`,
  );
}
