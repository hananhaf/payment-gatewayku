import { existsSync, readFileSync } from "node:fs";
import { validateQRIS } from "../core/index.ts";
import type { Merchant } from "./types.ts";

function validate(list: unknown, source: string): Merchant[] {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${source}: expected a non-empty array of merchants`);
  }
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const m = raw as Record<string, unknown>;
    for (const field of ["id", "name", "qris", "apiKey"] as const) {
      if (typeof m[field] !== "string" || (m[field] as string).trim() === "") {
        throw new Error(`${source}: merchant #${i} is missing required string field "${field}"`);
      }
    }
    const id = (m.id as string).trim();
    if (seen.has(id)) throw new Error(`${source}: duplicate merchant id "${id}"`);
    seen.add(id);
    const qris = (m.qris as string).trim();
    const check = validateQRIS(qris);
    if (!check.valid) {
      throw new Error(`${source}: merchant "${id}" has an invalid QRIS: ${check.errors.join("; ")}`);
    }
    return { id, name: (m.name as string).trim(), qris, apiKey: (m.apiKey as string).trim() };
  });
}

/**
 * Load merchants. Precedence: env MERCHANTS (JSON) → ./merchants.json → legacy
 * STATIC_QRIS + API_KEY (single "default" merchant, backward compat).
 */
export function loadMerchants(env: NodeJS.ProcessEnv = process.env): Merchant[] {
  if (env.MERCHANTS?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.MERCHANTS);
    } catch (e) {
      throw new Error(`MERCHANTS env is not valid JSON: ${(e as Error).message}`);
    }
    return validate(parsed, "MERCHANTS env");
  }

  const file = env.MERCHANTS_FILE?.trim() || "merchants.json";
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
    }
    return validate(parsed, file);
  }

  const staticQris = env.STATIC_QRIS?.trim();
  const apiKey = env.API_KEY?.trim();
  if (staticQris && apiKey) {
    return validate([{ id: "default", name: "Default", qris: staticQris, apiKey }], "STATIC_QRIS");
  }

  throw new Error(
    "no merchants configured: set MERCHANTS (JSON), or merchants.json, or STATIC_QRIS + API_KEY"
  );
}
