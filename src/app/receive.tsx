import React, { useEffect, useRef, useState } from 'react';
import { Text, StyleSheet, Alert } from 'react-native';
import { Screen, Card, SectionLabel } from '../components/ui';
import { colors, spacing, typography } from '../theme/theme';
import { useDeviceIdentity } from '../services/useDeviceIdentity';
import { PaymentEngine } from '../services/PaymentEngine';
import { BleService, BleConnectionState } from '../services/ble/BleService';

// Same shared instance SendScreen uses — one BleService per app lifetime,
// since it owns the single BluetoothLeAdvertiser/GattServer/BleManager.
const ble = new BleService();

export default function ReceiveScreen() {
  const { deviceId, publicKeyB64, offlineNairaId } = useDeviceIdentity();
  const [status, setStatus] = useState<BleConnectionState>('IDLE');
  const [ready, setReady] = useState(false);

  // In-memory replay cache for this session — validateSignedTransaction
  // checks incoming nonces against this Set. It's separate from the
  // persistent seen_nonces table that insertIncoming() writes to; a
  // hardened build would seed this Set from that table on mount so replay
  // protection survives an app restart, not just this session.
  const seenNonces = useRef(new Set<string>()).current;

  useEffect(() => {
    // Silent return is correct here (unlike send.tsx's onSend guard) —
    // this is a mount-time effect, not a user action, so there's no tap
    // to give feedback about. _layout.tsx's ProvisioningGate should mean
    // deviceId is already set by the time this screen can mount anyway.
    if (!deviceId || !publicKeyB64) return;

    const unsubState = ble.onStateChange(setStatus);
    const engine = new PaymentEngine(ble, deviceId, publicKeyB64);
    let unsubOffers: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const granted = await ble.requestPermissions();
      if (!granted) {
        Alert.alert('Bluetooth permissions required', 'Enable Bluetooth permissions in Settings to receive payments.');
        return;
      }
      try {
        await ble.waitForPoweredOn();
        await ble.startGattServer();
        await ble.startAdvertising();
        if (cancelled) return;

        unsubOffers = ble.subscribeToOffers((bytes) => {
          engine.handleIncomingOffer(bytes, seenNonces).catch((err) => {
            Alert.alert('Failed to process incoming payment', err instanceof Error ? err.message : 'Unknown error');
          });
        });
        setReady(true);
      } catch (err) {
        Alert.alert('Could not start receiving', err instanceof Error ? err.message : 'Unknown error');
      }
    })();

    return () => {
      cancelled = true;
      unsubState();
      unsubOffers?.();
      ble.stopAdvertising().catch(() => {});
      ble.stopGattServer().catch(() => {});
    };
  }, [deviceId, publicKeyB64]);

  const statusText: Record<BleConnectionState, string> = {
    IDLE: 'Not started',
    REQUESTING_PERMISSIONS: 'Requesting Bluetooth permissions…',
    SCANNING: 'Scanning', // not used in this screen, but BleConnectionState is shared with the central role
    CONNECTING: 'Connecting',
    DISCOVERING: 'Discovering',
    CONNECTED: 'Connected — a sender is talking to this device',
    ADVERTISING: 'Advertising — nearby senders can find this device',
    DISCONNECTED: ready ? 'Advertising — waiting for a sender' : 'Stopped',
    ERROR: 'Bluetooth error — see console',
  };

  return (
    <Screen>
      <Card style={styles.idCard}>
        <SectionLabel>Your Offline Naira ID</SectionLabel>
        <Text style={styles.id}>{offlineNairaId ?? 'Provisioning…'}</Text>
        <Text style={styles.deviceId}>{deviceId}</Text>
      </Card>

      <Card>
        <SectionLabel>Bluetooth status</SectionLabel>
        <Text style={styles.status}>{statusText[status]}</Text>
      </Card>

      <Text style={styles.note}>
        This device is advertising and running a GATT server via the native BlePeripheral module
        (modules/ble-peripheral/) — real logic, not yet verified on hardware. Share your Offline
        Naira ID with the sender, or let their device discover you directly over Bluetooth.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  idCard: { marginBottom: spacing.md, alignItems: 'center', paddingVertical: spacing.xl },
  id: { ...typography.display, color: colors.accent, letterSpacing: 2 },
  deviceId: { ...typography.mono, color: colors.textMuted, marginTop: spacing.sm },
  status: { ...typography.body, color: colors.textSecondary },
  note: { ...typography.caption, color: colors.textMuted, marginTop: spacing.lg },
});
