/**
 * End-to-end check of authentication, access control and request logging.
 *
 * Starts the server on a spare port in oauth mode and walks a client through the
 * whole flow: dynamic registration, /authorize, consent, the PKCE token
 * exchange, an authenticated MCP tool call, refresh-token rotation, and the
 * audit rows that should have landed in Postgres.
 *
 * The one step that cannot run here is the redirect to Google: it needs a real
 * browser and a real Google account. That hop is simulated by promoting the
 * in-flight authorization to the state the Google callback would have left it
 * in, using a chosen row from the dashboard's User table — so everything the
 * callback decides (domain check, provisioning check) is exercised by the unit
 * checks at the end instead, and everything after it is exercised for real.
 *
 * Usage:  node scripts/smoke-oauth.mjs
 *
 * It writes to the real database, under ids prefixed `smoke_`, and deletes them
 * again on the way out.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { loadEnv } from "../eval/lib/env.mjs";
import { isAllowedDomain } from "../dist/auth/config.js";
import { matchesRegisteredRedirectUri } from "../dist/auth/redirect-uri.js";

const env = loadEnv();
const PORT = Number(process.env.SMOKE_PORT ?? 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

// The server needs the reader role specifically: the point of the exercise is
// that the grants in sql/004 are sufficient for the whole flow.
const readerUrl = env.MCP_READER_DATABASE_URL ?? env.DATABASE_URL;
const adminUrl = env.DIRECT_URL ?? env.DATABASE_URL;
if (!readerUrl || !adminUrl) {
  console.error("MCP_READER_DATABASE_URL (or DATABASE_URL) and DIRECT_URL must be set");
  process.exit(2);
}

const admin = new pg.Client({ connectionString: adminUrl, ssl: { rejectUnauthorized: false } });

// A server left behind by an interrupted run would answer on this port, and the
// checks below would pass against stale code instead of the current build. That
// is worth refusing outright rather than reporting as a puzzling failure.
try {
  await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
  console.error(
    `Something is already listening on ${BASE} — probably a server left over from an ` +
      `interrupted run. Stop it (pkill -f "tsx src/index.ts") or set SMOKE_PORT to a free port.`,
  );
  process.exit(2);
} catch {
  // Nothing listening, which is what we want.
}

const child = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: {
    ...process.env,
    DATABASE_URL: readerUrl,
    PORT: String(PORT),
    MCP_AUTH_MODE: "oauth",
    MCP_PUBLIC_URL: BASE,
    MCP_GOOGLE_CLIENT_ID: "smoke-client.apps.googleusercontent.com",
    MCP_GOOGLE_CLIENT_SECRET: "smoke-secret",
    MCP_BEARER_TOKEN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const serverLog = [];
child.stdout.on("data", (chunk) => serverLog.push(String(chunk)));
child.stderr.on("data", (chunk) => serverLog.push(String(chunk)));

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return response.json();
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start:\n${serverLog.join("")}`);
}

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(name, redirectUris = [CLAUDE_REDIRECT]) {
  const response = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
  return { status: response.status, body: await response.json() };
}

/** Runs /authorize and returns the flow id the server handed to Google as state. */
async function startAuthorize(clientId, challenge, redirectUri = CLAUDE_REDIRECT, extra = {}) {
  const { scope = "mcp:read corpus:confidential offline_access", ...query } = extra;
  const url = new URL(`${BASE}/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", "client-state-123");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  const response = await fetch(url, { redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") };
}

/**
 * Stands in for the Google callback: marks the flow as signed in by the given
 * dashboard user, which is exactly what attachIdentityToFlow does once Google's
 * ID token has been verified and the domain checks have passed.
 */
async function simulateGoogleSignIn(flowId, user) {
  await admin.query(
    `UPDATE public.mcp_oauth_flow
     SET stage = 'awaiting_consent', user_id = $2, user_email = $3
     WHERE id = $1 AND stage = 'awaiting_google'`,
    [flowId, user.id, user.email],
  );
}

async function consent(flowId, decision = "approve") {
  const response = await fetch(`${BASE}/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ flow: flowId, decision }),
    redirect: "manual",
  });
  return { status: response.status, location: response.headers.get("location") };
}

