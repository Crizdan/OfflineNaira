/**
* WalletService is the single choke point for every balance change in the
* app. Screens and components call methods on this service and get back a
* result — there is no exported function anywhere that lets a component
* write to the `wallet` table directly.
*/
import * as WalletRepo from '../db/walletRepository';
import { Kobo, kobo, addKobo, subKobo } from '../domain/money';

// Offline spending caps — a real deployment would fetch these per-user
// risk tier from the backend during sync; hardcoded here for the prototype.
export const OFFLINE_LIMITS = {
  maxSingleSendKobo: kobo(20_000_00), // ₦20,000 per transaction
  maxDailySendKobo: kobo(50_000_00), // ₦50,000 per rolling day, offline
  maxDailyReceiveKobo: kobo(100_000_00),
};

export type WalletErrorCode =
  | 'WALLET_NOT_INITIALIZED'
  | 'INSUFFICIENT_OFFLINE_BALANCE'
  | 'EXCEEDS_SINGLE_LIMIT'
  | 'EXCEEDS_DAILY_SEND_LIMIT'
  | 'EXCEEDS_DAILY_RECEIVE_LIMIT'
  | 'CONCURRENT_UPDATE_CONFLICT';

export class WalletError extends Error {
  constructor(public code: WalletErrorCode, message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

function rollDailyWindowIfNeeded(wallet: WalletRepo.WalletRow): {
  dailySentKobo: Kobo;
  dailyReceivedKobo: Kobo;
  dailyWindowStart: number;
} {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (now - wallet.dailyWindowStart >= ONE_DAY_MS) {
    return { dailySentKobo: kobo(0), dailyReceivedKobo: kobo(0), dailyWindowStart: now };
  }
  return {
    dailySentKobo: wallet.dailySentKobo,
    dailyReceivedKobo: wallet.dailyReceivedKobo,
    dailyWindowStart: wallet.dailyWindowStart,
  };
}

/**
* Step 1 of a send: reserve funds against the offline wallet. This moves
* money from `offlineWalletKobo` into `reservedKobo` — it does NOT
* subtract it entirely, so a failed/rejected send can be released back.
* Retries once on optimistic-concurrency conflict.
*/
export async function reserveForSend(deviceId: string, amount: Kobo): Promise<void> {
  if (amount > OFFLINE_LIMITS.maxSingleSendKobo) {
    throw new WalletError('EXCEEDS_SINGLE_LIMIT', 'Amount exceeds per-transaction offline limit');
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const wallet = await WalletRepo.getWallet(deviceId);
    if (!wallet) throw new WalletError('WALLET_NOT_INITIALIZED', 'Wallet not initialized');

    const { dailySentKobo, dailyWindowStart } = rollDailyWindowIfNeeded(wallet);

    if (amount > wallet.offlineWalletKobo) {
      throw new WalletError(
        'INSUFFICIENT_OFFLINE_BALANCE',
        'Offline wallet balance is too low for this send',
      );
    }
    if (addKobo(dailySentKobo, amount) > OFFLINE_LIMITS.maxDailySendKobo) {
      throw new WalletError('EXCEEDS_DAILY_SEND_LIMIT', 'Daily offline send limit reached');
    }

    const ok = await WalletRepo.applyWalletUpdate(deviceId, wallet.version, {
      offlineWalletKobo: subKobo(wallet.offlineWalletKobo, amount),
      reservedKobo: addKobo(wallet.reservedKobo, amount),
      dailySentKobo: addKobo(dailySentKobo, amount),
      dailyWindowStart,
    });
    if (ok) return;
  }
  throw new WalletError('CONCURRENT_UPDATE_CONFLICT', 'Could not reserve funds after retries');
}

/** Called when a send is CONFIRMED: the reservation is now permanently spent. */
export async function commitReservedSend(deviceId: string, amount: Kobo): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wallet = await WalletRepo.getWallet(deviceId);
    if (!wallet) throw new WalletError('WALLET_NOT_INITIALIZED', 'Wallet not initialized');
    const ok = await WalletRepo.applyWalletUpdate(deviceId, wallet.version, {
      reservedKobo: subKobo(wallet.reservedKobo, amount),
    });
    if (ok) return;
  }
  throw new WalletError('CONCURRENT_UPDATE_CONFLICT', 'Could not commit reserved send');
}

