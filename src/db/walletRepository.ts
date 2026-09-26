import { getDb, withTransaction } from './connection';
import { Kobo, kobo } from '../domain/money';

export interface WalletRow {
  deviceId: string;
  bankBalanceKobo: Kobo;
  offlineWalletKobo: Kobo;
  reservedKobo: Kobo;
  dailySentKobo: Kobo;
  dailyReceivedKobo: Kobo;
  dailyWindowStart: number;
  version: number;
  lastVerifiedAt: number | null;
}

function rowToWallet(row: any): WalletRow {
  return {
    deviceId: row.device_id,
    bankBalanceKobo: kobo(row.bank_balance_kobo),
    offlineWalletKobo: kobo(row.offline_wallet_kobo),
    reservedKobo: kobo(row.reserved_kobo),
    dailySentKobo: kobo(row.daily_sent_kobo),
    dailyReceivedKobo: kobo(row.daily_received_kobo),
    dailyWindowStart: row.daily_window_start,
    version: row.version,
    lastVerifiedAt: row.last_verified_at,
  };
}

export async function getWallet(deviceId: string): Promise<WalletRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>('SELECT * FROM wallet WHERE device_id = ?', [deviceId]);
  return row ? rowToWallet(row) : null;
}

export async function initWallet(deviceId: string): Promise<WalletRow> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `INSERT OR IGNORE INTO wallet
       (device_id, bank_balance_kobo, offline_wallet_kobo, reserved_kobo,
        daily_sent_kobo, daily_received_kobo, daily_window_start, version)
     VALUES (?, 0, 0, 0, 0, 0, ?, 0)`,
    [deviceId, now],
  );
  const row = await db.getFirstAsync<any>('SELECT * FROM wallet WHERE device_id = ?', [deviceId]);
  return rowToWallet(row);
}

/**
 * Optimistic-concurrency update: only WalletService should ever call this,
 * and only with a version it just read. UI code has no path to this
 * function at all (it isn't exported from services/index.ts).
 */
export async function applyWalletUpdate(
  deviceId: string,
  expectedVersion: number,
  patch: Partial<{
    bankBalanceKobo: Kobo;
    offlineWalletKobo: Kobo;
    reservedKobo: Kobo;
    dailySentKobo: Kobo;
    dailyReceivedKobo: Kobo;
    dailyWindowStart: number;
    lastVerifiedAt: number;
  }>,
): Promise<boolean> {
  return withTransaction(async (db) => {
    const fields: string[] = [];
    const params: (string | number)[] = [];
    const colMap: Record<string, string> = {
      bankBalanceKobo: 'bank_balance_kobo',
      offlineWalletKobo: 'offline_wallet_kobo',
      reservedKobo: 'reserved_kobo',
      dailySentKobo: 'daily_sent_kobo',
      dailyReceivedKobo: 'daily_received_kobo',
      dailyWindowStart: 'daily_window_start',
      lastVerifiedAt: 'last_verified_at',
    };
    for (const [key, col] of Object.entries(colMap)) {
      const value = (patch as any)[key];
      if (value !== undefined) {
        fields.push(`${col} = ?`);
        params.push(value);
      }
    }
    fields.push('version = version + 1');
    params.push(deviceId, expectedVersion);

    const result = await db.runAsync(
      `UPDATE wallet SET ${fields.join(', ')} WHERE device_id = ? AND version = ?`,
      params,
    );
    return result.changes === 1; // false means someone else updated it first — caller must retry
  });
}