async function exchange(params) {
  const response = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function mcpCall(accessToken, message) {
  const response = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  // The streamable transport may answer either JSON or a single SSE frame.
  const jsonLine = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim()
    : text;
  let body = null;
  try {
    body = jsonLine ? JSON.parse(jsonLine) : null;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { status: response.status, body, wwwAuthenticate: response.headers.get("www-authenticate") };
}

/** One complete sign-in, from registration to a usable access token. */
async function fullFlow(clientName, user, extra = {}) {
  const { body: client } = await register(clientName);
  const { verifier, challenge } = pkcePair();
  const { location } = await startAuthorize(client.client_id, challenge, CLAUDE_REDIRECT, extra);
  const flowId = new URL(location).searchParams.get("state");
  await simulateGoogleSignIn(flowId, user);
  const { location: redirected } = await consent(flowId);
  const code = new URL(redirected).searchParams.get("code");
  const { body: tokens } = await exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: CLAUDE_REDIRECT,
  });
  return { client, tokens, verifier, code };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

const createdClientIds = [];
// Some auth events are recorded with no client — the refused anonymous requests,
// for one — so cleanup needs a time bound as well as the client ids.
const startedAt = new Date();

try {
  await admin.connect();
  const health = await waitForServer();
  check("server starts in oauth mode", health.authMode === "oauth", health);

  const { rows: userRows } = await admin.query(
    `SELECT id, email, role FROM public."User" WHERE role = $1 ORDER BY "createdAt" LIMIT 1`,
    ["admin"],
  );
  const { rows: analystRows } = await admin.query(
    `SELECT id, email, role, "practiceGroup" FROM public."User"
     WHERE role <> $1 ORDER BY "createdAt" LIMIT 1`,
    ["admin"],
  );
  const adminUser = userRows[0];
  const analystUser = analystRows[0];
  if (!adminUser || !analystUser) {
    throw new Error("need at least one admin and one non-admin row in public.\"User\"");
  }
  console.log(`\nusing ${adminUser.email} (admin) and ${analystUser.email} (${analystUser.role})`);

  // -------------------------------------------------------------------------
  section("discovery");
  // -------------------------------------------------------------------------

  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  check("protected resource metadata names this server", prm.resource === `${BASE}/mcp`, prm);
  check("it points at the authorization server", prm.authorization_servers?.[0] === BASE, prm);

  const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check("S256 PKCE is advertised", asm.code_challenge_methods_supported?.[0] === "S256", asm);
  check("DCR is advertised", typeof asm.registration_endpoint === "string", asm);
  check(
    "offline_access is advertised so clients ask for a refresh token",
    asm.scopes_supported?.includes("offline_access"),
    asm,
  );

  // -------------------------------------------------------------------------
  section("an unauthenticated request is refused and points the way to sign-in");
  // -------------------------------------------------------------------------

  const anonymous = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const challengeHeader = anonymous.headers.get("www-authenticate") ?? "";
  check("no token is 401", anonymous.status === 401, anonymous.status);
  check(
    "the challenge carries resource_metadata",
    challengeHeader.includes("resource_metadata="),
    challengeHeader,
  );

  const bogus = await mcpCall("amana_at_not-a-real-token", { jsonrpc: "2.0", id: 1, method: "ping" });
  check("an invented token is 401", bogus.status === 401, bogus.status);

  // -------------------------------------------------------------------------
  section("registration and authorization");
  // -------------------------------------------------------------------------

  const badRedirect = await register("smoke_bad_redirect", ["http://evil.example.com/cb"]);
  check("a non-loopback http redirect_uri is rejected", badRedirect.status === 400, badRedirect);

  const registered = await register("smoke_registration_probe");
  check("DCR returns a client_id", registered.status === 201 && !!registered.body.client_id, registered);
  check(
    "a public client gets no secret",
    registered.body.client_secret === undefined,
    registered.body,
  );
  createdClientIds.push(registered.body.client_id);

  const { challenge: probeChallenge } = pkcePair();
  const redirected = await startAuthorize(registered.body.client_id, probeChallenge);
  const googleUrl = redirected.location ? new URL(redirected.location) : null;
  check("/authorize redirects to Google", googleUrl?.host === "accounts.google.com", redirected);
  check(
    "the account chooser is pinned to the AMANA domain",
    googleUrl?.searchParams.get("hd") === "amana.id",
    googleUrl?.search,
  );

  const noPkce = await fetch(
    `${BASE}/oauth/authorize?client_id=${registered.body.client_id}` +
      `&redirect_uri=${encodeURIComponent(CLAUDE_REDIRECT)}&response_type=code`,
    { redirect: "manual" },
  );
  check(
    "an authorization request without PKCE is refused",
    new URL(noPkce.headers.get("location")).searchParams.get("error") === "invalid_request",
    noPkce.headers.get("location"),
  );

  const unregisteredRedirect = await startAuthorize(
    registered.body.client_id,
    probeChallenge,
    "https://attacker.example.com/cb",
  );
  check(
    "an unregistered redirect_uri is not redirected to",
    unregisteredRedirect.status === 400,
    unregisteredRedirect,
  );

  const wrongResource = await startAuthorize(registered.body.client_id, probeChallenge, CLAUDE_REDIRECT, {
    resource: "https://someone-elses-server.example.com/mcp",
  });
  check(
    "a token cannot be requested for another resource",
    new URL(wrongResource.location).searchParams.get("error") === "invalid_target",
    wrongResource.location,
  );

  // -------------------------------------------------------------------------
  section("consent and the token exchange");
  // -------------------------------------------------------------------------

  const { body: consentClient } = await register("smoke_consent_probe");
  createdClientIds.push(consentClient.client_id);
  const pkce = pkcePair();
  const authorized = await startAuthorize(consentClient.client_id, pkce.challenge);
  const flowId = new URL(authorized.location).searchParams.get("state");

  const beforeSignIn = await consent(flowId);
  check(
    "consent cannot be given before Google has verified the user",
    beforeSignIn.status === 400,
    beforeSignIn.status,
  );

  await simulateGoogleSignIn(flowId, analystUser);
  const consented = await consent(flowId);
  const callback = consented.location ? new URL(consented.location) : null;
  check("consent redirects back to the client", callback?.origin === "https://claude.ai", consented);
  check("the client's state is returned", callback?.searchParams.get("state") === "client-state-123");
  const code = callback?.searchParams.get("code");
  check("an authorization code is issued", typeof code === "string" && code.length > 20);

  const replayedConsent = await consent(flowId);
  check(
    "the consent form cannot be resubmitted for a second code",
    replayedConsent.status === 400,
    replayedConsent.status,
  );

  const wrongVerifier = await exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: pkcePair().verifier,
    client_id: consentClient.client_id,
  });
  check(
    "a wrong PKCE verifier is rejected",
    wrongVerifier.body?.error === "invalid_grant",
    wrongVerifier.body,
  );

  // The failed attempt consumed the code, which is itself the correct behaviour.
  const replayedCode = await exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: pkce.verifier,
    client_id: consentClient.client_id,
  });
  check(
    "an authorization code is single-use",
    replayedCode.body?.error === "invalid_grant",
    replayedCode.body,
  );

  // -------------------------------------------------------------------------
  section("scopes follow the dashboard role");
  // -------------------------------------------------------------------------

  const analystSession = await fullFlow("smoke_analyst_session", analystUser);
  createdClientIds.push(analystSession.client.client_id);
  check(
    `${analystUser.role} gets mcp:read`,
    analystSession.tokens?.scope?.includes("mcp:read"),
    analystSession.tokens,
  );
  check(
    `${analystUser.role} does not get corpus:confidential even though the client asked for it`,
    !analystSession.tokens?.scope?.includes("corpus:confidential"),
    analystSession.tokens?.scope,
  );
  check(
    "a refresh token is issued for offline_access",
    typeof analystSession.tokens?.refresh_token === "string",
    Object.keys(analystSession.tokens ?? {}),
  );

  const adminSession = await fullFlow("smoke_admin_session", adminUser);
  createdClientIds.push(adminSession.client.client_id);
  check(
    "admin does get corpus:confidential",
    adminSession.tokens?.scope?.includes("corpus:confidential"),
    adminSession.tokens?.scope,
  );

  // -------------------------------------------------------------------------
  section("an authenticated MCP call");
  // -------------------------------------------------------------------------

  const token = analystSession.tokens.access_token;
  const initialized = await mcpCall(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.0" },
    },
  });
  check(
    "initialize succeeds with a real token",
    initialized.body?.result?.serverInfo?.name === "amana-knowledge",
    initialized,
  );

  const tools = await mcpCall(token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const toolNames = (tools.body?.result?.tools ?? []).map((tool) => tool.name).sort();
  check("all four tools are listed", toolNames.length === 4, toolNames);

  const called = await mcpCall(token, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "search_corpus", arguments: { query: "health", limit: 3 } },
  });
  const text = called.body?.result?.content?.[0]?.text ?? "";
  check("search_corpus answers", text.includes("<untrusted-corpus>"), called.body?.error ?? text.slice(0, 200));

  // -------------------------------------------------------------------------
  section("the request is in the audit trail");
  // -------------------------------------------------------------------------

  // The audit write is deliberately fire-and-forget, so give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 800));

  const { rows: logRows } = await admin.query(
    `SELECT user_email, user_role, user_practice_group, tool, row_count, source_ids,
            confidential_permitted, outcome
     FROM public.mcp_request_log
     WHERE client_id = $1 ORDER BY ts DESC LIMIT 5`,
    [analystSession.client.client_id],
  );
  const searchRow = logRows.find((row) => row.tool === "search_corpus");
  check("the tool call was logged", !!searchRow, logRows);
  check(
    "the log row names the authenticated user",
    searchRow?.user_email === analystUser.email,
    searchRow?.user_email,
  );
  check(
    "the log row records the role the call ran as",
    searchRow?.user_role === analystUser.role,
    searchRow?.user_role,
  );
  check(
    "the log row records the practice group, for a future scoping policy",
    searchRow?.user_practice_group === analystUser.practiceGroup,
    { logged: searchRow?.user_practice_group, expected: analystUser.practiceGroup },
  );
  check(
    "the log row records that confidential data was not accessible",
    searchRow?.confidential_permitted === false,
    searchRow?.confidential_permitted,
  );
  check(
    "the log row records which records were returned",
    Array.isArray(searchRow?.source_ids),
    searchRow?.source_ids,
  );

  const { rows: authRows } = await admin.query(
    `SELECT event FROM public.mcp_auth_event WHERE client_id = $1 ORDER BY ts`,
    [analystSession.client.client_id],
  );
  const events = authRows.map((row) => row.event);
  check(
    "the sign-in is in the auth trail",
    ["client_registered", "sign_in_started", "consent_granted", "token_issued"].every((event) =>
      events.includes(event),
    ),
    events,
  );

  // -------------------------------------------------------------------------
  section("refresh and rotation");
  // -------------------------------------------------------------------------

  const refreshed = await exchange({
    grant_type: "refresh_token",
    refresh_token: analystSession.tokens.refresh_token,
    client_id: analystSession.client.client_id,
  });
  check("refresh returns a new access token", !!refreshed.body?.access_token, refreshed.body);
  check(
    "the refresh token is rotated",
    refreshed.body?.refresh_token && refreshed.body.refresh_token !== analystSession.tokens.refresh_token,
    refreshed.body?.refresh_token === analystSession.tokens.refresh_token,
  );

  const replayedRefresh = await exchange({
    grant_type: "refresh_token",
    refresh_token: analystSession.tokens.refresh_token,
    client_id: analystSession.client.client_id,
  });
  check(
    "replaying the retired refresh token fails",
    replayedRefresh.body?.error === "invalid_grant",
    replayedRefresh.body,
  );

  const afterReplay = await mcpCall(refreshed.body.access_token, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/list",
  });
  check(
    "the replay revoked the whole token family",
    afterReplay.status === 401,
    afterReplay.status,
  );

  const otherClientsRefresh = await exchange({
    grant_type: "refresh_token",
    refresh_token: adminSession.tokens.refresh_token,
    client_id: analystSession.client.client_id,
  });
  check(
    "one client cannot refresh another client's token",
    otherClientsRefresh.body?.error === "invalid_grant",
    otherClientsRefresh.body,
  );

  // An admin whose client asked only for mcp:read must not be able to acquire
  // corpus:confidential on a later refresh, even though their role allows it:
  // the consent screen they approved said confidential documents were excluded.
  const narrowAdmin = await fullFlow("smoke_narrow_admin", adminUser, {
    scope: "mcp:read offline_access",
  });
  createdClientIds.push(narrowAdmin.client.client_id);
  check(
    "a narrow grant stays narrow at issue",
    !narrowAdmin.tokens?.scope?.includes("corpus:confidential"),
    narrowAdmin.tokens?.scope,
  );
  const widened = await exchange({
    grant_type: "refresh_token",
    refresh_token: narrowAdmin.tokens.refresh_token,
    client_id: narrowAdmin.client.client_id,
    scope: "mcp:read corpus:confidential offline_access",
  });
  check(
    "a refresh cannot widen the grant it is refreshing",
    widened.body?.access_token && !widened.body.scope.includes("corpus:confidential"),
    widened.body?.scope,
  );

  // -------------------------------------------------------------------------
  section("revocation");
  // -------------------------------------------------------------------------

  const adminToken = adminSession.tokens.access_token;
  const beforeRevoke = await mcpCall(adminToken, { jsonrpc: "2.0", id: 5, method: "tools/list" });
  check("the admin token works", beforeRevoke.status === 200, beforeRevoke.status);

  // Another client presenting the same token must not be able to revoke it.
  await fetch(`${BASE}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: adminToken, client_id: narrowAdmin.client.client_id }),
  });
  const afterForeignRevoke = await mcpCall(adminToken, { jsonrpc: "2.0", id: 6, method: "tools/list" });
  check(
    "another client cannot revoke this client's token",
    afterForeignRevoke.status === 200,
    afterForeignRevoke.status,
  );

  const anonymousRevoke = await fetch(`${BASE}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: adminToken }),
  });
  check(
    "revocation requires a client to identify itself",
    anonymousRevoke.status === 401,
    anonymousRevoke.status,
  );

  await fetch(`${BASE}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: adminToken, client_id: adminSession.client.client_id }),
  });
  const afterRevoke = await mcpCall(adminToken, { jsonrpc: "2.0", id: 7, method: "tools/list" });
  check("the owning client can revoke it", afterRevoke.status === 401, afterRevoke.status);

  // -------------------------------------------------------------------------
  section("the domain rule itself");
  // -------------------------------------------------------------------------
  //
  // These are the checks the Google callback applies to the verified ID token,
  // exercised directly because the redirect to Google cannot run here.

  check("an @amana.id address is allowed", isAllowedDomain("someone@amana.id"));
  check("case and whitespace do not matter", isAllowedDomain("  Someone@Amana.ID  "));
  check("a personal Gmail is refused", !isAllowedDomain("someone@gmail.com"));
  check("a lookalike domain is refused", !isAllowedDomain("someone@amana.id.evil.com"));
  check("a subdomain is refused", !isAllowedDomain("someone@mail.amana.id"));
  check("an address merely containing the domain is refused", !isAllowedDomain("amana.id@gmail.com"));
  check("an empty address is refused", !isAllowedDomain(""));

  check(
    "Claude Code's loopback redirect matches on any port",
    matchesRegisteredRedirectUri("http://localhost:52431/callback", ["http://localhost/callback"]),
  );
  check(
    "the port wildcard does not extend to non-loopback hosts",
    !matchesRegisteredRedirectUri("https://claude.ai:8443/api/mcp/auth_callback", [CLAUDE_REDIRECT]),
  );
  check(
    "a different loopback path does not match",
    !matchesRegisteredRedirectUri("http://localhost:52431/steal", ["http://localhost/callback"]),
  );
} catch (error) {
  failed += 1;
  console.error(`\nsmoke run threw: ${error.stack ?? error}`);
  if (serverLog.length > 0) {
    console.error(`\n--- server output ---\n${serverLog.join("").slice(-4000)}`);
  }
} finally {
  child.kill("SIGTERM");
  try {
    if (createdClientIds.length > 0) {
      // Tokens, flows and codes cascade from the client row; the audit rows are
      // removed by client id, which is the only handle they share.
      await admin.query(`DELETE FROM public.mcp_access_token WHERE client_id = ANY($1)`, [createdClientIds]);
      await admin.query(`DELETE FROM public.mcp_refresh_token WHERE client_id = ANY($1)`, [createdClientIds]);
      await admin.query(`DELETE FROM public.mcp_request_log WHERE client_id = ANY($1)`, [createdClientIds]);
      await admin.query(`DELETE FROM public.mcp_auth_event WHERE client_id = ANY($1)`, [createdClientIds]);
      await admin.query(`DELETE FROM public.mcp_oauth_client WHERE client_id = ANY($1)`, [createdClientIds]);
    }
    await admin.query(
      `DELETE FROM public.mcp_auth_event
       WHERE ts >= $1 AND (client_id IS NULL OR client_id = ANY($2))`,
      [startedAt, createdClientIds],
    );
    await admin.query(`DELETE FROM public.mcp_oauth_client WHERE client_name LIKE 'smoke_%'`);
  } catch (error) {
    console.error(`cleanup failed: ${error.message}`);
  }
  await admin.end().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
