import { test } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { openDb } from "./db.ts";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";

test("fresh DB has a merchant_id column on invoices", () => {
  const db = openDb(":memory:");
  const cols = (db.prepare("PRAGMA table_info(invoices)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("merchant_id"), `merchant_id missing; got ${cols.join(",")}`);
});

test("migrates an existing pre-multi-merchant table, defaulting old rows to 'default'", () => {
  const file = path.join(tmpdir(), `gw-${randomBytes(6).toString("hex")}.db`);
  try {
    const old = new Database(file);
    old.exec(`CREATE TABLE invoices (
      id TEXT PRIMARY KEY, base_amount INTEGER NOT NULL, unique_amount INTEGER NOT NULL,
      qr_string TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, paid_at INTEGER)`);
    old.prepare(`INSERT INTO invoices VALUES ('old1',1000,1001,'q','pending',1,2,NULL)`).run();
    old.close();

    const db = openDb(file); // must ALTER TABLE ADD COLUMN merchant_id
    const cols = (db.prepare("PRAGMA table_info(invoices)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("merchant_id"));
    const row = db.prepare("SELECT merchant_id FROM invoices WHERE id='old1'").get() as { merchant_id: string };
    assert.equal(row.merchant_id, "default");
    db.close();
  } finally {
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }
});
