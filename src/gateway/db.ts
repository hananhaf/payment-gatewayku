import Database from "better-sqlite3";

export function openDb(file = "gateway.db"): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      base_amount INTEGER NOT NULL,
      unique_amount INTEGER NOT NULL,
      qr_string TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      paid_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_status_amount
      ON invoices(status, unique_amount);
  `);
  return db;
}
