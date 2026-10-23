import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.ts";
import { logger } from "../lib/logger.ts";
import * as schema from "./schema.ts";

const ssl = config.PGSSLMODE === "disable" ? false : config.PGSSLMODE;
const options = {
  max: config.DATABASE_POOL_SIZE,
  onnotice: () => {},
  ...(ssl !== undefined && { ssl }),
};

export const sql = config.DATABASE_URL ? postgres(config.DATABASE_URL, options) : postgres(options);

export const db = drizzle({ client: sql, schema });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

const INVALID_PASSWORD = "28P01";

export function exitOnRejectedCredentials(error: unknown): void {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === INVALID_PASSWORD) {
      logger.fatal("database rejected the credentials, exiting so a fresh task can start");
      process.exit(1);
    }
  }
}
