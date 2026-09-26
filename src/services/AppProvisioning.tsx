import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { initializeDatabase } from '../db/connection';
import { loadDeviceIdentity, provisionDeviceIdentity, DeviceIdentity } from '../crypto/identity';
import { initWallet } from '../db/walletRepository';

type ProvisioningStatus = 'loading' | 'ready' | 'error';

interface ProvisioningState {
  status: ProvisioningStatus;
  deviceId: string | null;
  publicKeyB64: string | null;
  offlineNairaId: string | null;
  error: string | null;
  /** Re-runs provisioning from scratch. Wire this to a "Try again" button. */
  retry: () => void;
}

const ProvisioningContext = createContext<ProvisioningState | null>(null);

/**
 * Runs once at app startup: opens/creates the SQLite database, then loads
 * or generates the device's Ed25519 identity, then ensures a wallet row
 * exists for it. Every screen reads the result from context instead of
 * re-running this itself — previously each screen's own useDeviceIdentity
 * call redundantly repeated all of this on every mount.
 *
 * The critical property this adds that was missing before: a real
 * loading/error distinction. Previously, "still setting up" and
 * "permanently failed" both looked identical to the UI — null forever,
 * with the failure silently swallowed as an unhandled promise rejection.
 * Now a failure surfaces as status: 'error' with a message and a retry
 * button, instead of an infinite spinner.
 */
export function AppProvisioningProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ProvisioningStatus>('loading');
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const runProvisioning = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      await initializeDatabase();

      let deviceIdentity = await loadDeviceIdentity();
      if (!deviceIdentity) {
        deviceIdentity = await provisionDeviceIdentity();
      }

      await initWallet(deviceIdentity.deviceId);

      setIdentity(deviceIdentity);
      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Unknown error during setup');
    }
  }, []);

  useEffect(() => {
    runProvisioning();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const value: ProvisioningState = {
    status,
    deviceId: identity?.deviceId ?? null,
    publicKeyB64: identity?.publicKeyB64 ?? null,
    offlineNairaId: identity
      ? `ON-${identity.deviceId.slice(0, 4)}-${identity.deviceId.slice(4, 8)}`
      : null,
    error,
    retry,
  };

  return <ProvisioningContext.Provider value={value}>{children}</ProvisioningContext.Provider>;
}

export function useProvisioning(): ProvisioningState {
  const ctx = useContext(ProvisioningContext);
  if (!ctx) {
    throw new Error('useProvisioning must be used within AppProvisioningProvider (see _layout.tsx)');
  }
  return ctx;
}
