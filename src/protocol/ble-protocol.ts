/**
 * Custom GATT profile for Offline Naira.
 *
 * IMPORTANT: react-native-ble-plx (the library used for the central/client
 * role below) can scan, connect, discover services, and read/write/notify
 * characteristics on a REMOTE peripheral. It cannot make this phone act as
 * a peripheral (advertiser + GATT server) — Android's peripheral/GATT-server
 * APIs (BluetoothGattServer, AdvertiseCallback) are not exposed by that
 * library. To have two phones actually find each other with one running as
 * advertiser, you need the native Kotlin module skeleton in
 * mobile/android-native/kotlin/OfflineNairaBlePeripheralModule.kt, wired
 * into a real Android project. See docs/BLE_NOTES.md.
 */

export const OFFLINE_NAIRA_SERVICE_UUID = '7e9a0001-0000-1000-8000-00805f9b34fb';

export const CHARACTERISTICS = {
  IDENTITY: '7e9a0002-0000-1000-8000-00805f9b34fb', // write+notify, exchange deviceId+pubkey+nonce
  TX_OFFER: '7e9a0003-0000-1000-8000-00805f9b34fb', // write, chunked SignedTransaction JSON
  TX_ACK: '7e9a0004-0000-1000-8000-00805f9b34fb', // notify, chunked SignedReceipt JSON
  PING: '7e9a0005-0000-1000-8000-00805f9b34fb', // write+notify, liveness / keepalive
} as const;

// BLE characteristic writes are capped (typically ~20-512 bytes depending on
// negotiated MTU). Larger payloads (a signed transaction JSON blob) are
// split into chunks with a simple length-prefixed framing.
export const MAX_CHUNK_BYTES = 180;

export interface FramedChunk {
  msgId: string; // groups chunks belonging to one logical message
  index: number;
  count: number;
  payloadB64: string;
}

export function frameMessage(msgId: string, bytes: Uint8Array): FramedChunk[] {
  const chunks: FramedChunk[] = [];
  const count = Math.max(1, Math.ceil(bytes.length / MAX_CHUNK_BYTES));
  for (let i = 0; i < count; i++) {
    const slice = bytes.slice(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES);
    chunks.push({
      msgId,
      index: i,
      count,
      payloadB64: btoa(String.fromCharCode(...slice)),
    });
  }
  return chunks;
}

/** Accumulates chunks for one msgId and returns the reassembled bytes once complete. */
export class MessageReassembler {
  private buffers = new Map<string, (string | undefined)[]>();

  addChunk(chunk: FramedChunk): Uint8Array | null {
    let buf = this.buffers.get(chunk.msgId);
    if (!buf) {
      buf = new Array(chunk.count).fill(undefined);
      this.buffers.set(chunk.msgId, buf);
    }
    buf[chunk.index] = chunk.payloadB64;
    if (buf.every((b) => b !== undefined)) {
      this.buffers.delete(chunk.msgId);
      const full = buf.join('');
      const binary = atob(full);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return null;
  }

  /** Call periodically to drop partial messages that never completed (BLE drop). */
  purgeStale(_maxAgeMs: number): void {
    // Prototype note: tracking per-msgId timestamps is a small addition left
    // for the integration step, since it depends on the RN clock module
    // chosen for the final build.
  }
}
