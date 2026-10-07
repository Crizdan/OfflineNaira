import { Buffer } from 'buffer';

/**
* Custom GATT profile for Offline Naira.
*
* MUST match the 128-bit vendor-specific UUIDs in BlePeripheralModule.kt
*/
export const OFFLINE_NAIRA_SERVICE_UUID = '7e9a0001-a1b2-4c3d-8e5f-90123456789a';

export const CHARACTERISTICS = {
  IDENTITY: '7e9a0002-a1b2-4c3d-8e5f-90123456789a',
  TX_OFFER: '7e9a0003-a1b2-4c3d-8e5f-90123456789a',
  TX_ACK: '7e9a0004-a1b2-4c3d-8e5f-90123456789a',
  PING: '7e9a0005-a1b2-4c3d-8e5f-90123456789a',
} as const;

export const MAX_CHUNK_BYTES = 180;

export interface FramedChunk {
  msgId: string;
  index: number;
  count: number;
  payloadB64: string;
}

export function frameMessage(msgId: string, bytes: Uint8Array): FramedChunk[] {
  const chunks: FramedChunk[] = [];
  const count = Math.max(1, Math.ceil(bytes.length / MAX_CHUNK_BYTES));
  for (let i = 0; i < count; i++) {
    const slice = bytes.slice(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES);
    const buf = Buffer.from(slice);
    const payloadB64 = buf.toString('base64');
    chunks.push({
      msgId,
      index: i,
      count,
      payloadB64,
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
      const fullB64 = buf.join('');
      const decodedBuf = Buffer.from(fullB64, 'base64');
      return new Uint8Array(decodedBuf.buffer, decodedBuf.byteOffset, decodedBuf.byteLength);
    }
    return null;
  }

  purgeStale(_maxAgeMs: number): void {
    // Left for stale message cleanup during session resets
  }
}