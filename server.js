// Plain-JS entry for hosts that start the app with `node server.js` (e.g. Hostinger).
// Local/Docker use `npm start` (tsx src/main.ts).
//
// Bind the port IMMEDIATELY with a tiny HTTP server (so the host's startup health
// check passes and never times out into a silent 503), THEN initialize the real app
// via tsx and swap it in as the request handler. Whatever happens is observable over
// HTTP: real routes on success, a JSON error on failure, or "starting…" while it's
// still initializing (or hung) — never a silent 503 from a slow/failed boot.
import http from "node:http";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const port = process.env.PORT || 3000;
console.log(`[server.js] boot: node ${process.version} | PORT=${process.env.PORT ?? "(unset)"} | cwd=${process.cwd()}`);

let handler = (_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("starting...");
};

const httpServer = http.createServer((req, res) => handler(req, res));
httpServer.on("error", (e) => console.error("[server.js] http server error:", e));
httpServer.listen(port, () => console.log(`[server.js] listening on ${port} — initializing app...`));

(async () => {
  try {
    const { register } = await import("tsx/esm/api");
    register();
    const { buildApp } = await import("./src/app-factory.ts");
    const { app } = buildApp();
    handler = app; // an Express app is itself a (req, res) handler
    console.log("[server.js] app initialized — serving real routes");
  } catch (err) {
    console.error("[server.js] app init FAILED:", err);
    const body = JSON.stringify(
      { ok: false, error: String((err && err.stack) || err), node: process.version, cwd: process.cwd() },
      null,
      2
    );
    handler = (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(body);
    };
  }
})();

if (!existsSync("./dist/checkout.html")) {
  console.log("[server.js] dist/ missing — building frontend in the background...");
  spawn("npm", ["run", "build"], { stdio: "inherit" });
}
