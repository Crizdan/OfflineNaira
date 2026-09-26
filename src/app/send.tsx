import React, { useState } from 'react';
import { Text, TextInput, View, StyleSheet, Alert } from 'react-native';
import { Screen, Card, SectionLabel, PrimaryButton, StatusPill } from '../components/ui';
import { colors, spacing, typography } from '../theme/theme';
import { nairaToKobo } from '../domain/money';
import { useDeviceIdentity } from '../services/useDeviceIdentity';
import { PaymentEngine } from '../services/PaymentEngine';
import { BleService } from '../services/ble/BleService';
import { WalletError } from '../services/WalletService';

// One shared BLE service instance for the app lifetime; injected here for clarity.
const ble = new BleService();

export default function SendScreen() {
  const { deviceId, publicKeyB64 } = useDeviceIdentity();
  const [peerId, setPeerId] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSend = async () => {
    if (!deviceId || !publicKeyB64) return;
    setBusy(true);
    setStatus(null);
    try {
      const amountKobo = nairaToKobo(amount);
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

      {status && (
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Result:</Text>
          <StatusPill state={status} />
        </View>
      )}

      <Text style={styles.note}>
        This device must be connected over BLE to the recipient first (peer discovery is driven
        from the Receive screen's advertiser role). Peripheral advertising requires the native
        Expo module in modules/ble-peripheral — see MIGRATION.md.
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
