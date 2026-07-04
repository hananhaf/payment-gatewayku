import mysql from "mysql2/promise";

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
  return { host: env.DB_HOST?.trim() || "localhost", port, user, password, database };
}

/**
 * Open a MySQL connection pool and ensure the schema exists.
 * Timestamps are stored as epoch-ms (BIGINT) — identical to the app's matching /
 * expiry logic and free of timezone ambiguity.
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
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id               VARCHAR(32)  NOT NULL,
      merchant_id      VARCHAR(64)  NOT NULL,
      base_amount      BIGINT UNSIGNED NOT NULL,
      unique_amount    BIGINT UNSIGNED NOT NULL,
      qr_string        TEXT         NOT NULL,
      status           ENUM('pending','paid','expired') NOT NULL DEFAULT 'pending',
      order_id         VARCHAR(191) NULL,
      callback_url     VARCHAR(512) NULL,
      idempotency_key  VARCHAR(191) NULL,
      callback_sent    TINYINT(1)   NOT NULL DEFAULT 0,
      created_at       BIGINT UNSIGNED NOT NULL,
      expires_at       BIGINT UNSIGNED NOT NULL,
      paid_at          BIGINT UNSIGNED NULL,
      PRIMARY KEY (id),
      KEY idx_match   (merchant_id, status, unique_amount),
      KEY idx_history (merchant_id, status, paid_at),
      UNIQUE KEY uq_idem (merchant_id, idempotency_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  return pool;
}
