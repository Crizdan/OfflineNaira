import * as SQLite from 'expo-sqlite';
import { SCHEMA_SQL } from './schema';

let dbInstance: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (dbInstance) return dbInstance;
  const db = await SQLite.openDatabaseAsync('offline_naira.db');
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync(SCHEMA_SQL);
  dbInstance = db;
  return db;
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
