import React, { useCallback, useState } from 'react';
import { Text, View, StyleSheet, Modal, TextInput, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Screen, Card, SectionLabel, PrimaryButton } from '../components/ui';
import { colors, spacing, typography } from '../theme/theme';
import { koboToNairaString, nairaToKobo } from '../domain/money';
import { getWalletSnapshot, depositOfflineFunds, OFFLINE_LIMITS } from '../services/WalletService';
import { useDeviceIdentity } from '../services/useDeviceIdentity';
import { requestBluetoothPermissions } from '../services/blePermissions';

export default function WalletScreen() {
  const { deviceId } = useDeviceIdentity();
  const [wallet, setWallet] = useState<Awaited<ReturnType<typeof getWalletSnapshot>> | null>(null);
  const [error, setError] = useState<string | null>(null);
 
  // Modal states
  const [modalVisible, setModalVisible] = useState(false);
  const [amountInput, setAmountInput] = useState('2000');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!deviceId) return;
    setError(null);
    getWalletSnapshot(deviceId)
      .then(setWallet)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load wallet'));
  }, [deviceId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const handleDeposit = async () => {
    const num = Number(amountInput);
    if (!num || num <= 0 || !deviceId) {
      Alert.alert('Invalid amount', 'Please enter a valid number to fund.');
      return;
    }

    setLoading(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

    try {
      const kobo = nairaToKobo(amountInput);
      await depositOfflineFunds(deviceId, kobo);
     
      setLoading(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setModalVisible(false);
      load(); // Refresh wallet snapshot
      Alert.alert('Success', `Added ₦${num.toLocaleString()} demo funds to your wallet!`);
    } catch (err) {
      setLoading(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Error', 'Could not fund wallet.');
    }
  };

  if (error) {
    return (
      <Screen>
        <Text style={styles.errorText}>{error}</Text>
        <PrimaryButton label="Try again" onPress={load} />
      </Screen>
    );
  }

  if (!wallet) {
    return (
      <Screen>
        <Text style={styles.empty}>Loading wallet…</Text>
      </Screen>
    );
  }

  const rows: [string, string][] = [
    ['Bank balance (last synced)', koboToNairaString(wallet.bankBalanceKobo)],
    ['Offline spendable', koboToNairaString(wallet.offlineWalletKobo)],
    ['Reserved (in-flight sends)', koboToNairaString(wallet.reservedKobo)],
    ['Sent today', koboToNairaString(wallet.dailySentKobo)],
    ['Received today', koboToNairaString(wallet.dailyReceivedKobo)],
  ];

  return (
    <Screen>
      <View style={styles.topUpContainer}>
        <PrimaryButton
          label="+ Top Up (Demo Bank Gateway)"
          onPress={() => setModalVisible(true)}
        />
      </View>

      <Card>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <Text style={styles.rowLabel}>{label}</Text>
            <Text style={styles.rowValue}>{value}</Text>
          </View>
        ))}
      </Card>

      <SectionLabel>Offline limits</SectionLabel>
      <Card>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Per-transaction cap</Text>
          <Text style={styles.rowValue}>{koboToNairaString(OFFLINE_LIMITS.maxSingleSendKobo)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Daily send cap</Text>
          <Text style={styles.rowValue}>{koboToNairaString(OFFLINE_LIMITS.maxDailySendKobo)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Daily receive cap</Text>
          <Text style={styles.rowValue}>{koboToNairaString(OFFLINE_LIMITS.maxDailyReceiveKobo)}</Text>
        </View>
      </Card>

      {/* Inline Demo Bank Modal */}
      <Modal visible={modalVisible} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>🏦 Demo Bank Gateway</Text>
            <Text style={styles.modalSubtitle}>Enter custom amount to fund offline wallet</Text>

            <Text style={styles.inputLabel}>Amount (₦)</Text>
            <TextInput
              style={styles.input}
              value={amountInput}
              onChangeText={setAmountInput}
              keyboardType="numeric"
              placeholder="2000"
              placeholderTextColor="#666"
            />

            <TouchableOpacity style={styles.confirmBtn} onPress={handleDeposit} disabled={loading}>
              {loading ? <ActivityIndicator color="#000" /> : <Text style={styles.confirmBtnText}>Confirm Deposit</Text>}
            </TouchableOpacity>

            <TouchableOpacity style={styles.cancelBtn} onPress={() => setModalVisible(false)} disabled={loading}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topUpContainer: { marginBottom: spacing.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowLabel: { ...typography.body, color: colors.textSecondary },
  rowValue: { ...typography.body, color: colors.textPrimary, fontWeight: '600' },
  empty: { ...typography.body, color: colors.textMuted },
  errorText: { ...typography.body, color: colors.danger, marginBottom: spacing.md },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { width: '85%', backgroundColor: '#121212', borderRadius: 16, padding: 20, borderWidth: 1, borderColor: '#00FF9D' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#fff', marginBottom: 4 },
  modalSubtitle: { fontSize: 12, color: '#aaa', marginBottom: 16 },
  inputLabel: { fontSize: 12, color: '#00FF9D', marginBottom: 6 },
  input: { backgroundColor: '#1a1a1a', color: '#fff', padding: 12, borderRadius: 8, fontSize: 16, borderWidth: 1, borderColor: '#333', marginBottom: 20 },
  confirmBtn: { backgroundColor: '#00FF9D', padding: 14, borderRadius: 8, alignItems: 'center' },
  confirmBtnText: { color: '#000', fontWeight: 'bold', fontSize: 15 },
  cancelBtn: { marginTop: 12, alignItems: 'center', padding: 8 },
  cancelBtnText: { color: '#ff4d4d', fontSize: 14 }
});