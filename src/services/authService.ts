/**
 * authService.ts
 *
 * Account credentials + transaction authorization. Standalone: nothing in the
 * wallet, BLE or SQLite layers imports this file, and it imports none of
 * them. UI code calls it to decide WHETHER an action may proceed; it never
 * touches balances or transaction state.
 *
 * Storage: expo-secure-store only (Android Keystore / iOS Keychain backed).
 * The password and PIN are NEVER stored - only a salted scrypt hash of each.
 *
 * Crypto: no custom primitives. scrypt comes from @noble/hashes (audited,
 * pure JS), salts from tweetnacl's CSPRNG (the app entry point loads the
 * react-native-get-random-values polyfill it needs - see index.ts).
 *
 * Honest limits, read before relying on this:
 *  - A 4-6 digit PIN has at most 10^6 possibilities. Hashing cannot make that
 *    brute-force-proof; the real protection is (a) the hash living inside
 *    SecureStore and (b) the attempt lockout below. Do not raise the lockout
 *    thresholds without understanding that.
 *  - Lockout timestamps use the device clock, so a user who changes the
 *    system time can shorten a lockout.
 *  - This gates the UI. PaymentEngine.sendPayment() itself does not check it,
 *    so any code path that calls it directly bypasses the gate. Hardware
 *    enforcement would mean storing the signing key with SecureStore's
 *    requireAuthentication option (see the comment in crypto/identity.ts).
 */
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { scryptAsync } from '@noble/hashes/scrypt.js';

const ACCOUNT_KEY = 'offline_naira_auth_account_v1';
const LOCKOUT_KEY = 'offline_naira_auth_lockout_v1';

const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// scrypt cost. N=2^14, r=8 uses ~16 MB and takes noticeable-but-fine time in
// Hermes (it runs async and yields to the UI). Parameters are stored with each
// hash so they can be raised later without invalidating existing accounts.
const KDF_DEFAULTS = { N: 2 ** 14, r: 8, p: 1, dkLen: 32 } as const;

/** Free attempts before a lockout starts. */
const MAX_FREE_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;

export type SecretKind = 'password' | 'pin';

export type AuthErrorCode =
  | 'INVALID_USERNAME'
  | 'WEAK_PASSWORD'
  | 'INVALID_PIN'
  | 'ACCOUNT_EXISTS';

