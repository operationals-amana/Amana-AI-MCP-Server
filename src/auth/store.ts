import { pool } from "../db.js";
import type { DashboardUser } from "./principal.js";

// ---------------------------------------------------------------------------
// clients
// ---------------------------------------------------------------------------

export type OAuthClient = {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string | null;
};

type ClientRow = {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope: string | null;
};

function toClient(row: ClientRow): OAuthClient {
  return {
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    grantTypes: row.grant_types,
    responseTypes: row.response_types,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    scope: row.scope,
  };
}

export async function insertClient(client: {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string | null;
  clientUri: string | null;
  softwareId: string | null;
  softwareVersion: string | null;
  metadata: unknown;
}): Promise<void> {
  await pool.query(
    `INSERT INTO public.mcp_oauth_client
       (client_id, client_secret_hash, client_name, redirect_uris, grant_types,
        response_types, token_endpoint_auth_method, scope, client_uri,
        software_id, software_version, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      client.clientId,
      client.clientSecretHash,
      client.clientName,
      client.redirectUris,
      client.grantTypes,
      client.responseTypes,
      client.tokenEndpointAuthMethod,
      client.scope,
      client.clientUri,
      client.softwareId,
      client.softwareVersion,
      JSON.stringify(client.metadata ?? {}),
    ],
  );
}

export async function findClient(clientId: string): Promise<OAuthClient | null> {
  const { rows } = await pool.query<ClientRow>(
    `SELECT client_id, client_secret_hash, client_name, redirect_uris, grant_types,
            response_types, token_endpoint_auth_method, scope
     FROM public.mcp_oauth_client WHERE client_id = $1`,
    [clientId],
  );
  return rows[0] ? toClient(rows[0]) : null;
}

export async function touchClient(clientId: string): Promise<void> {
  await pool.query(`UPDATE public.mcp_oauth_client SET last_used_at = now() WHERE client_id = $1`, [
    clientId,
  ]);
}

// ---------------------------------------------------------------------------
// authorization flows
// ---------------------------------------------------------------------------

export type OAuthFlow = {
  id: string;
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  clientState: string | null;
  codeChallenge: string;
  scope: string;
  resource: string | null;
  stage: "awaiting_google" | "awaiting_consent" | "consumed";
  googleNonce: string;
  userId: string | null;
  userEmail: string | null;
};

type FlowRow = {
  id: string;
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
  client_state: string | null;
  code_challenge: string;
  scope: string;
  resource: string | null;
  stage: OAuthFlow["stage"];
  google_nonce: string;
  user_id: string | null;
  user_email: string | null;
};

function toFlow(row: FlowRow): OAuthFlow {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUri: row.redirect_uri,
    clientState: row.client_state,
    codeChallenge: row.code_challenge,
    scope: row.scope,
    resource: row.resource,
    stage: row.stage,
    googleNonce: row.google_nonce,
    userId: row.user_id,
    userEmail: row.user_email,
  };
}

export async function insertFlow(flow: {
  id: string;
  clientId: string;
  redirectUri: string;
  clientState: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string | null;
  googleNonce: string;
  ttlSeconds: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO public.mcp_oauth_flow
       (id, client_id, redirect_uri, client_state, code_challenge,
        code_challenge_method, scope, resource, google_nonce, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))`,
    [
      flow.id,
      flow.clientId,
      flow.redirectUri,
      flow.clientState,
      flow.codeChallenge,
      flow.codeChallengeMethod,
      flow.scope,
      flow.resource,
      flow.googleNonce,
      flow.ttlSeconds,
    ],
  );
}

/**
 * Records the Google-verified identity on a flow and moves it to
 * awaiting_consent.
 *
 * The stage guard is the replay defence: a Google callback delivered twice
 * matches the WHERE clause only the first time, so the second attempt cannot
 * restart a completed login.
 */
