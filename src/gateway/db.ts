import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Read MySQL connection config from env (DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME). */
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const user = env.DB_USER?.trim();
  const password = env.DB_PASSWORD ?? "";
  const database = env.DB_NAME?.trim();
  if (!user) throw new Error("DB_USER env is required");
  if (!database) throw new Error("DB_NAME env is required");
  const port = Number(env.DB_PORT ?? 3306);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`DB_PORT must be a port number, got "${env.DB_PORT}"`);
  return { host: env.DB_HOST?.trim() || "127.0.0.1", port, user, password, database };
}

/**
 * Open a MySQL connection pool and ensure the schema exists.
 * Timestamps are DATETIME(3) (millisecond precision, human-readable in phpMyAdmin);
 * the pool runs in UTC so the app's epoch-ms values round-trip exactly.
 */
export async function openDb(cfg: DbConfig): Promise<mysql.Pool> {
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 8,
    charset: "utf8mb4",
    timezone: "Z", // store/read DATETIME as UTC so Date <-> DB is lossless
  });

  // Merchants are editable in phpMyAdmin/admin without redeploy.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS merchants (
      id          VARCHAR(64)  NOT NULL,
      name        VARCHAR(191) NOT NULL,
      qris        TEXT         NOT NULL,
      api_key     VARCHAR(128) NOT NULL,
      active      TINYINT(1)   NOT NULL DEFAULT 1,
      bank_name    VARCHAR(64)  NULL,
      bank_account VARCHAR(64)  NULL,
      bank_holder  VARCHAR(191) NULL,
      created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_merchant_apikey (api_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await ensureColumn(pool, "merchants", "bank_name", "bank_name VARCHAR(64) NULL");
  await ensureColumn(pool, "merchants", "bank_account", "bank_account VARCHAR(64) NULL");
  await ensureColumn(pool, "merchants", "bank_holder", "bank_holder VARCHAR(191) NULL");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id               VARCHAR(32)  NOT NULL,
      merchant_id      VARCHAR(64)  NOT NULL,
      base_amount      BIGINT UNSIGNED NOT NULL,
      unique_amount    BIGINT UNSIGNED NOT NULL,
      qr_string        TEXT         NOT NULL,
      status           ENUM('pending','paid','expired') NOT NULL DEFAULT 'pending',
      method           VARCHAR(16)  NOT NULL DEFAULT 'qris',
      order_id         VARCHAR(191) NULL,
      callback_url     VARCHAR(512) NULL,
      idempotency_key  VARCHAR(191) NULL,
      callback_sent    TINYINT(1)   NOT NULL DEFAULT 0,
      created_at       DATETIME(3)  NOT NULL,
      expires_at       DATETIME(3)  NOT NULL,
      paid_at          DATETIME(3)  NULL,
      PRIMARY KEY (id),
      KEY idx_match   (merchant_id, status, unique_amount),
      KEY idx_history (merchant_id, status, paid_at),
      UNIQUE KEY uq_idem (merchant_id, idempotency_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await ensureColumn(pool, "invoices", "method", "method VARCHAR(16) NOT NULL DEFAULT 'qris' AFTER status");
  await migrateInvoiceTimestamps(pool);

  // Audit log of every forwarded notification and whether it settled an invoice.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      merchant_id        VARCHAR(64)  NULL,
      amount             BIGINT UNSIGNED NULL,
      matched            TINYINT(1)   NOT NULL DEFAULT 0,
      matched_invoice_id VARCHAR(32)  NULL,
      package_name       VARCHAR(191) NULL,
      raw_text           TEXT         NULL,
      raw_payload        LONGTEXT     NULL,
      received_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_notif (merchant_id, received_at),
      KEY idx_notif_match (merchant_id, matched, received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureColumn(pool, "notifications", "matched", "matched TINYINT(1) NOT NULL DEFAULT 0 AFTER amount");

  return pool;
}

async function ensureColumn(pool: mysql.Pool, table: string, column: string, ddl: string): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (Number(rows[0]?.n ?? 0) === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

async function migrateInvoiceTimestamps(pool: mysql.Pool): Promise<void> {
  const columns = [
    { name: "created_at", required: true },
    { name: "expires_at", required: true },
    { name: "paid_at", required: false },
  ] as const;
  const types = await Promise.all(columns.map((c) => columnType(pool, "invoices", c.name)));
  if (types.every((t) => t?.startsWith("datetime"))) return;

  await dropIndexIfExists(pool, "invoices", "idx_history");
  for (const c of columns) {
    const type = await columnType(pool, "invoices", c.name);
    if (!type || type.startsWith("datetime")) continue;
    await migrateEpochMsColumn(pool, "invoices", c.name, c.required);
  }
  await pool.query(`CREATE INDEX idx_history ON invoices (merchant_id, status, paid_at)`);
}

async function columnType(pool: mysql.Pool, table: string, column: string): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DATA_TYPE AS type
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return typeof rows[0]?.type === "string" ? rows[0].type.toLowerCase() : null;
}

async function dropIndexIfExists(pool: mysql.Pool, table: string, index: string): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index]
  );
  if (Number(rows[0]?.n ?? 0) > 0) {
    await pool.query(`DROP INDEX ${index} ON ${table}`);
  }
}

async function migrateEpochMsColumn(
  pool: mysql.Pool,
  table: string,
  column: string,
  required: boolean
): Promise<void> {
  const tmp = `${column}_dt_tmp`;
  if (await columnType(pool, table, tmp)) {
    await pool.query(`ALTER TABLE ${table} DROP COLUMN ${tmp}`);
  }
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${tmp} DATETIME(3) NULL`);
  await pool.query(
    `UPDATE ${table}
        SET ${tmp} = CASE WHEN ${column} IS NULL THEN NULL ELSE FROM_UNIXTIME(${column} / 1000) END`
  );
  await pool.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  await pool.query(
    `ALTER TABLE ${table} CHANGE COLUMN ${tmp} ${column} DATETIME(3) ${required ? "NOT NULL" : "NULL"}`
  );
}
