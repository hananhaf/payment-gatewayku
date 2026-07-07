import { existsSync, readFileSync } from "node:fs";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { validateQRIS } from "../core/index.ts";
import type { Merchant } from "./types.ts";

export function validateMerchants(list: unknown, source: string): Merchant[] {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${source}: expected a non-empty array of merchants`);
  }
  const seen = new Set<string>();
  const seenKeys = new Set<string>();
  return list.map((raw, i) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${source}: merchant #${i} is not an object`);
    }
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
    const apiKey = (m.apiKey as string).trim();
    if (seenKeys.has(apiKey)) throw new Error(`${source}: duplicate apiKey for merchant "${id}"`);
    seenKeys.add(apiKey);
    const optStr = (k: string) => (typeof m[k] === "string" && (m[k] as string).trim() ? (m[k] as string).trim() : null);
    return {
      id,
      name: (m.name as string).trim(),
      qris,
      apiKey,
      active: typeof m.active === "boolean" ? m.active : undefined,
      bankName: optStr("bankName"),
      bankAccount: optStr("bankAccount"),
      bankHolder: optStr("bankHolder"),
    };
  });
}

/**
 * Load merchants. Precedence: env MERCHANTS_B64 (base64 of the JSON) → MERCHANTS (raw
 * JSON) → ./merchants.json → legacy STATIC_QRIS + API_KEY (single "default" merchant).
 *
 * MERCHANTS_B64 exists because many env editors mangle raw JSON (escaping quotes /
 * inserting backslashes). Base64 uses only [A-Za-z0-9+/=], so it survives copy-paste
 * intact.
 */
export function loadMerchants(env: NodeJS.ProcessEnv = process.env): Merchant[] {
  if (env.MERCHANTS_B64?.trim()) {
    let json: string;
    try {
      json = Buffer.from(env.MERCHANTS_B64.trim(), "base64").toString("utf8");
    } catch (e) {
      throw new Error(`MERCHANTS_B64 is not valid base64: ${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      throw new Error(`MERCHANTS_B64 decoded to invalid JSON: ${(e as Error).message}`);
    }
    return validateMerchants(parsed, "MERCHANTS_B64 env");
  }

  if (env.MERCHANTS?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.MERCHANTS);
    } catch (e) {
      throw new Error(`MERCHANTS env is not valid JSON: ${(e as Error).message}`);
    }
    return validateMerchants(parsed, "MERCHANTS env");
  }

  const file = env.MERCHANTS_FILE?.trim() || "merchants.json";
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
    }
    return validateMerchants(parsed, file);
  }

  const staticQris = env.STATIC_QRIS?.trim();
  const apiKey = env.API_KEY?.trim();
  if (staticQris && apiKey) {
    return validateMerchants([{ id: "default", name: "Default", qris: staticQris, apiKey }], "STATIC_QRIS");
  }

  throw new Error(
    "no merchants configured: set MERCHANTS (JSON), or merchants.json, or STATIC_QRIS + API_KEY"
  );
}

interface MerchantRow extends RowDataPacket {
  id: string;
  name: string;
  qris: string;
  api_key: string;
  active: 0 | 1;
  bank_name: string | null;
  bank_account: string | null;
  bank_holder: string | null;
}

function rowToMerchant(row: MerchantRow): Merchant {
  return {
    id: row.id,
    name: row.name,
    qris: row.qris,
    apiKey: row.api_key,
    active: Boolean(row.active),
    bankName: row.bank_name ?? null,
    bankAccount: row.bank_account ?? null,
    bankHolder: row.bank_holder ?? null,
  };
}

export async function loadActiveMerchantsFromDb(pool: Pool): Promise<Merchant[]> {
  const [rows] = await pool.query<MerchantRow[]>(
    `SELECT id, name, qris, api_key, active, bank_name, bank_account, bank_holder
       FROM merchants WHERE active=1 ORDER BY id`
  );
  const merchants = rows.map(rowToMerchant);
  return validateMerchants(merchants, "merchants table");
}

export async function seedMerchantsFromEnvIfEmpty(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const [rows] = await pool.query<(RowDataPacket & { n: number })[]>(`SELECT COUNT(*) AS n FROM merchants`);
  if (Number(rows[0]?.n ?? 0) > 0) return;

  let merchants: Merchant[];
  try {
    merchants = loadMerchants(env);
  } catch {
    return;
  }

  for (const m of merchants) {
    await pool.query(
      `INSERT INTO merchants (id, name, qris, api_key, active, bank_name, bank_account, bank_holder)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), qris=VALUES(qris), api_key=VALUES(api_key), active=1`,
      [m.id, m.name, m.qris, m.apiKey, m.bankName ?? null, m.bankAccount ?? null, m.bankHolder ?? null]
    );
  }
}
