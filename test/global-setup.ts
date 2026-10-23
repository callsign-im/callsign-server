import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { testEnv } from "./env.ts";

export async function setup() {
  const sql = postgres(testEnv.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`drop schema if exists public cascade`;
    await sql`drop schema if exists drizzle cascade`;
    await sql`create schema public`;
    await migrate(drizzle({ client: sql }), { migrationsFolder: "./drizzle" });
  } finally {
    await sql.end();
  }
}
