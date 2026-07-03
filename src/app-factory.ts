import path from "node:path";
import express from "express";
import { loadConfig } from "./gateway/config.ts";
import { openDb } from "./gateway/db.ts";
import { InvoiceStore } from "./gateway/invoices.ts";
import { createServer } from "./server.ts";
import type { GatewayConfig } from "./gateway/types.ts";

/**
 * Wire config + DB + routes + static frontend into an Express app WITHOUT listening.
 * Shared by `main.ts` (which calls listen) and `server.js` (which attaches the app to
 * a pre-bound HTTP server so the port binds before this heavier init runs).
 */
export function buildApp(): { app: express.Express; config: GatewayConfig } {
  const config = loadConfig();
  const store = new InvoiceStore(openDb(config.dbPath), config);
  const app = createServer(store, config.apiKey);

  const dist = path.resolve("dist");
  app.use(express.static(dist));
  app.get("/", (_req, res) => res.redirect("/checkout.html"));

  return { app, config };
}
