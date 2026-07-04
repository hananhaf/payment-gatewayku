// Plain-JS entry for hosts that start the app with `node server.js` (e.g. Hostinger).
// Local/Docker use `npm start` (tsx src/main.ts).
//
// Hostinger blocks executing the esbuild binary at RUNTIME (EACCES), so tsx can't
// transpile TypeScript on the fly. Instead the build step (`npm run build:server`)
// pre-bundles the app to plain JS at ./dist-server/app-factory.js, and this entry
// runs pure `node` — no tsx, no esbuild at runtime.
//
// The port binds immediately with a tiny HTTP server (so the host's startup health
// check can't time out into a silent 503); the real app is initialized after and
// swapped in. Startup success/error is observable over HTTP, never a silent 503.
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

import("./dist-server/app-factory.js")
  .then(async ({ buildApp }) => {
    const { app } = await buildApp(); // connects to MySQL + ensures schema
    handler = app; // an Express app is itself a (req, res) handler
    console.log("[server.js] app initialized — serving real routes");
  })
  .catch((err) => {
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
  });

if (!existsSync("./dist-server/app-factory.js")) {
  console.log("[server.js] dist-server/ missing — building in the background...");
  spawn("npm", ["run", "build"], { stdio: "inherit" });
}
