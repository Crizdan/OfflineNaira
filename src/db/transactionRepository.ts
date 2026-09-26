import { getDb, withTransaction } from './connection';
import { SignedTransaction, SignedReceipt } from '../protocol/transaction';
import { TxState } from '../protocol/stateMachine';

export async function insertOutgoing(tx: SignedTransaction, state: TxState): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO transactions
       (tx_id, direction, counterparty_device_id, amount_kobo, state, protocol_version,
        nonce, created_at, expires_at, signed_payload_json, synced)
     VALUES (?, 'SENT', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      tx.txId,
      tx.receiverDeviceId,
      tx.amountKobo,
      state,
      tx.protocolVersion,
      tx.nonce,
      tx.createdAt,
      tx.expiresAt,
      JSON.stringify(tx),
    ],
  );
}

export async function insertIncoming(tx: SignedTransaction, state: TxState): Promise<void> {
  await withTransaction(async (db) => {
    await db.runAsync(
      `INSERT INTO transactions
         (tx_id, direction, counterparty_device_id, amount_kobo, state, protocol_version,
          nonce, created_at, expires_at, received_at, signed_payload_json, synced)
       VALUES (?, 'RECEIVED', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        tx.txId,
        tx.senderDeviceId,
        tx.amountKobo,
        state,
        tx.protocolVersion,
        tx.nonce,
        tx.createdAt,
        tx.expiresAt,
        Date.now(),
        JSON.stringify(tx),
      ],
    );
    await db.runAsync(
      `INSERT INTO seen_nonces (nonce, tx_id, seen_at, expires_at) VALUES (?, ?, ?, ?)`,
      [tx.nonce, tx.txId, Date.now(), tx.expiresAt],
    );
  });
}

export async function updateState(
  txId: string,
  state: TxState,
  extra: Partial<{
    offeredAt: number;
    committedAt: number;
    confirmedAt: number;
    settledAt: number;
    failureReason: string;
    receipt: SignedReceipt;
  }> = {},
): Promise<void> {
  const db = await getDb();
  const fields = ['state = ?'];
  const params: (string | number)[] = [state];
  if (extra.offeredAt !== undefined) { fields.push('offered_at = ?'); params.push(extra.offeredAt); }
  if (extra.committedAt !== undefined) { fields.push('committed_at = ?'); params.push(extra.committedAt); }
  if (extra.confirmedAt !== undefined) { fields.push('confirmed_at = ?'); params.push(extra.confirmedAt); }
  if (extra.settledAt !== undefined) { fields.push('settled_at = ?'); params.push(extra.settledAt); }
  if (extra.failureReason !== undefined) { fields.push('failure_reason = ?'); params.push(extra.failureReason); }
  if (extra.receipt !== undefined) { fields.push('receipt_json = ?'); params.push(JSON.stringify(extra.receipt)); }
  params.push(txId);
  await db.runAsync(`UPDATE transactions SET ${fields.join(', ')} WHERE tx_id = ?`, params);
}

export async function markPendingSettlement(txId: string, reason: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR IGNORE INTO pending_settlements (tx_id, reason, created_at, resolved)
     VALUES (?, ?, ?, 0)`,
    [txId, reason, Date.now()],
  );
}

export async function getUnsyncedTransactions(): Promise<any[]> {
  const db = await getDb();
  return db.getAllAsync<any>('SELECT * FROM transactions WHERE synced = 0');
}

export async function markSynced(txIds: string[]): Promise<void> {
  if (txIds.length === 0) return;
  const db = await getDb();
  for (const id of txIds) {
    await db.runAsync(`UPDATE transactions SET synced = 1 WHERE tx_id = ?`, [id]);
  }
}

export async function getHistory(limit = 50): Promise<any[]> {
  const db = await getDb();
  return db.getAllAsync<any>('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?', [limit]);
}
