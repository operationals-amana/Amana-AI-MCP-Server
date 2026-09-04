import express from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createAmanaMcpServer } from "./mcp.js";
import { pool } from "./db.js";

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.MCP_BEARER_TOKEN;

if (!TOKEN) {
  throw new Error("MCP_BEARER_TOKEN is required");
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "amana-mcp" });
});

app.use("/mcp", (req, res, next) => {
  const header = req.headers.authorization ?? "";
  if (header !== `Bearer ${TOKEN}`) {
    res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
    return;
  }
  next();
});

const node = toNodeHandler(createMcpHandler(() => createAmanaMcpServer()));
app.all("/mcp", (req, res) => {
  void node(req, res, req.body);
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "listening", port: PORT }));
});

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