export async function attachIdentityToFlow(
  flowId: string,
  user: DashboardUser,
): Promise<OAuthFlow | null> {
  const { rows } = await pool.query<FlowRow>(
    `UPDATE public.mcp_oauth_flow f
     SET stage = 'awaiting_consent', user_id = $2, user_email = $3
     WHERE f.id = $1 AND f.stage = 'awaiting_google' AND f.expires_at > now()
     RETURNING f.id, f.client_id,
               (SELECT c.client_name FROM public.mcp_oauth_client c
                 WHERE c.client_id = f.client_id) AS client_name,
               f.redirect_uri, f.client_state, f.code_challenge, f.scope,
               f.resource, f.stage, f.google_nonce, f.user_id, f.user_email`,
    [flowId, user.id, user.email],
  );
  return rows[0] ? toFlow(rows[0]) : null;
}

export async function findFlow(flowId: string): Promise<OAuthFlow | null> {
  const { rows } = await pool.query<FlowRow>(
    `SELECT f.id, f.client_id,
            (SELECT c.client_name FROM public.mcp_oauth_client c
              WHERE c.client_id = f.client_id) AS client_name,
            f.redirect_uri, f.client_state, f.code_challenge, f.scope,
            f.resource, f.stage, f.google_nonce, f.user_id, f.user_email
     FROM public.mcp_oauth_flow f
     WHERE f.id = $1 AND f.expires_at > now()`,
    [flowId],
  );
  return rows[0] ? toFlow(rows[0]) : null;
}

/**
 * Consumes a consented flow and issues the authorization code in one
 * transaction, so a double-submitted consent form yields one code, not two.
 */
