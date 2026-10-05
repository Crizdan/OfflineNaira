/**
 * Mocks expo-secure-store with an in-memory Map and expo-local-authentication
 * with jest.fn()s, so these run in plain Jest with no device. The scrypt hashing
 * is real (not mocked) so the "stored value is a hash" assertions mean something.
 */
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? (store.get(k) as string) : null)),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
    __store: store,
  };
});

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  authenticateAsync: jest.fn(),
}));

import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as auth from '../src/services/authService';

const store: Map<string, string> = (SecureStore as any).__store;
const bio = LocalAuthentication as jest.Mocked<typeof LocalAuthentication>;

jest.setTimeout(60_000); // real scrypt, several hashes per test

beforeEach(() => {
  store.clear();
  jest.restoreAllMocks();
  bio.hasHardwareAsync.mockReset();
  bio.isEnrolledAsync.mockReset();
  bio.authenticateAsync.mockReset();
});

describe('setupUserAccount', () => {
  it('stores only hashes - never the password or PIN in plain text', async () => {
    await auth.setupUserAccount('crizdan', 'correct horse battery', '482913');
    const raw = [...store.values()].join('\n');
    expect(raw).not.toContain('correct horse battery');
    expect(raw).not.toContain('482913');
    expect(raw).toContain('scrypt');
    expect(await auth.hasAccount()).toBe(true);
    expect(await auth.getUsername()).toBe('crizdan');
  });

  it('rejects invalid input with a typed error', async () => {
    await expect(auth.setupUserAccount('ab', 'longenough1', '1234')).rejects.toMatchObject({
      code: 'INVALID_USERNAME',
    });
    await expect(auth.setupUserAccount('crizdan', 'short', '1234')).rejects.toMatchObject({
      code: 'WEAK_PASSWORD',
    });
    for (const badPin of ['123', '1234567', 'abcd', '12 34', '']) {
      await expect(auth.setupUserAccount('crizdan', 'longenough1', badPin)).rejects.toMatchObject({
        code: 'INVALID_PIN',
      });
    }
    expect(await auth.hasAccount()).toBe(false);
  });

  it('refuses to overwrite an existing account', async () => {
    await auth.setupUserAccount('crizdan', 'longenough1', '1234');
    await expect(auth.setupUserAccount('other', 'anotherpass1', '9999')).rejects.toMatchObject({
      code: 'ACCOUNT_EXISTS',
    });
    expect(await auth.getUsername()).toBe('crizdan');
  });
});

describe('password and PIN verification', () => {
  beforeEach(async () => {
    await auth.setupUserAccount('crizdan', 'longenough1', '4829');
  });

  it('accepts the right password and rejects a wrong one', async () => {
    expect(await auth.authenticateWithPassword('longenough1')).toBe(true);
    expect(await auth.authenticateWithPassword('wrongpassword')).toBe(false);
  });

  it('accepts the right PIN and rejects a wrong one', async () => {
    expect(await auth.authenticateWithPin('4829')).toBe(true);
    expect(await auth.authenticateWithPin('0000')).toBe(false);
  });

  it('does not accept the PIN as the password or vice versa', async () => {
    expect(await auth.authenticateWithPassword('4829')).toBe(false);
    expect(await auth.authenticateWithPin('longenough1')).toBe(false);
  });
});

describe('lockout', () => {
  beforeEach(async () => {
    await auth.setupUserAccount('crizdan', 'longenough1', '4829');
  });

  it('locks after 5 wrong PINs and refuses even the correct PIN until it expires', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    for (let i = 0; i < 4; i++) {
      expect(await auth.authenticateWithPin('0000')).toBe(false);
      expect(await auth.getLockoutRemainingMs('pin')).toBe(0); // not locked yet
    }
    expect(await auth.authenticateWithPin('0000')).toBe(false); // 5th failure
    expect(await auth.getLockoutRemainingMs('pin')).toBeGreaterThan(0);

    // Correct PIN is refused while locked
    expect(await auth.authenticateWithPin('4829')).toBe(false);

    // After the lockout window it works again and the counter resets
    now += 31_000;
    expect(await auth.getLockoutRemainingMs('pin')).toBe(0);
    expect(await auth.authenticateWithPin('4829')).toBe(true);
    expect(await auth.authenticateWithPin('0000')).toBe(false);
    expect(await auth.getLockoutRemainingMs('pin')).toBe(0); // back to 1 failure, not locked
  });

  it('tracks password and PIN lockouts independently', async () => {
    for (let i = 0; i < 5; i++) await auth.authenticateWithPin('0000');
    expect(await auth.getLockoutRemainingMs('pin')).toBeGreaterThan(0);
    expect(await auth.getLockoutRemainingMs('password')).toBe(0);
    expect(await auth.authenticateWithPassword('longenough1')).toBe(true);
  });
});

describe('biometrics', () => {
  it('returns false without prompting when there is no hardware', async () => {
    bio.hasHardwareAsync.mockResolvedValue(false);
    bio.isEnrolledAsync.mockResolvedValue(true);
    expect(await auth.authenticateWithBiometrics('Authorize Offline Send')).toBe(false);
    expect(bio.authenticateAsync).not.toHaveBeenCalled();
  });

  it('returns false without prompting when nothing is enrolled', async () => {
    bio.hasHardwareAsync.mockResolvedValue(true);
    bio.isEnrolledAsync.mockResolvedValue(false);
    expect(await auth.authenticateWithBiometrics('Authorize Offline Send')).toBe(false);
    expect(bio.authenticateAsync).not.toHaveBeenCalled();
  });

  it('returns true on a successful match and passes the reason + no-OS-fallback options', async () => {
    bio.hasHardwareAsync.mockResolvedValue(true);
    bio.isEnrolledAsync.mockResolvedValue(true);
    bio.authenticateAsync.mockResolvedValue({ success: true } as any);
    expect(await auth.authenticateWithBiometrics('Authorize Offline Send')).toBe(true);
    expect(bio.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        promptMessage: 'Authorize Offline Send',
        disableDeviceFallback: true,
      }),
    );
  });

  it('returns false when the user cancels or the match fails', async () => {
    bio.hasHardwareAsync.mockResolvedValue(true);
    bio.isEnrolledAsync.mockResolvedValue(true);
    bio.authenticateAsync.mockResolvedValue({ success: false, error: 'user_cancel' } as any);
    expect(await auth.authenticateWithBiometrics('x')).toBe(false);
  });

  it('returns false instead of throwing if the OS call throws', async () => {
    bio.hasHardwareAsync.mockResolvedValue(true);
    bio.isEnrolledAsync.mockResolvedValue(true);
    bio.authenticateAsync.mockRejectedValue(new Error('native failure'));
    await expect(auth.authenticateWithBiometrics('x')).resolves.toBe(false);
  });
});
