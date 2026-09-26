/**
 * Pushes locally COMMITTED/PENDING_RECONCILIATION transactions to the
 * backend. Every request carries the txId as the idempotency key; the
 * backend is what actually decides SETTLED vs REJECTED — this client
 * never marks itself SETTLED on its own say-so.
 */
import * as TxRepo from '../db/transactionRepository';
import * as WalletService from './WalletService';

const API_BASE_URL = 'https://REPLACE_WITH_YOUR_BACKEND_HOST'; // see backend/README or docs/SETUP.md

export interface SyncResult {
  syncedCount: number;
  pendingCount: number;
}

export async function runSync(deviceId: string): Promise<SyncResult> {
  const unsynced = await TxRepo.getUnsyncedTransactions();
  let syncedCount = 0;
  let pendingCount = 0;
  const syncedIds: string[] = [];

  for (const row of unsynced) {
    const signed = JSON.parse(row.signed_payload_json);
    const receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null;

    const response = await fetch(`${API_BASE_URL}/api/v1/transactions/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': row.tx_id },
      body: JSON.stringify({ transaction: signed, receipt, direction: row.direction }),
    });

    if (!response.ok) {
      pendingCount++;
      continue;
    }

    const body = await response.json();
    if (body.status === 'SETTLED') {
      await TxRepo.updateState(row.tx_id, 'SETTLED', { settledAt: Date.now() });
      syncedIds.push(row.tx_id);
      syncedCount++;
    } else if (body.status === 'REJECTED') {
      await TxRepo.updateState(row.tx_id, 'REJECTED', { failureReason: body.reason });
      syncedIds.push(row.tx_id);
      // If this was a receive that had been optimistically credited, the backend's
      // rejection means it must be reversed — a full implementation would call a
      // WalletService.reverseCreditedReceive(deviceId, amount) here; omitted from
      // this pass, flagged in docs/LIMITATIONS.md as a known gap to close before
      // any non-simulated use.
      syncedCount++;
    } else {
      pendingCount++;
    }
  }

  await TxRepo.markSynced(syncedIds);

  // Pull the authoritative balance down and reconcile local state.
  try {
    const balResponse = await fetch(`${API_BASE_URL}/api/v1/wallet/${deviceId}/balance`);
    if (balResponse.ok) {
      const bal = await balResponse.json();
      await WalletService.reconcileWithBackend(deviceId, {
        bankBalanceKobo: bal.bankBalanceKobo,
        offlineWalletKobo: bal.offlineWalletKobo,
      });
    }
  } catch {
    // No connectivity — fine, next sync attempt will retry. Local state is
    // never worse than "possibly stale," never corrupted.
  }

  return { syncedCount, pendingCount };
}
