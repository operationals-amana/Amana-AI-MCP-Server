import express from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createAmanaMcpServer } from "./mcp.js";
import { pool } from "./db.js";
import {
  ALLOWED_EMAIL_DOMAIN,
  SCOPE_CONFIDENTIAL,
  SCOPE_READ,
  loadAuthConfig,
} from "./auth/config.js";
import { secretsMatch } from "./auth/crypto.js";
import type { Principal } from "./auth/principal.js";
import {
  authenticateOAuthToken,
  createOAuthRouter,
  protectedResourceMetadataUrl,
} from "./auth/router.js";
import { recordAuthEvent, runAuthGc } from "./auth/store.js";

const PORT = Number(process.env.PORT ?? 3000);
const config = loadAuthConfig();

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

const app = express();
app.disable("x-powered-by");
// Railway terminates TLS, so the client address is only in X-Forwarded-For.
app.set("trust proxy", true);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "amana-mcp", authMode: config.mode });
});

// The OAuth endpoints and discovery documents mount before the MCP route, and
// bring their own body parsers: /oauth/token needs form encoding and
// /oauth/register needs JSON, so neither can share one global parser.
if (config.mode !== "token") {
  app.use(createOAuthRouter(config));
}

app.use(express.json({ limit: "1mb" }));

function clientIp(req: express.Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.ip ?? null;
}

function userAgent(req: express.Request): string | null {
  const value = req.headers["user-agent"];
  return typeof value === "string" ? value.slice(0, 500) : null;
}

function bearerToken(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolves the static bearer token to a service principal.
 *
 * A shared string carries no identity, so this principal is deliberately not a
 * person: it is recorded in the audit log as `service:<label>` and can never
 * satisfy the "linked to an authenticated user" requirement. It exists for
 * machine callers and local development, and is off whenever Google sign-in is
 * configured.
 */
function authenticateStaticToken(token: string): Principal | null {
  if (config.staticPrivilegedToken && secretsMatch(token, config.staticPrivilegedToken)) {
    return {
      kind: "service",
      label: "static-privileged",
      scopes: [SCOPE_READ, SCOPE_CONFIDENTIAL],
    };
  }
  if (config.staticToken && secretsMatch(token, config.staticToken)) {
    return { kind: "service", label: "static", scopes: [SCOPE_READ] };
  }
  return null;
}

/**
 * The 401 that starts the OAuth flow.
 *
 * The `resource_metadata` pointer is what turns "unauthorized" into a sign-in
 * prompt: it tells the client where to find this server's protected resource
 * metadata, and from there its authorization server. Without it a client has
 * nothing to discover and the connection simply fails.
 */
function challenge(res: express.Response, status: number, description: string): void {
  const parts = [`error="${status === 403 ? "insufficient_scope" : "invalid_token"}"`];
  parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  if (config.mode !== "token") {
    parts.push(`resource_metadata="${protectedResourceMetadataUrl(config)}"`);
    parts.push(`scope="${SCOPE_READ}"`);
  }
  res.status(status)
    .set("WWW-Authenticate", `Bearer ${parts.join(", ")}`)
    .json({
      error: status === 403 ? "insufficient_scope" : "invalid_token",
      error_description: description,
    });
}

type McpAuth = {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  extra: { principal: Principal; ip: string | null; userAgent: string | null };
};

app.use("/mcp", async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) {
    challenge(res, 401, "authentication required");
    return;
  }

  let principal: Principal | null = null;
  let expiresAt: number | undefined;
  let clientId = "unknown";

  if (config.mode !== "token") {
    const result = await authenticateOAuthToken(config, token);
    if (result.ok) {
      principal = {
        kind: "user",
        user: result.auth.user,
        clientId: result.auth.clientId,
        clientName: result.auth.clientName,
        scopes: result.auth.scopes,
      };
      expiresAt = result.auth.expiresAt;
      clientId = result.auth.clientId;
    } else if (config.mode === "oauth") {
      void recordAuthEvent({
        event: "request_unauthorized",
        ip: clientIp(req),
        userAgent: userAgent(req),
        detail: { reason: result.reason },
      });
      challenge(res, 401, result.reason);
      return;
    }
  }

  if (!principal && config.mode !== "oauth") {
    const service = authenticateStaticToken(token);
    if (service) {
      principal = service;
      clientId = `service:${service.kind === "service" ? service.label : "unknown"}`;
    }
  }

  if (!principal) {
    void recordAuthEvent({
      event: "request_unauthorized",
      ip: clientIp(req),
      userAgent: userAgent(req),
      detail: { reason: "no credential matched" },
    });
    challenge(res, 401, "the presented token is not valid for this server");
    return;
  }

  if (!principal.scopes.includes(SCOPE_READ)) {
    challenge(res, 403, `the ${SCOPE_READ} scope is required`);
    return;
  }

  const auth: McpAuth = {
    token,
    clientId,
    scopes: principal.scopes,
    expiresAt,
    extra: { principal, ip: clientIp(req), userAgent: userAgent(req) },
  };
  (req as express.Request & { auth?: McpAuth }).auth = auth;
  next();
});

const node = toNodeHandler(
  createMcpHandler((ctx) => {
    // The middleware above refuses the request unless a principal was resolved,
    // so by the time the factory runs there is always one to attribute to.
    const extra = ctx.authInfo?.extra as McpAuth["extra"] | undefined;
    if (!extra?.principal) {
      throw new Error("MCP request reached the server factory without an authenticated principal");
    }
    return createAmanaMcpServer({
      principal: extra.principal,
      requestContext: { ip: extra.ip, userAgent: extra.userAgent },
    });
  }),
);

app.all("/mcp", (req, res) => {
  void node(req, res, req.body);
});

const server = app.listen(PORT, "0.0.0.0", () => {
  log({
    msg: "listening",
    port: PORT,
    authMode: config.mode,
    issuer: config.publicUrl?.origin ?? null,
    resource: config.resourceUrl?.toString() ?? null,
    allowedEmailDomain: config.mode === "token" ? null : ALLOWED_EMAIL_DOMAIN,
    confidentialRoles: config.confidentialRoles,
  });

  if (config.mode !== "oauth") {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        msg: "static_bearer_token_enabled",
        detail:
          `MCP_AUTH_MODE=${config.mode} accepts a shared bearer token. A static token ` +
          `carries no identity, so requests made with it cannot be attributed to a person ` +
          `and the @${ALLOWED_EMAIL_DOMAIN} restriction does not apply to them. ` +
          `Set MCP_AUTH_MODE=oauth once every client has migrated.`,
      }),
    );
  }
});

/**
 * Expired flows, codes and tokens, and the client rows Dynamic Client
 * Registration leaves behind, are cleaned up here rather than by a cron job, so
 * the server has no external dependency to keep the tables from growing.
 */
const gcTimer = setInterval(
  () => {
    void runAuthGc()
      .then((result) => {
        if (result && Object.values(result).some((count) => count > 0)) {
          log({ msg: "auth_gc", ...result });
        }
      })
      .catch((error: unknown) => {
        log({
          msg: "auth_gc_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  },
  6 * 60 * 60 * 1000,
);
gcTimer.unref();

async function shutdown() {
  clearInterval(gcTimer);
  server.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
