import "dotenv/config";
import type { GatewayConfig } from "./types.ts";

function numEnv(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got "${value}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const staticQris = env.STATIC_QRIS?.trim();
  if (!staticQris) {
    throw new Error("STATIC_QRIS env is required (your merchant static QRIS string)");
  }
  const apiKey = env.API_KEY?.trim();
  if (!apiKey) {
    throw new Error("API_KEY env is required");
  }
  return {
    staticQris,
    apiKey,
    port: numEnv(env.PORT, 3000, "PORT"),
    invoiceTtlMs: numEnv(env.INVOICE_TTL_MS, 10 * 60 * 1000, "INVOICE_TTL_MS"),
    maxOffset: numEnv(env.MAX_OFFSET, 999, "MAX_OFFSET"),
    dbPath: env.DB_PATH?.trim() || "gateway.db",
  };
}
