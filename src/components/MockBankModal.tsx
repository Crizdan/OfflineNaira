import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { depositOfflineFunds } from '../services/WalletService';
import { useDeviceIdentity } from '../services/useDeviceIdentity';
import { Kobo, koboToNairaString, nairaToKobo } from '../domain/money';

interface MockBankModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: (amount: number) => void;
}

const DEFAULT_AMOUNT = '10000';

/** Haptics must never be able to break a deposit. */
const buzz = (type: Haptics.NotificationFeedbackType) => {
  try {
    Haptics.notificationAsync(type).catch(() => {});
  } catch {
    // haptics unavailable - ignore
  }
};

/**
 * Keep only digits and a single decimal point (max 2 decimals), so typing
 * "₦2,000" or "2 000" yields "2000". The old code did Number("2,000") = NaN
 * and passed the raw text to nairaToKobo, whose strict regex rejects commas.
 */
function sanitizeAmount(input: string): string {
  const cleaned = input.replace(/[^0-9.]/g, '');
  const dot = cleaned.indexOf('.');
  if (dot === -1) return cleaned;
  const whole = cleaned.slice(0, dot) || '0';
  const frac = cleaned.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  return `${whole}.${frac}`;
}

/** Exact integer kobo from the typed text, or null if it is empty/zero/invalid. */
function parseKobo(text: string): Kobo | null {
  const t = text.replace(/\.$/, ''); // "5." while typing -> "5"
  if (!t) return null;
  try {
    const k = nairaToKobo(t);
    return k > 0 ? k : null;
  } catch {
    return null;
  }
}

export default function MockBankModal({ visible, onClose, onSuccess }: MockBankModalProps) {
  const { deviceId } = useDeviceIdentity();
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [loading, setLoading] = useState(false);
  const [successToast, setSuccessToast] = useState(false);
  const [depositedKobo, setDepositedKobo] = useState<Kobo | null>(null);

  // A ref (not state) so a fast double-tap can't start two deposits before the
  // "loading" re-render disables the button.
  const inFlight = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fresh state every time the modal opens.
  useEffect(() => {
    if (visible) {
      setAmount(DEFAULT_AMOUNT);
      setLoading(false);
      setSuccessToast(false);
      setDepositedKobo(null);
      inFlight.current = false;
    }
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [visible]);

  const previewKobo = parseKobo(amount);

  const handleDeposit = async () => {
    if (inFlight.current) return;

    const koboAmount = parseKobo(amount);
    if (!koboAmount) {
      Alert.alert('Invalid Amount', 'Enter an amount greater than zero, for example 2000 or 2,000.50.');
      return;
    }

    if (!deviceId) {
      Alert.alert('Wallet Not Ready', 'Device identity is still initializing.');
      return;
    }

    inFlight.current = true;
    setLoading(true);
    buzz(Haptics.NotificationFeedbackType.Warning);

    try {
      await depositOfflineFunds(deviceId, koboAmount); // writes the wallet row in SQLite

      buzz(Haptics.NotificationFeedbackType.Success);
      setLoading(false);
      setDepositedKobo(koboAmount);
      setSuccessToast(true);

      // Refresh the wallet view right away so the new balance is already
      // showing behind the toast, then close once the toast has been seen.
      onSuccess(Number(koboAmount) / 100);
      closeTimer.current = setTimeout(() => {
        setSuccessToast(false);
        onClose();
      }, 1200);
      // inFlight stays true until the modal is reopened: no second deposit
      // while the success toast is up.
    } catch (err) {
      inFlight.current = false;
      setLoading(false);
      buzz(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Deposit Failed', err instanceof Error ? err.message : 'Could not credit wallet.');
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      statusBarTranslucent
      onRequestClose={() => {
        if (!loading) onClose(); // Android back button
      }}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          {successToast ? (
            <View style={styles.successContainer}>
              <Text style={styles.successIcon}>🎉</Text>
              <Text style={styles.successText}>
                {depositedKobo ? koboToNairaString(depositedKobo) : ''} Funded Successfully!
              </Text>
            </View>
          ) : (
            <>
              <Text style={styles.title}>🏦 Demo Bank Gateway</Text>
              <Text style={styles.subtitle}>Simulating live bank deposit for presentation</Text>

              <Text style={styles.label}>Amount (₦)</Text>
              <TextInput
                style={styles.input}
                value={amount}
                onChangeText={(t: string) => setAmount(sanitizeAmount(t))}
                keyboardType="decimal-pad"
                selectTextOnFocus
                maxLength={12}
                editable={!loading}
                placeholder="0.00"
                placeholderTextColor="#666"
              />
              <Text style={styles.preview}>
                {previewKobo ? `= ${koboToNairaString(previewKobo)}` : 'Enter an amount'}
              </Text>

              <TouchableOpacity
                style={[styles.fundButton, (loading || !previewKobo) && styles.fundButtonDisabled]}
                onPress={handleDeposit}
                disabled={loading || !previewKobo}
              >
                {loading ? <ActivityIndicator color="#000" /> : <Text style={styles.fundButtonText}>Confirm Deposit</Text>}
              </TouchableOpacity>

              <TouchableOpacity onPress={onClose} style={styles.cancelButton} disabled={loading}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Card sits near the top, not centred: a centred card is partly hidden by the
  // keyboard on Android because a Modal is its own window and isn't resized.
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-start', alignItems: 'center', paddingTop: 90 },
  modalContent: { width: '85%', backgroundColor: '#121212', borderRadius: 20, padding: 20, borderWidth: 1, borderColor: '#00FF9D' },
  title: { fontSize: 18, fontWeight: 'bold', color: '#fff', marginBottom: 5 },
  subtitle: { fontSize: 12, color: '#aaa', marginBottom: 20 },
  label: { fontSize: 12, color: '#00FF9D', marginBottom: 8 },
  input: { backgroundColor: '#1a1a1a', color: '#fff', padding: 12, borderRadius: 8, fontSize: 16, borderWidth: 1, borderColor: '#333', marginBottom: 8 },
  preview: { fontSize: 12, color: '#aaa', marginBottom: 16 },
  fundButton: { backgroundColor: '#00FF9D', padding: 15, borderRadius: 10, alignItems: 'center' },
  fundButtonDisabled: { opacity: 0.5 },
  fundButtonText: { color: '#000', fontWeight: 'bold', fontSize: 16 },
  cancelButton: { marginTop: 10, alignItems: 'center', padding: 10 },
  cancelText: { color: '#ff4d4d', fontSize: 14 },
  successContainer: { alignItems: 'center', padding: 20 },
  successIcon: { fontSize: 40, marginBottom: 10 },
  successText: { color: '#00FF9D', fontSize: 16, fontWeight: 'bold', textAlign: 'center' }
});