export class AuthError extends Error {
  constructor(public code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

interface HashRecord {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
  dkLen: number;
  salt: string; // base64
  hash: string; // base64
}

interface StoredAccount {
  v: 1;
  username: string;
  password: HashRecord;
  pin: HashRecord;
  createdAt: number;
}

interface LockoutState {
  failures: number;
  lockedUntil: number; // epoch ms, 0 = not locked
}

type LockoutMap = Record<SecretKind, LockoutState>;

// ---------------------------------------------------------------- hashing

async function hashSecret(secret: string): Promise<HashRecord> {
  const salt = nacl.randomBytes(16);
  const derived = await scryptAsync(secret, salt, { ...KDF_DEFAULTS });
  return { alg: 'scrypt', ...KDF_DEFAULTS, salt: encodeBase64(salt), hash: encodeBase64(derived) };
}

async function verifySecret(secret: string, record: HashRecord): Promise<boolean> {
  try {
    const derived = await scryptAsync(secret, decodeBase64(record.salt), {
      N: record.N,
      r: record.r,
      p: record.p,
      dkLen: record.dkLen,
    });
    return constantTimeEqual(derived, decodeBase64(record.hash));
  } catch {
    return false;
  }
}

/** Compares without bailing out at the first differing byte. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

// ---------------------------------------------------------------- storage

async function loadAccount(): Promise<StoredAccount | null> {
  const raw = await SecureStore.getItemAsync(ACCOUNT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredAccount;
  } catch {
    return null;
  }
}

async function readLockouts(): Promise<LockoutMap> {
  const empty: LockoutMap = {
    password: { failures: 0, lockedUntil: 0 },
    pin: { failures: 0, lockedUntil: 0 },
  };
  const raw = await SecureStore.getItemAsync(LOCKOUT_KEY);
  if (!raw) return empty;
  try {
    return { ...empty, ...(JSON.parse(raw) as Partial<LockoutMap>) };
  } catch {
    return empty;
  }
}

async function writeLockouts(map: LockoutMap): Promise<void> {
  await SecureStore.setItemAsync(LOCKOUT_KEY, JSON.stringify(map), SECURE_OPTS);
}

function lockDurationMs(failures: number): number {
  if (failures < MAX_FREE_ATTEMPTS) return 0;
  // 5th failure -> 30s, 6th -> 60s, 7th -> 120s ... capped at 15 min.
  return Math.min(BASE_LOCKOUT_MS * 2 ** (failures - MAX_FREE_ATTEMPTS), MAX_LOCKOUT_MS);
}

// ---------------------------------------------------------------- account

export async function hasAccount(): Promise<boolean> {
  return (await SecureStore.getItemAsync(ACCOUNT_KEY)) !== null;
}

export async function getUsername(): Promise<string | null> {
  return (await loadAccount())?.username ?? null;
}

/**
 * Creates the one local account. Throws AuthError for invalid input or if an
 * account already exists (it will not silently overwrite credentials).
 */
export async function setupUserAccount(
  username: string,
  password: string,
  pin: string,
): Promise<void> {
  const name = username.trim();
  if (name.length < 3) {
    throw new AuthError('INVALID_USERNAME', 'Username must be at least 3 characters.');
  }
  if (password.length < 8) {
    throw new AuthError('WEAK_PASSWORD', 'Password must be at least 8 characters.');
  }
  if (!/^\d{4,6}$/.test(pin)) {
    throw new AuthError('INVALID_PIN', 'Transaction PIN must be 4 to 6 digits.');
  }
  if (await hasAccount()) {
    throw new AuthError('ACCOUNT_EXISTS', 'An account already exists on this device.');
  }

  const account: StoredAccount = {
    v: 1,
    username: name,
    password: await hashSecret(password),
    pin: await hashSecret(pin),
    createdAt: Date.now(),
  };
  await SecureStore.setItemAsync(ACCOUNT_KEY, JSON.stringify(account), SECURE_OPTS);
  await SecureStore.deleteItemAsync(LOCKOUT_KEY);
}

// ---------------------------------------------------------------- verifying

/** Milliseconds until `kind` can be tried again; 0 if it is not locked. */
export async function getLockoutRemainingMs(kind: SecretKind): Promise<number> {
  const state = (await readLockouts())[kind];
  return Math.max(0, state.lockedUntil - Date.now());
}

async function checkSecret(kind: SecretKind, secret: string): Promise<boolean> {
  // While locked, refuse WITHOUT evaluating - even the right secret fails.
  if ((await getLockoutRemainingMs(kind)) > 0) return false;

  const account = await loadAccount();
  if (!account) return false;

  const ok = await verifySecret(secret, account[kind]);

  const lockouts = await readLockouts();
  if (ok) {
    lockouts[kind] = { failures: 0, lockedUntil: 0 };
  } else {
    const failures = lockouts[kind].failures + 1;
    const wait = lockDurationMs(failures);
    lockouts[kind] = { failures, lockedUntil: wait > 0 ? Date.now() + wait : 0 };
  }
  await writeLockouts(lockouts);
  return ok;
}

export function authenticateWithPassword(password: string): Promise<boolean> {
  return checkSecret('password', password);
}

/** Transaction PIN check - the fallback when biometrics are unavailable or fail. */
export function authenticateWithPin(pin: string): Promise<boolean> {
  return checkSecret('pin', pin);
}

// ---------------------------------------------------------------- biometrics

export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const [hasHardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hasHardware && enrolled;
  } catch {
    return false;
  }
}

/**
 * Prompts for fingerprint / face via the OS. Returns true only on a
 * successful match. Returns false (never throws) if there is no hardware, no
 * enrolled biometrics, the user cancels, or the OS reports any error - the
 * caller then falls back to the transaction PIN.
 */
export async function authenticateWithBiometrics(reasonMessage: string): Promise<boolean> {
  try {
    if (!(await isBiometricAvailable())) return false;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reasonMessage,
      cancelLabel: 'Use PIN instead',
      // We implement the fallback ourselves (transaction PIN), so don't let the
      // OS drop to the device passcode screen after repeated failures.
      disableDeviceFallback: true,
    });
    return result.success;
  } catch {
    return false;
  }
}
