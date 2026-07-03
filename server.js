// Plain-JS entry for hosts that start the app with `node server.js` (e.g. Hostinger
// Node.js Web App). Local/Docker use `npm start` (tsx src/main.ts).
//
// Resilient startup: boot the TypeScript app via tsx. If startup throws (bad config,
// unwritable DB path, native load failure, ...) do NOT die into a silent 503 — bind a
// tiny fallback server on the same port that reports the actual error over HTTP, since
// some hosts don't capture stdout. Also background-builds the frontend if dist/ is
// missing (API/webhook don't need it; only the checkout page does).
import http from "node:http";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const port = process.env.PORT || 3000;

console.log(`[server.js] boot: node ${process.version} | PORT=${process.env.PORT ?? "(unset)"} | cwd=${process.cwd()}`);

function startFallback(stage, err) {
  const body = JSON.stringify(
    { ok: false, stage, error: String((err && err.stack) || err), node: process.version, port: String(port), cwd: process.cwd() },
    null,
    2
  );
  http
    .createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(body);
    })
    .on("error", (e) => console.error("[server.js] fallback listen error:", e))
    .listen(port, () => console.error(`[server.js] STARTUP FAILED at '${stage}'; error server on ${port}`));
}

try {
  const { register } = await import("tsx/esm/api");
  register();
  await import("./src/main.ts"); // main.ts calls app.listen(port) internally
  console.log("[server.js] main.ts loaded — server should be listening");
} catch (err) {
  console.error("[server.js] startup failed:", err);
  startFallback("import-main", err);
}

if (!existsSync("./dist/checkout.html")) {
  console.log("[server.js] dist/ missing — building frontend in the background...");
  spawn("npm", ["run", "build"], { stdio: "inherit" }).on("exit", (code) =>
    console.log(code === 0 ? "[server.js] frontend build complete" : `[server.js] frontend build failed (exit ${code})`)
  );
}
