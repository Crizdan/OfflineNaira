/**
 * PaymentEngine orchestrates a single transaction through the state
 * machine, calling WalletService for every balance change and
 * TransactionRepository for every persistence step. Screens call
 * PaymentEngine, never the pieces underneath directly.
 */
import { Kobo } from '../domain/money';
import {
  buildUnsignedTransaction,
  signTransaction,
  validateSignedTransaction,
  signReceipt,
  verifyReceipt,
  newTxId,
  SignedTransaction,
  SignedReceipt,
} from '../protocol/transaction';
import { TxState, assertTransition } from '../protocol/stateMachine';
import * as WalletService from './WalletService';
import * as TxRepo from '../db/transactionRepository';
import { BleService, CHARACTERISTICS } from './ble/BleService';

export interface SendResult {
  txId: string;
  finalState: TxState;
  failureReason?: string;
}

export class PaymentEngine {
  constructor(
    private ble: BleService,
    private myDeviceId: string,
    private myPublicKeyB64: string,
  ) {}

  /**
   * Full sender-side flow: CREATED -> SIGNED -> OFFERED -> (wait for receipt)
   * -> COMMITTED -> CONFIRMED, with reservation/release around it and
   * PENDING_RECONCILIATION as the safety net if BLE drops mid-flow.
   */
  async sendPayment(receiverDeviceId: string, amountKobo: Kobo): Promise<SendResult> {
    const txId = newTxId();
    let state: TxState = 'CREATED';

    await WalletService.reserveForSend(this.myDeviceId, amountKobo);

    try {
      const unsigned = buildUnsignedTransaction({
        txId,
        senderDeviceId: this.myDeviceId,
        senderPublicKeyB64: this.myPublicKeyB64,
        receiverDeviceId,
        amountKobo,
      });

      state = advance(state, 'SIGNED');
      const signed = await signTransaction(unsigned);
      await TxRepo.insertOutgoing(signed, state);

      state = advance(state, 'OFFERED');
      await TxRepo.updateState(txId, state, { offeredAt: Date.now() });
      await this.offerOverBle(signed);

      const receipt = await this.waitForReceipt(txId, 30_000);
      if (!receipt) {
        return await this.failOutstanding(txId, amountKobo, 'TIMEOUT', 'no_receipt_before_timeout');
      }

      if (!verifyReceipt(receipt)) {
        return await this.failOutstanding(txId, amountKobo, 'FAILED', 'bad_receipt_signature');
      }

      // verifyReceipt only proves the receipt is internally self-consistent
      // (signature matches its own embedded deviceId/pubkey pair) — it
      // doesn't prove it came from the device this payment was actually
      // meant for. Check that explicitly.
      if (receipt.receiverDeviceId !== receiverDeviceId) {
        return await this.failOutstanding(txId, amountKobo, 'FAILED', 'receipt_from_wrong_device');
      }

      if (receipt.status === 'REJECTED') {
        state = advance(state, 'REJECTED');
        await TxRepo.updateState(txId, state, { failureReason: receipt.reason ?? 'receiver_rejected' });
        await WalletService.releaseReservation(this.myDeviceId, amountKobo);
        return { txId, finalState: state, failureReason: receipt.reason };
      }

      // Receiver ACCEPTED and (by protocol) has already COMMITTED locally.
      state = advance(state, 'COMMITTED');
      await TxRepo.updateState(txId, state, { committedAt: Date.now() });
      await WalletService.commitReservedSend(this.myDeviceId, amountKobo);

      state = advance(state, 'CONFIRMED');
      await TxRepo.updateState(txId, state, { confirmedAt: Date.now(), receipt });

      return { txId, finalState: state };
    } catch (err) {
      return await this.failOutstanding(
        txId,
        amountKobo,
        'PENDING_RECONCILIATION',
        err instanceof Error ? err.message : 'unknown_error',
      );
    }
  }

