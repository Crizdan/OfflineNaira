import { useProvisioning } from './AppProvisioning';

/**
 * Thin compatibility wrapper: every screen already calls useDeviceIdentity()
 * expecting { deviceId, publicKeyB64, offlineNairaId }. Rather than each
 * screen independently re-running key generation and wallet init on every
 * mount (the original bug's contributing factor — redundant, and masked
 * failures behind identical-looking nulls), this now just reads the result
 * of the ONE provisioning run in AppProvisioningProvider (see
 * src/app/_layout.tsx). isLoading/error are exposed too, for screens that
 * want to guard against acting on a not-yet-ready identity (see send.tsx,
 * receive.tsx) — existing callers that only destructure the original three
 * fields keep working unchanged.
 */
export function useDeviceIdentity() {
  const { deviceId, publicKeyB64, offlineNairaId, status, error } = useProvisioning();
  return {
    deviceId,
    publicKeyB64,
    offlineNairaId,
    isLoading: status === 'loading',
    error: status === 'error' ? error : null,
  };
}
