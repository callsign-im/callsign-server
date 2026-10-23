import { db, sql } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { logger } from "./lib/logger.ts";

try {
  await runMigrations(db);
  logger.info("migrations applied");
} catch (error) {
  logger.error({ err: error }, "migration failed");
  process.exitCode = 1;
} finally {
  await sql.end();
}
