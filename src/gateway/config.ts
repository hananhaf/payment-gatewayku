import "dotenv/config";
import { loadMerchants } from "./merchants.ts";
import type { GatewayConfig } from "./types.ts";

function numEnv(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    merchants: loadMerchants(env),
    port: numEnv(env.PORT, 3000, "PORT"),
    invoiceTtlMs: numEnv(env.INVOICE_TTL_MS, 10 * 60 * 1000, "INVOICE_TTL_MS"),
    maxOffset: numEnv(env.MAX_OFFSET, 999, "MAX_OFFSET"),
    dbPath: env.DB_PATH?.trim() || "gateway.db",
  };
}