/** Called when a send FAILS/REJECTED/TIMEOUT: give the reserved funds back. */
export async function releaseReservation(deviceId: string, amount: Kobo): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wallet = await WalletRepo.getWallet(deviceId);
    if (!wallet) throw new WalletError('WALLET_NOT_INITIALIZED', 'Wallet not initialized');
    const ok = await WalletRepo.applyWalletUpdate(deviceId, wallet.version, {
      reservedKobo: subKobo(wallet.reservedKobo, amount),
      offlineWalletKobo: addKobo(wallet.offlineWalletKobo, amount),
    });
    if (ok) return;
  }
  throw new WalletError('CONCURRENT_UPDATE_CONFLICT', 'Could not release reservation');
}

/** Receiver side: credit arrives as PENDING until backend settlement confirms it. */
export async function creditPendingReceive(deviceId: string, amount: Kobo): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wallet = await WalletRepo.getWallet(deviceId);
    if (!wallet) throw new WalletError('WALLET_NOT_INITIALIZED', 'Wallet not initialized');

    const { dailyReceivedKobo, dailyWindowStart } = rollDailyWindowIfNeeded(wallet);
    if (addKobo(dailyReceivedKobo, amount) > OFFLINE_LIMITS.maxDailyReceiveKobo) {
      throw new WalletError('EXCEEDS_DAILY_RECEIVE_LIMIT', 'Daily offline receive limit reached');
    }

    const ok = await WalletRepo.applyWalletUpdate(deviceId, wallet.version, {
      offlineWalletKobo: addKobo(wallet.offlineWalletKobo, amount),
      dailyReceivedKobo: addKobo(dailyReceivedKobo, amount),
      dailyWindowStart,
    });
    if (ok) return;
  }
  throw new WalletError('CONCURRENT_UPDATE_CONFLICT', 'Could not credit pending receive');
}

/** Mock Bank Gateway: deposits custom demo funds directly into the offline wallet. */
export async function depositOfflineFunds(deviceId: string, amount: Kobo): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wallet = await WalletRepo.getWallet(deviceId);
    if (!wallet) throw new WalletError('WALLET_NOT_INITIALIZED', 'Wallet not initialized');

    const ok = await WalletRepo.applyWalletUpdate(deviceId, wallet.version, {
      offlineWalletKobo: addKobo(wallet.offlineWalletKobo, amount),
    });
    if (ok) return;
  }
  throw new WalletError('CONCURRENT_UPDATE_CONFLICT', 'Could not deposit mock funds');
}

/** Called after a successful backend sync to overwrite local state with the ledger truth. */
export async function reconcileWithBackend(
  deviceId: string,
  authoritative: { bankBalanceKobo: Kobo; offlineWalletKobo: Kobo },
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wallet = await WalletRepo.getWallet(deviceId);
    if (!wallet) throw new WalletError('WALLET_NOT_INITIALIZED', 'Wallet not initialized');
    const ok = await WalletRepo.applyWalletUpdate(deviceId, wallet.version, {
      bankBalanceKobo: authoritative.bankBalanceKobo,
      offlineWalletKobo: authoritative.offlineWalletKobo,
      lastVerifiedAt: Date.now(),
    });
    if (ok) return;
  }
  throw new WalletError('CONCURRENT_UPDATE_CONFLICT', 'Could not reconcile wallet');
}

export async function getWalletSnapshot(deviceId: string): Promise<WalletRepo.WalletRow> {
  const wallet = await WalletRepo.getWallet(deviceId);
  if (!wallet) throw new WalletError('WALLET_NOT_INITIALIZED', 'Wallet not initialized');
  return wallet;
}