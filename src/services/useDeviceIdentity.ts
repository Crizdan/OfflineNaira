import { useEffect, useState } from 'react';
import { loadDeviceIdentity, provisionDeviceIdentity } from '../crypto/identity';
import { initWallet } from '../db/walletRepository';

export function useDeviceIdentity() {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [publicKeyB64, setPublicKeyB64] = useState<string | null>(null);
  const [offlineNairaId, setOfflineNairaId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      let identity = await loadDeviceIdentity();
      if (!identity) identity = await provisionDeviceIdentity();
      await initWallet(identity.deviceId);
      setDeviceId(identity.deviceId);
      setPublicKeyB64(identity.publicKeyB64);
      setOfflineNairaId(`ON-${identity.deviceId.slice(0, 4)}-${identity.deviceId.slice(4, 8)}`);
    })();
  }, []);

  return { deviceId, publicKeyB64, offlineNairaId };
}
