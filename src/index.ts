import express from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createAmanaMcpServer } from "./mcp.js";
import { pool } from "./db.js";

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.MCP_BEARER_TOKEN;

// Optional second token that additionally unlocks deliverables marked
// confidential. The MCP protocol carries no end-user identity, so confidentiality
// is enforced per credential: ordinary clients get the public/internal corpus,
// and only a holder of this token can read restricted documents. Leave it unset
// to make confidential deliverables unreachable through MCP entirely.
const PRIVILEGED_TOKEN = process.env.MCP_BEARER_TOKEN_PRIVILEGED;

const CONFIDENTIAL_SCOPE = "corpus:confidential";

if (!TOKEN) {
  throw new Error("MCP_BEARER_TOKEN is required");
}

if (PRIVILEGED_TOKEN && PRIVILEGED_TOKEN === TOKEN) {
  throw new Error(
    "MCP_BEARER_TOKEN_PRIVILEGED must differ from MCP_BEARER_TOKEN, " +
      "otherwise every client would be granted confidential access",
  );
}

/** Constant-time compare so a wrong token cannot be found a byte at a time. */
function tokensMatch(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < presented.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "amana-mcp" });
});

app.use("/mcp", (req, res, next) => {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  const isPrivileged = Boolean(PRIVILEGED_TOKEN) && tokensMatch(presented, PRIVILEGED_TOKEN!);
  const isStandard = tokensMatch(presented, TOKEN);

  if (!isPrivileged && !isStandard) {
    res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
    return;
  }

  // Pass-through auth info; toNodeHandler forwards req.auth to the server factory.
  (req as express.Request & { auth?: unknown }).auth = {
    token: presented,
    clientId: isPrivileged ? "amana-privileged" : "amana-standard",
    scopes: isPrivileged ? [CONFIDENTIAL_SCOPE] : [],
  };
  next();
});

const node = toNodeHandler(
  createMcpHandler((ctx) =>
    createAmanaMcpServer({
      includeConfidential: ctx.authInfo?.scopes?.includes(CONFIDENTIAL_SCOPE) === true,
    }),
  ),
);
app.all("/mcp", (req, res) => {
  void node(req, res, req.body);
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: "listening",
      port: PORT,
      confidentialAccessEnabled: Boolean(PRIVILEGED_TOKEN),
    }),
  );
});

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
