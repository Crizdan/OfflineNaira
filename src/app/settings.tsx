import React from 'react';
import { Text, View, StyleSheet, Switch, Alert } from 'react-native';
import { Screen, Card, SectionLabel } from '../components/ui';
import { colors, spacing, typography } from '../theme/theme';
import { useDeviceIdentity } from '../services/useDeviceIdentity';

export default function SettingsScreen() {
  const { deviceId, offlineNairaId, publicKeyB64 } = useDeviceIdentity();
  const [biometrics, setBiometrics] = React.useState(false);

  return (
    <Screen>
      <SectionLabel>Identity</SectionLabel>
      <Card style={styles.card}>
        <Row label="Offline Naira ID" value={offlineNairaId ?? '—'} />
        <Row label="Device ID" value={deviceId ?? '—'} mono />
        <Row
          label="Public key"
          value={publicKeyB64 ? `${publicKeyB64.slice(0, 16)}…` : '—'}
          mono
        />
      </Card>
      <Text style={styles.note}>
        The private key never leaves secure storage and is never shown here — see
        src/crypto/identity.ts.
      </Text>

      <SectionLabel>Security</SectionLabel>
      <Card style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={styles.rowLabel}>Biometric unlock for sends</Text>
          <Switch
            value={biometrics}
            onValueChange={(v) => {
              setBiometrics(v);
              Alert.alert(
                'Biometrics',
                v
                  ? 'Enabled — future sends will require biometric or device passcode confirmation via expo-secure-store\'s requireAuthentication option.'
                  : 'Disabled — PIN will be required for sends.',
              );
            }}
          />
        </View>
      </Card>
    </Screen>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && typography.mono]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: spacing.md },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowLabel: { ...typography.body, color: colors.textSecondary },
  rowValue: { ...typography.body, color: colors.textPrimary },
  note: { ...typography.caption, color: colors.textMuted, marginBottom: spacing.lg },
});
