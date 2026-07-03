import Database from "better-sqlite3";

export function openDb(file = "gateway.db"): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL DEFAULT 'default',
      base_amount INTEGER NOT NULL,
      unique_amount INTEGER NOT NULL,
      qr_string TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      paid_at INTEGER
    );
  `);

  // Migrate older tables in place (ALTER ADD COLUMN is a no-op safe add).
  const cols = (db.prepare("PRAGMA table_info(invoices)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("merchant_id")) {
    db.exec("ALTER TABLE invoices ADD COLUMN merchant_id TEXT NOT NULL DEFAULT 'default'");
  }
  // POS API columns.
  if (!cols.includes("order_id")) db.exec("ALTER TABLE invoices ADD COLUMN order_id TEXT");
  if (!cols.includes("callback_url")) db.exec("ALTER TABLE invoices ADD COLUMN callback_url TEXT");
  if (!cols.includes("idempotency_key")) db.exec("ALTER TABLE invoices ADD COLUMN idempotency_key TEXT");
  if (!cols.includes("callback_sent")) db.exec("ALTER TABLE invoices ADD COLUMN callback_sent INTEGER NOT NULL DEFAULT 0");

  db.exec("DROP INDEX IF EXISTS idx_invoices_status_amount");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_invoices_merchant_status_amount
             ON invoices(merchant_id, status, unique_amount)`);
  // Idempotency: at most one invoice per (merchant, idempotency_key).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_idempotency
             ON invoices(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  return db;
}
