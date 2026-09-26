/**
 * All cryptography here is delegated to `tweetnacl` (audited, widely used
 * Ed25519 implementation). Nothing here invents a cipher, a KDF, or a
 * signature scheme.
 *
 * Key storage: the raw secret key NEVER touches expo-sqlite or AsyncStorage.
 * It's generated once and stored via `expo-secure-store`, which is backed
 * by Android Keystore / iOS Keychain, and only ever read into memory
 * transiently to sign. `expo-secure-store` caps values at 2048 bytes — our
 * base64 secret key (~88 chars) is comfortably under that.
 *
 * IMPORTANT: tweetnacl needs a real CSPRNG (`crypto.getRandomValues`), which
 * Hermes/React Native does not provide by default. This is why
 * `react-native-get-random-values` must be imported once, before any other
 * module uses tweetnacl — see index.ts, where it's imported first.
 */
import 'react-native-get-random-values';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import * as SecureStore from 'expo-secure-store';

const SECURE_STORE_KEY = 'offline_naira_device_secret_key';

export interface DeviceIdentity {
  deviceId: string; // derived from the pubkey, not a random UUID, so it's self-certifying
  publicKeyB64: string;
}

/** Generates a new Ed25519 keypair and stores the secret key via expo-secure-store. */
export async function provisionDeviceIdentity(): Promise<DeviceIdentity> {
  const existing = await loadDeviceIdentity();
  if (existing) return existing;

  const pair = nacl.sign.keyPair();
  const secretKeyB64 = encodeBase64(pair.secretKey);

  await SecureStore.setItemAsync(SECURE_STORE_KEY, secretKeyB64, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    // Flip this on once the Settings screen's biometric toggle should
    // actually gate signing — every signBytes() call would then prompt.
    // requireAuthentication: true,
    // authenticationPrompt: 'Confirm to set up your Offline Naira identity',
  });

  return { deviceId: deriveDeviceId(pair.publicKey), publicKeyB64: encodeBase64(pair.publicKey) };
}

export async function loadDeviceIdentity(): Promise<DeviceIdentity | null> {
  const secretKeyB64 = await SecureStore.getItemAsync(SECURE_STORE_KEY);
  if (!secretKeyB64) return null;
  const secretKey = decodeBase64(secretKeyB64);
  const publicKey = secretKey.slice(32); // nacl secret key = seed(32) + pubkey(32)
  return { deviceId: deriveDeviceId(publicKey), publicKeyB64: encodeBase64(publicKey) };
}

/** Signs arbitrary bytes with the device's secret key. Secret key is read, used, discarded. */
export async function signBytes(message: Uint8Array): Promise<string> {
  const secretKeyB64 = await SecureStore.getItemAsync(SECURE_STORE_KEY);
  if (!secretKeyB64) throw new Error('Device identity not provisioned');
  const secretKey = decodeBase64(secretKeyB64);
  const signature = nacl.sign.detached(message, secretKey);
  return encodeBase64(signature);
}

export function verifySignature(
  message: Uint8Array,
  signatureB64: string,
  publicKeyB64: string,
): boolean {
  try {
    return nacl.sign.detached.verify(
      message,
      decodeBase64(signatureB64),
      decodeBase64(publicKeyB64),
    );
  } catch {
    return false;
  }
}

/**
 * Derives a device ID from a public key. Exported (not just used
 * internally) so protocol code can verify a claimed deviceId actually
 * matches the public key embedded in a message — see
 * assertDeviceIdMatchesKey below and its use in transaction.ts. This is
 * what makes device IDs "self-certifying" in practice, not just in a
 * comment.
 */
export function deriveDeviceId(publicKey: Uint8Array): string {
  return Array.from(publicKey.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/**
 * Verifies that a claimed deviceId actually corresponds to a given public
 * key. Without this check, a peer could sign validly with one keypair
 * while claiming an unrelated deviceId — the signature alone doesn't
 * catch that, since it only proves self-consistency between the message
 * and its embedded pubkey, not that the pubkey belongs to the claimed ID.
 */
export function assertDeviceIdMatchesKey(claimedDeviceId: string, publicKeyB64: string): boolean {
  try {
    return deriveDeviceId(decodeBase64(publicKeyB64)) === claimedDeviceId;
  } catch {
    return false;
  }
}

export function randomNonce(): string {
  return encodeBase64(nacl.randomBytes(16));
}
