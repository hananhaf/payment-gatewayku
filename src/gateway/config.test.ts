import { test } from "node:test";
import assert from "node:assert";
import { loadConfig } from "./config.ts";

const QRIS = "0002010102112604TEST5204000053033605802ID5904Toko6004Kota6304B1D8";

test("loads merchants + numeric defaults from env", () => {
  const cfg = loadConfig({ STATIC_QRIS: QRIS, API_KEY: "k" } as NodeJS.ProcessEnv);
  assert.equal(cfg.merchants.length, 1);
  assert.equal(cfg.merchants[0]!.id, "default");
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.invoiceTtlMs, 10 * 60 * 1000);
  assert.equal(cfg.maxOffset, 999);
  assert.equal(cfg.dbPath, "gateway.db");
});

test("loads multiple merchants from MERCHANTS env", () => {
  const cfg = loadConfig({
    MERCHANTS: JSON.stringify([
      { id: "a", name: "A", qris: QRIS, apiKey: "ka" },
      { id: "b", name: "B", qris: QRIS, apiKey: "kb" },
    ]),
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.merchants.length, 2);
});

test("throws when no merchants configured", () => {
  assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /no merchants configured/i);
});

test("throws on non-numeric PORT", () => {
  assert.throws(
    () => loadConfig({ STATIC_QRIS: QRIS, API_KEY: "k", PORT: "abc" } as NodeJS.ProcessEnv),
    /PORT must be a positive integer/
  );
});

test("throws on a negative MAX_OFFSET", () => {
  assert.throws(
    () => loadConfig({ STATIC_QRIS: QRIS, API_KEY: "k", MAX_OFFSET: "-1" } as NodeJS.ProcessEnv),
    /MAX_OFFSET must be a positive integer/
  );
});
