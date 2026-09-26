import * as SQLite from 'expo-sqlite';
import { SCHEMA_SQL } from './schema';

let dbInstance: SQLite.SQLiteDatabase | null = null;
// Caching the in-flight promise (not just the resolved instance) matters:
// several screens call getDb() independently on mount (HistoryScreen,
// WalletScreen, etc. via their own repository calls). Without this, two
// concurrent first-callers could both pass the `if (dbInstance)` check
// before either finishes opening the DB, and both then run
// execAsync(SCHEMA_SQL) at once — expo-sqlite can throw "database is
// locked" when DDL runs concurrently like that.
let openPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function openAndInitialize(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync('offline_naira.db');
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync(SCHEMA_SQL);
  return db;
}

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (dbInstance) return dbInstance;
  if (!openPromise) {
    openPromise = openAndInitialize()
      .then((db) => {
        dbInstance = db;
        return db;
      })
      .catch((err) => {
        // Let the next call retry from scratch instead of being stuck
        // replaying a rejected promise forever.
        openPromise = null;
        throw err;
      });
  }
  return openPromise;
}

/**
 * Explicit, named entry point for app-startup provisioning (see
 * src/services/AppProvisioning.tsx) — same as getDb(), just named for
 * what it's doing at that call site: create tables if they don't exist
 * yet. Safe to call from multiple places; safe to call again after a
 * previous attempt failed.
 */
export async function initializeDatabase(): Promise<void> {
  await getDb();
}

/**
 * Runs `fn` inside an exclusive transaction. Only queries run through the
 * `db` handle passed into `fn` are part of the transaction — this mirrors
 * expo-sqlite's `withExclusiveTransactionAsync`, whose task callback
 * receives a transaction handle with the same query methods as
 * SQLiteDatabase (runAsync/getFirstAsync/getAllAsync/execAsync).
 */
export async function withTransaction<T>(
  fn: (db: SQLite.SQLiteDatabase) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  let result!: T;
  await db.withExclusiveTransactionAsync(async (txn) => {
    result = await fn(txn as unknown as SQLite.SQLiteDatabase);
  });
  return result;
}
