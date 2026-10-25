import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<PgQueryResultHKT & any, Schema>;

export interface DbHandle {
  db: Db;
  driver: "pg" | "pglite";
  close: () => Promise<void>;
  migrate: () => Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_FOLDER = path.resolve(here, "../drizzle");

/**
 * DATABASE_URL:
 *   postgres://...   -> node-postgres pool (dev via docker compose, production)
 *   memory:          -> in-process PGlite (tests)
 *   pglite:<dir>     -> file-backed PGlite (single-process demos only)
 */
export function createDb(url = process.env.DATABASE_URL ?? "", opts: { migrationsFolder?: string } = {}): DbHandle {
  const migrationsFolder = opts.migrationsFolder ?? MIGRATIONS_FOLDER;
  if (url === "memory:" || url.startsWith("pglite:")) {
    const dataDir = url === "memory:" ? undefined : url.slice("pglite:".length);
    const client = new PGlite(dataDir);
    const db = drizzlePglite(client, { schema }) as unknown as Db;
    return {
      db,
      driver: "pglite",
      close: () => client.close(),
      migrate: () => migratePglite(db as never, { migrationsFolder }),
    };
  }
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  const db = drizzlePg(pool, { schema }) as unknown as Db;
  return {
    db,
    driver: "pg",
    close: () => pool.end(),
    migrate: () => migratePg(db as never, { migrationsFolder }),
  };
}

// Process-wide singleton for the web app / worker.
const g = globalThis as unknown as { __mbDb?: DbHandle };
export function getDb(): Db {
  if (!g.__mbDb) g.__mbDb = createDb();
  return g.__mbDb.db;
}
export function setDbHandle(h: DbHandle) {
  g.__mbDb = h;
}