export async function consumeFlowAndIssueCode(args: {
  flowId: string;
  codeHash: string;
  user: DashboardUser;
  ttlSeconds: number;
}): Promise<OAuthFlow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<FlowRow>(
      `UPDATE public.mcp_oauth_flow f
       SET stage = 'consumed'
       WHERE f.id = $1 AND f.stage = 'awaiting_consent' AND f.expires_at > now()
       RETURNING f.id, f.client_id, NULL::text AS client_name, f.redirect_uri,
                 f.client_state, f.code_challenge, f.scope, f.resource, f.stage,
                 f.google_nonce, f.user_id, f.user_email`,
      [args.flowId],
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `INSERT INTO public.mcp_oauth_code
         (code_hash, client_id, user_id, user_email, redirect_uri, code_challenge,
          scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))`,
      [
        args.codeHash,
        row.client_id,
        args.user.id,
        args.user.email,
        row.redirect_uri,
        row.code_challenge,
        row.scope,
        row.resource,
        args.ttlSeconds,
      ],
    );
    await client.query("COMMIT");
    return toFlow(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteFlow(flowId: string): Promise<void> {
  await pool.query(`DELETE FROM public.mcp_oauth_flow WHERE id = $1`, [flowId]);
}

// ---------------------------------------------------------------------------
// authorization codes
// ---------------------------------------------------------------------------

export type AuthorizationCode = {
  clientId: string;
  userId: string;
  userEmail: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
};

/**
 * Single-use redemption. The UPDATE ... WHERE consumed_at IS NULL RETURNING is
 * what makes it single-use under concurrency: only one of two simultaneous
 * exchanges can match the row, so the loser gets nothing back.
 */
export async function redeemAuthorizationCode(
  codeHash: string,
): Promise<AuthorizationCode | null> {
  const { rows } = await pool.query<{
    client_id: string;
    user_id: string;
    user_email: string;
    redirect_uri: string;
    code_challenge: string;
    scope: string;
    resource: string | null;
  }>(
    `UPDATE public.mcp_oauth_code
     SET consumed_at = now()
     WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING client_id, user_id, user_email, redirect_uri, code_challenge, scope, resource`,
    [codeHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: row.client_id,
    userId: row.user_id,
    userEmail: row.user_email,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scope: row.scope,
    resource: row.resource,
  };
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

export async function insertTokenPair(args: {
  accessTokenHash: string;
  refreshTokenHash: string | null;
  clientId: string;
  userId: string;
  userEmail: string;
  scope: string;
  resource: string | null;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** Set when this pair replaces a rotated refresh token. */
  rotatedFromHash?: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.mcp_access_token
         (token_hash, client_id, user_id, user_email, scope, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
      [
        args.accessTokenHash,
        args.clientId,
        args.userId,
        args.userEmail,
        args.scope,
        args.resource,
        args.accessTtlSeconds,
      ],
    );
    if (args.refreshTokenHash) {
      await client.query(
        `INSERT INTO public.mcp_refresh_token
           (token_hash, client_id, user_id, user_email, scope, resource, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
        [
          args.refreshTokenHash,
          args.clientId,
          args.userId,
          args.userEmail,
          args.scope,
          args.resource,
          args.refreshTtlSeconds,
        ],
      );
    }
    if (args.rotatedFromHash) {
      await client.query(
        `UPDATE public.mcp_refresh_token
         SET rotated_to = $2, revoked_at = now()
         WHERE token_hash = $1`,
        [args.rotatedFromHash, args.refreshTokenHash],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type AccessTokenRecord = {
  clientId: string;
  clientName: string | null;
  scope: string;
  resource: string | null;
  expiresAt: Date;
  /**
   * The user as they stand now, re-read rather than taken from the token, so a
   * dashboard change applies to the very next request. Null when the account has
   * since been removed.
   */
  user: DashboardUser | null;
};

/**
 * Verifies an access token, stamps last_used_at, and re-resolves the user behind
 * it — all in one statement.
 *
 * This runs on every MCP request, so it is deliberately one round trip: the
 * client name and the current identity come back as subqueries rather than as
 * two further calls.
 */
export async function verifyAccessToken(tokenHash: string): Promise<AccessTokenRecord | null> {
  const { rows } = await pool.query<{
    client_id: string;
    client_name: string | null;
    scope: string;
    resource: string | null;
    expires_at: Date;
    account: DashboardUser | null;
  }>(
    `UPDATE public.mcp_access_token t
     SET last_used_at = now()
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now()
     RETURNING t.client_id, t.scope, t.resource, t.expires_at,
               (SELECT c.client_name FROM public.mcp_oauth_client c
                 WHERE c.client_id = t.client_id) AS client_name,
               public.mcp_lookup_user(t.user_email) AS account`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    scope: row.scope,
    resource: row.resource,
    expiresAt: row.expires_at,
    user: row.account
      ? {
          id: row.account.id,
          email: row.account.email,
          name: row.account.name ?? null,
          role: row.account.role,
          practiceGroup: row.account.practiceGroup ?? null,
        }
      : null,
  };
}

export type RefreshTokenRecord = {
  clientId: string;
  userId: string;
  userEmail: string;
  scope: string;
  resource: string | null;
  /** Set when the token was already exchanged — a replay, not a valid refresh. */
  rotatedTo: string | null;
  revoked: boolean;
  expired: boolean;
};

export async function findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
  const { rows } = await pool.query<{
    client_id: string;
    user_id: string;
    user_email: string;
    scope: string;
    resource: string | null;
    rotated_to: string | null;
    revoked_at: Date | null;
    expires_at: Date;
  }>(
    `SELECT client_id, user_id, user_email, scope, resource, rotated_to, revoked_at, expires_at
     FROM public.mcp_refresh_token WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: row.client_id,
    userId: row.user_id,
    userEmail: row.user_email,
    scope: row.scope,
    resource: row.resource,
    rotatedTo: row.rotated_to,
    revoked: row.revoked_at !== null,
    expired: row.expires_at.getTime() <= Date.now(),
  };
}

/**
 * Revokes every live token a client holds for one user.
 *
 * Called when a retired refresh token is replayed. OAuth 2.1 treats that as
 * evidence the token was stolen — either the client or the thief is using a
 * token the other already spent — and there is no way to tell which party is
 * legitimate, so the whole family goes and the user signs in again.
 */
export async function revokeTokenFamily(clientId: string, userId: string): Promise<void> {
  await pool.query(
    `UPDATE public.mcp_access_token SET revoked_at = now()
     WHERE client_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [clientId, userId],
  );
  await pool.query(
    `UPDATE public.mcp_refresh_token SET revoked_at = now()
     WHERE client_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [clientId, userId],
  );
}

/**
 * RFC 7009 revocation, scoped to the calling client's own tokens. Returns whether
 * anything matched, for logging only — the endpoint answers 200 either way.
 */
export async function revokeToken(tokenHash: string, clientId: string): Promise<boolean> {
  const access = await pool.query(
    `UPDATE public.mcp_access_token SET revoked_at = now()
     WHERE token_hash = $1 AND client_id = $2 AND revoked_at IS NULL`,
    [tokenHash, clientId],
  );
  const refresh = await pool.query(
    `UPDATE public.mcp_refresh_token SET revoked_at = now()
     WHERE token_hash = $1 AND client_id = $2 AND revoked_at IS NULL`,
    [tokenHash, clientId],
  );
  return (access.rowCount ?? 0) + (refresh.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * Resolves a Google-verified address to the dashboard user behind it, or null
 * when nobody by that address has a dashboard account.
 */
export async function lookupUser(email: string): Promise<DashboardUser | null> {
  const { rows } = await pool.query<{ mcp_lookup_user: DashboardUser | null }>(
    `SELECT public.mcp_lookup_user($1) AS mcp_lookup_user`,
    [email],
  );
  const user = rows[0]?.mcp_lookup_user ?? null;
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    role: user.role,
    practiceGroup: user.practiceGroup ?? null,
  };
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export type AuthEvent = {
  event:
    | "sign_in_started"
    | "sign_in_succeeded"
    | "consent_granted"
    | "consent_denied"
    | "domain_rejected"
    | "not_provisioned"
    | "client_registered"
    | "token_issued"
    | "token_refreshed"
    | "token_revoked"
    | "refresh_replay_detected"
    | "request_unauthorized";
  email?: string | null;
  userId?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
};

/**
 * Appends to the authentication trail. Audit writes never propagate: a failure
 * here must not turn a legitimate sign-in into an error, so it is reported to
 * stdout and dropped.
 */
export async function recordAuthEvent(event: AuthEvent): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO public.mcp_auth_event
         (event, email, user_id, client_id, client_name, ip, user_agent, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.event,
        event.email ?? null,
        event.userId ?? null,
        event.clientId ?? null,
        event.clientName ?? null,
        event.ip ?? null,
        event.userAgent ?? null,
        JSON.stringify(event.detail ?? {}),
      ],
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "auth_event_write_failed",
        event: event.event,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export type RequestLogEntry = {
  userId: string | null;
  userEmail: string | null;
  userRole: string;
  userPracticeGroup: string | null;
  clientId: string;
  clientName: string | null;
  tool: string;
  arguments: unknown;
  rowCount: number | null;
  sourceIds: string[];
  confidentialPermitted: boolean;
  outcome: "ok" | "error";
  error?: string | null;
  durationMs: number;
  ip?: string | null;
  userAgent?: string | null;
};

export async function recordRequest(entry: RequestLogEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO public.mcp_request_log
         (user_id, user_email, user_role, user_practice_group, client_id, client_name,
          tool, arguments, row_count, source_ids, confidential_permitted, outcome,
          error, duration_ms, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        entry.userId,
        entry.userEmail,
        entry.userRole,
        entry.userPracticeGroup,
        entry.clientId,
        entry.clientName,
        entry.tool,
        JSON.stringify(entry.arguments ?? {}),
        entry.rowCount,
        entry.sourceIds,
        entry.confidentialPermitted,
        entry.outcome,
        entry.error ?? null,
        entry.durationMs,
        entry.ip ?? null,
        entry.userAgent ?? null,
      ],
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        msg: "request_log_write_failed",
        tool: entry.tool,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export async function runAuthGc(): Promise<Record<string, number> | null> {
  const { rows } = await pool.query<{ mcp_auth_gc: Record<string, number> | null }>(
    `SELECT public.mcp_auth_gc() AS mcp_auth_gc`,
  );
  return rows[0]?.mcp_auth_gc ?? null;
}
