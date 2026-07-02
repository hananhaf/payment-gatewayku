import "dotenv/config";
import type { GatewayConfig } from "./types.ts";

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
    port: Number(env.PORT ?? 3000),
    invoiceTtlMs: Number(env.INVOICE_TTL_MS ?? 10 * 60 * 1000),
    maxOffset: Number(env.MAX_OFFSET ?? 999),
  };
}
