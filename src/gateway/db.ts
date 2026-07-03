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

  // Migrate an older table that predates multi-merchant.
  const cols = (db.prepare("PRAGMA table_info(invoices)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("merchant_id")) {
    db.exec("ALTER TABLE invoices ADD COLUMN merchant_id TEXT NOT NULL DEFAULT 'default'");
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_invoices_merchant_status_amount
             ON invoices(merchant_id, status, unique_amount)`);
  return db;
}
