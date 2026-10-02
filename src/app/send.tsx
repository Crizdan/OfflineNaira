import React, { useState } from 'react';
import { Text, TextInput, View, StyleSheet, Alert } from 'react-native';
import { Screen, Card, SectionLabel, PrimaryButton, StatusPill } from '../components/ui';
import { colors, spacing, typography } from '../theme/theme';
import { nairaToKobo } from '../domain/money';
import { useDeviceIdentity } from '../services/useDeviceIdentity';
import { PaymentEngine } from '../services/PaymentEngine';
import { ble } from '../services/ble/bleInstance';
import { WalletError } from '../services/WalletService';

export default function SendScreen() {
  const { deviceId, publicKeyB64 } = useDeviceIdentity();
  const [peerId, setPeerId] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);

  const onSend = async () => {
    if (!deviceId || !publicKeyB64) {
      // Shouldn't be reachable — _layout.tsx's ProvisioningGate blocks
      // every screen from mounting until identity is ready — but this
      // stays as a hard safety net rather than silently doing nothing,
      // in case that invariant is ever broken by a future change.
      Alert.alert(
        'Wallet not ready',
        'Your device identity is still being set up. Please wait a moment and try again.',
      );
      return;
    }
    setBusy(true);
    setStatus(null);
    let connected = false;
    try {
      const amountKobo = nairaToKobo(amount);

      // Connect BEFORE touching the wallet. Previously this screen went
      // straight to sendPayment() without ever scanning or connecting, so the
      // BLE write threw "Not connected" - after funds were already reserved
      // and the transaction recorded as PENDING_RECONCILIATION. A failure to
      // reach the other phone should leave the wallet untouched.
      setPhase('Requesting Bluetooth permissions...');
      if (!(await ble.requestPermissions())) {
        Alert.alert('Bluetooth permission needed', 'Allow Nearby devices / Location permission, then try again.');
        return;
      }
      await ble.waitForPoweredOn();

      setPhase('Looking for the receiving phone...');
      await ble.connectToNearestPeer();
      connected = true;

      setPhase('Sending payment...');
      const engine = new PaymentEngine(ble, deviceId, publicKeyB64);
      const result = await engine.sendPayment(peerId.trim(), amountKobo);
      setStatus(result.finalState);
      if (result.finalState !== 'CONFIRMED' && result.finalState !== 'COMMITTED') {
        Alert.alert('Send did not complete', result.failureReason ?? result.finalState);
      }
    } catch (err) {
      if (err instanceof WalletError) {
        Alert.alert('Cannot send', err.message);
      } else {
        Alert.alert('Error', err instanceof Error ? err.message : 'Unknown error');
      }
    } finally {
      if (connected) await ble.disconnect().catch(() => {});
      setPhase(null);
      setBusy(false);
    }
  };

  return (
    <Screen>
      <SectionLabel>Recipient device ID</SectionLabel>
      <Card style={styles.inputCard}>
        <TextInput
          value={peerId}
          onChangeText={setPeerId}
          placeholder="Scan or enter Offline Naira device ID"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          autoCapitalize="characters"
        />
      </Card>

      <SectionLabel>Amount</SectionLabel>
      <Card style={styles.inputCard}>
        <TextInput
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          keyboardType="decimal-pad"
        />
      </Card>

      <PrimaryButton
        label="Send offline"
        onPress={onSend}
        disabled={!peerId || !amount || busy}
        loading={busy}
      />

      {phase && <Text style={styles.statusLabel}>{phase}</Text>}

      {status && (
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Result:</Text>
          <StatusPill state={status} />
        </View>
      )}

      <Text style={styles.note}>
        The other phone must be on its Receive screen with Bluetooth on. This phone scans for it,
        connects, sends the signed offer and waits for its signed receipt.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  inputCard: { marginBottom: spacing.md, padding: spacing.md },
  input: { ...typography.body, color: colors.textPrimary },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.md, gap: spacing.sm },
  statusLabel: { ...typography.body, color: colors.textSecondary, marginRight: spacing.sm },
  note: { ...typography.caption, color: colors.textMuted, marginTop: spacing.lg },
});
