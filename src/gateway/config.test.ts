import { test } from "node:test";
import assert from "node:assert";
import { loadConfig } from "./config.ts";

test("throws when STATIC_QRIS is missing", () => {
  assert.throws(() => loadConfig({ API_KEY: "k" } as NodeJS.ProcessEnv), /STATIC_QRIS/);
});

test("throws when API_KEY is missing", () => {
  assert.throws(
    () => loadConfig({ STATIC_QRIS: "00020101..." } as NodeJS.ProcessEnv),
    /API_KEY/
  );
});

test("applies defaults for optional fields", () => {
  const cfg = loadConfig({ STATIC_QRIS: "q", API_KEY: "k" } as NodeJS.ProcessEnv);
  assert.equal(cfg.staticQris, "q");
  assert.equal(cfg.apiKey, "k");
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.invoiceTtlMs, 10 * 60 * 1000);
  assert.equal(cfg.maxOffset, 999);
  assert.equal(cfg.dbPath, "gateway.db");
});

test("throws on non-numeric PORT", () => {
  assert.throws(
    () => loadConfig({ STATIC_QRIS: "q", API_KEY: "k", PORT: "abc" } as NodeJS.ProcessEnv),
    /PORT must be a number/
  );
});
