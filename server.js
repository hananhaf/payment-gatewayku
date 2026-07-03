// TEMPORARY DIAGNOSTIC PROBE — replaces the real entry to isolate a host 503.
// Minimal HTTP server that reports, over HTTP (bypassing the host log viewer),
// exactly what the runtime environment looks like. Restore the real server.js
// once we know Hostinger reaches the app and which port it assigns.
import http from "node:http";
import { existsSync } from "node:fs";

const port = process.env.PORT || 3000;

async function probe() {
  const out = {
    ok: true,
    node: process.version,
    portResolved: String(port),
    portEnvRaw: process.env.PORT ?? null,
    cwd: process.cwd(),
    distCheckoutExists: existsSync("./dist/checkout.html"),
    srcMainExists: existsSync("./src/main.ts"),
    hasStaticQris: Boolean(process.env.STATIC_QRIS),
    hasApiKey: Boolean(process.env.API_KEY),
    betterSqlite3: "not-tested",
    tsx: "not-tested",
  };
  try {
    await import("better-sqlite3");
    out.betterSqlite3 = "loaded OK";
  } catch (e) {
    out.betterSqlite3 = "ERROR: " + e.message;
  }
  try {
    await import("tsx/esm/api");
    out.tsx = "loaded OK";
  } catch (e) {
    out.tsx = "ERROR: " + e.message;
  }
  return out;
}

const server = http.createServer(async (_req, res) => {
  const info = await probe();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(info, null, 2));
});

server.on("error", (e) => console.error("[probe] listen error:", e));
server.listen(port, () => console.log(`[probe] listening on ${port}`));