  private async failOutstanding(
    txId: string,
    amountKobo: Kobo,
    finalState: 'TIMEOUT' | 'FAILED' | 'PENDING_RECONCILIATION',
    reason: string,
  ): Promise<SendResult> {
    await TxRepo.updateState(txId, finalState, { failureReason: reason });
    if (finalState === 'PENDING_RECONCILIATION') {
      // Do NOT release the reservation locally — we don't know if the
      // receiver actually committed before the drop. The backend resolves
      // this deterministically by tx_id during sync (see backend/app/routers/reconciliation.py).
      await TxRepo.markPendingSettlement(txId, 'ble_interrupted_send');
    } else {
      await WalletService.releaseReservation(this.myDeviceId, amountKobo);
    }
    return { txId, finalState, failureReason: reason };
  }

  private async offerOverBle(signed: SignedTransaction): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(signed));
    await this.ble.writeMessage(CHARACTERISTICS.TX_OFFER, signed.txId, bytes);
  }

  private waitForReceipt(txId: string, timeoutMs: number): Promise<SignedReceipt | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sub.remove();
        resolve(null);
      }, timeoutMs);

      const sub = this.ble.subscribeMessages(CHARACTERISTICS.TX_ACK, (bytes) => {
        try {
          const receipt = JSON.parse(new TextDecoder().decode(bytes)) as SignedReceipt;
          if (receipt.txId === txId) {
            clearTimeout(timer);
            sub.remove();
            resolve(receipt);
          }
        } catch {
          // ignore malformed frame, keep waiting until timeout
        }
      });
    });
  }

  /**
   * Receiver-side flow, called when TX_OFFER arrives:
   * RECEIVED -> VALIDATED -> ACCEPTED -> COMMITTED, then sends a signed receipt.
   */
  async handleIncomingOffer(rawBytes: Uint8Array, seenNonces: Set<string>): Promise<void> {
    const signed = JSON.parse(new TextDecoder().decode(rawBytes)) as SignedTransaction;
    let state: TxState = 'RECEIVED';
    await TxRepo.insertIncoming(signed, state);

    const validation = validateSignedTransaction(signed, { seenNonces });
    if (!validation.valid) {
      state = advance(state, 'REJECTED');
      await TxRepo.updateState(signed.txId, state, { failureReason: validation.reason });
      const receipt = await signReceipt({
        txId: signed.txId,
        receiverDeviceId: this.myDeviceId,
        receiverPublicKeyB64: this.myPublicKeyB64,
        status: 'REJECTED',
        reason: validation.reason,
      });
      await this.sendReceipt(receipt);
      return;
    }

    state = advance(state, 'VALIDATED');
    await TxRepo.updateState(signed.txId, state);

    state = advance(state, 'ACCEPTED');
    await TxRepo.updateState(signed.txId, state);

    // Credit is PENDING until backend settlement — see WalletService.creditPendingReceive.
    await WalletService.creditPendingReceive(this.myDeviceId, signed.amountKobo);

    state = advance(state, 'COMMITTED');
    await TxRepo.updateState(signed.txId, state, { committedAt: Date.now() });
    await TxRepo.markPendingSettlement(signed.txId, 'awaiting_backend_settlement');

    const receipt = await signReceipt({
      txId: signed.txId,
      receiverDeviceId: this.myDeviceId,
      receiverPublicKeyB64: this.myPublicKeyB64,
      status: 'ACCEPTED',
    });
    await this.sendReceipt(receipt);
  }

  /**
   * The receiver is the BLE peripheral, not the central — sending a
   * receipt back means notifying over TX_ACK (this.ble.sendTxAck), not
   * writing (this.ble.writeMessage, which assumes a central-role
   * connection and would throw "Not connected" here).
   */
  private async sendReceipt(receipt: SignedReceipt): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(receipt));
    await this.ble.sendTxAck(bytes);
  }
}

function advance(from: TxState, to: TxState): TxState {
  assertTransition(from, to);
  return to;
}
