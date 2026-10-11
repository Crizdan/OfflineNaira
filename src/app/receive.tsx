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

  // In-memory replay cache for this session — validateSignedTransaction
  // checks incoming nonces against this Set.
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

        // Contextual Bluetooth and Location permissions check
        const granted = await requestBluetoothPermissions();
        if (!granted) {
          Alert.alert(
            'Bluetooth permissions required',
            'Enable Bluetooth and Location permissions in Settings to receive payments.'
          );
          return;
        }

        await ble.waitForPoweredOn();
        await ble.startGattServer();
        await ble.startAdvertising();
        if (cancelled) return;

        unsubOffers = ble.subscribeToOffers((bytes) => {
          engine
            .handleIncomingOffer(bytes, seenNonces)
            .then(() => {
              // Haptic feedback on successful receive commit
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

              // Auto-navigate to wallet dashboard after 1.5 seconds
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
        Alert.alert(
          'BLE Not Ready',
          'Could not start BLE receiver. Ensure Bluetooth is enabled and that the newly built APK is installed on this device.'
        );
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