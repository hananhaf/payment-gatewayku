import path from "node:path";
import express from "express";
import { loadConfig } from "./gateway/config.ts";
import { openDb } from "./gateway/db.ts";
import { InvoiceStore } from "./gateway/invoices.ts";
import { createServer } from "./server.ts";

const config = loadConfig();
const store = new InvoiceStore(openDb(config.dbPath), config);
const app = createServer(store, config.apiKey);

// Serve the built frontend (produced by `npm run build` into ./dist)
const dist = path.resolve("dist");
app.use(express.static(dist));
app.get("/", (_req, res) => res.redirect("/checkout.html"));

app.listen(config.port, () => {
  console.log(`QRIS gateway listening on :${config.port}`);
  console.log(`  checkout: http://localhost:${config.port}/checkout.html`);
  console.log(`  webhook:  http://localhost:${config.port}/webhook`);
});
