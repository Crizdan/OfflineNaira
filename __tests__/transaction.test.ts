import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import {
  buildUnsignedTransaction,
  validateSignedTransaction,
  PROTOCOL_VERSION,
} from '../src/protocol/transaction';
import { deriveDeviceId } from '../src/crypto/identity';
import { kobo } from '../src/domain/money';

// Bypass Keychain for pure-function tests by signing directly with a test
// keypair and constructing a SignedTransaction manually via the same
// canonical-bytes shape the module uses internally.
function testSign(unsigned: any, secretKey: Uint8Array) {
  const canonical = JSON.stringify({
    amountKobo: unsigned.amountKobo,
    createdAt: unsigned.createdAt,
    expiresAt: unsigned.expiresAt,
    nonce: unsigned.nonce,
    protocolVersion: unsigned.protocolVersion,
    receiverDeviceId: unsigned.receiverDeviceId,
    senderDeviceId: unsigned.senderDeviceId,
    senderPublicKeyB64: unsigned.senderPublicKeyB64,
    txId: unsigned.txId,
  });
  const bytes = new TextEncoder().encode(canonical);
  const signature = nacl.sign.detached(bytes, secretKey);
  return { ...unsigned, signatureB64: encodeBase64(signature) };
}

describe('transaction validation', () => {
  const pair = nacl.sign.keyPair();
  const publicKeyB64 = encodeBase64(pair.publicKey);
  // Real device IDs are derived from the pubkey (see provisionDeviceIdentity
  // in crypto/identity.ts) — using anything else here would make the
  // device-id/pubkey binding check below meaningless.
  const senderDeviceId = deriveDeviceId(pair.publicKey);

  function makeSigned(overrides: Partial<any> = {}) {
    const unsigned = {
      ...buildUnsignedTransaction({
        txId: 'tx-1',
        senderDeviceId,
        senderPublicKeyB64: publicKeyB64,
        receiverDeviceId: 'DEVICE-B',
        amountKobo: kobo(5000),
      }),
      ...overrides,
    };
    return testSign(unsigned, pair.secretKey);
  }

  it('accepts a validly signed, fresh transaction', () => {
    const tx = makeSigned();
    const result = validateSignedTransaction(tx, { seenNonces: new Set() });
    expect(result.valid).toBe(true);
  });

  it('rejects a tampered amount (signature no longer matches)', () => {
    const tx = makeSigned();
    const tampered = { ...tx, amountKobo: kobo(999999) };
    const result = validateSignedTransaction(tampered, { seenNonces: new Set() });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('rejects an expired transaction', () => {
    const tx = makeSigned({ expiresAt: Date.now() - 1000 });
    const result = validateSignedTransaction(tx, { seenNonces: new Set() });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('rejects a replayed nonce', () => {
    const tx = makeSigned();
    const seen = new Set([tx.nonce]);
    const result = validateSignedTransaction(tx, { seenNonces: seen });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('replay_detected');
  });

  it('rejects a non-positive amount', () => {
    const tx = makeSigned({ amountKobo: 0 });
    const result = validateSignedTransaction(tx, { seenNonces: new Set() });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('non_positive_amount');
  });

  it('rejects an unsupported protocol version', () => {
    const tx = makeSigned({ protocolVersion: PROTOCOL_VERSION + 1 });
    const result = validateSignedTransaction(tx, { seenNonces: new Set() });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unsupported_protocol_version');
  });

  it('rejects a claimed senderDeviceId that does not match the embedded public key', () => {
    // The message is genuinely signed by `pair`'s real secret key, and
    // senderPublicKeyB64 is still pair's real pubkey — so the signature
    // itself checks out (self-consistent). But senderDeviceId is
    // overridden to a device ID derived from a *different* keypair. This
    // is exactly the attack signature-checking alone can't catch: a
    // legitimate signer claiming to be a device it isn't.
    const otherPair = nacl.sign.keyPair();
    const impersonatedDeviceId = deriveDeviceId(otherPair.publicKey);
    const tx = makeSigned({ senderDeviceId: impersonatedDeviceId });
    const result = validateSignedTransaction(tx, { seenNonces: new Set() });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('device_id_key_mismatch');
  });
});
