import React, { useEffect, useRef, useState } from 'react';
import { Text, StyleSheet, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Screen, Card, SectionLabel } from '../components/ui';
import { colors, spacing, typography } from '../theme/theme';
import { useDeviceIdentity } from '../services/useDeviceIdentity';
import { PaymentEngine } from '../services/PaymentEngine';
import type { BleConnectionState } from '../services/ble/BleService';
import { ble } from '../services/ble/bleInstance';
import { requestBluetoothPermissions } from '../services/blePermissions';

export default function ReceiveScreen() {
  const router = useRouter();
  const { deviceId, publicKeyB64, offlineNairaId } = useDeviceIdentity();
  const [status, setStatus] = useState<BleConnectionState>('IDLE');
  const [ready, setReady] = useState(false);

  // In-memory replay cache for this session
  const seenNonces = useRef(new Set<string>()).current;

  useEffect(() => {
    if (!deviceId || !publicKeyB64) return;

    let unsubState: (() => void) | null = null;
    let unsubOffers: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        unsubState = ble.onStateChange(setStatus);
        const engine = new PaymentEngine(ble, deviceId, publicKeyB64);

        // 1. Strict permission check — abort safely if denied
        const granted = await requestBluetoothPermissions().catch(() => false);
        if (!granted) {
          if (!cancelled) {
            Alert.alert(
              'Permissions Required',
              'Bluetooth and Location permissions are required to receive offline payments.'
            );
          }
          return;
        }

        if (cancelled) return;

        // 2. Initialize hardware and BLE servers
        await ble.waitForPoweredOn();
        await ble.startGattServer();
        await ble.startAdvertising();
       
        if (cancelled) return;

        // 3. Subscribe to incoming payment offers from sender phones
        unsubOffers = ble.subscribeToOffers((bytes) => {
          engine
            .handleIncomingOffer(bytes, seenNonces)
            .then(() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setTimeout(() => {
                router.replace('/wallet');
              }, 1500);
            })
            .catch((err) => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              Alert.alert(
                'Failed to process incoming payment',
                err instanceof Error ? err.message : 'Unknown error'
              );
            });
        });
        setReady(true);
      } catch (err) {
        console.warn('BLE Peripheral initialization failed:', err);
        if (!cancelled) {
          Alert.alert(
            'BLE Not Ready',
            'Could not start BLE receiver. Ensure Bluetooth is enabled.'
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubState?.();
      unsubOffers?.();
      ble.stopAdvertising().catch(() => {});
      ble.stopGattServer().catch(() => {});
    };
  }, [deviceId, publicKeyB64]);

  const statusText: Record<BleConnectionState, string> = {
    IDLE: 'Not started',
    REQUESTING_PERMISSIONS: 'Requesting Bluetooth permissions…',
    SCANNING: 'Scanning',
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
        This device is advertising and running a GATT server via the native BlePeripheral module.
        Share your Offline Naira ID with the sender, or let their device discover you directly over Bluetooth.
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