import path from "node:path";
import express from "express";
import { loadConfig } from "./gateway/config.ts";
import { openDb, loadDbConfig } from "./gateway/db.ts";
import { InvoiceStore } from "./gateway/invoices.ts";
import { createServer } from "./server.ts";
import type { GatewayConfig } from "./gateway/types.ts";

/**
 * Wire config + MySQL pool + routes + static frontend into an Express app WITHOUT
 * listening. Async because it connects to MySQL and ensures the schema. Shared by
 * `main.ts` (which calls listen) and `server.js` (which attaches the app to a
 * pre-bound HTTP server so the port binds before this heavier init runs).
 */
export async function buildApp(): Promise<{ app: express.Express; config: GatewayConfig }> {
  const config = loadConfig();
  const pool = await openDb(loadDbConfig());
  const store = new InvoiceStore(pool, config);
  const app = createServer(store, config.merchants);

  const dist = path.resolve("dist");
  app.use(express.static(dist));
  app.get("/", (_req, res) => res.redirect("/checkout.html"));
  app.get("/admin", (_req, res) => res.redirect("/admin.html"));

  return { app, config };
}
