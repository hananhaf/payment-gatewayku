import { openDb, type DbConfig } from "./db.ts";

/** Test MySQL config — the local Docker container (override via TEST_DB_* env). */
export function testDbConfig(): DbConfig {
  const e = process.env;
  return {
    host: e.TEST_DB_HOST || "127.0.0.1",
    port: Number(e.TEST_DB_PORT || 3307),
    user: e.TEST_DB_USER || "gwuser",
    password: e.TEST_DB_PASSWORD || "gwpass",
    database: e.TEST_DB_NAME || "gateway_test",
  };
}

/** Open a pool against the test DB and ensure the schema exists. */
export function openTestDb() {
  return openDb(testDbConfig());
}
