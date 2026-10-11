// components/MockBankModal.tsx
import React, { useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import * as Haptics from 'expo-haptics';

interface MockBankModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: (amount: number) => void;
}

export default function MockBankModal({ visible, onClose, onSuccess }: MockBankModalProps) {
  const [amount, setAmount] = useState('10000');
  const [loading, setLoading] = useState(false);
  const [successToast, setSuccessToast] = useState(false);

  const handleDeposit = () => {
    setLoading(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

    setTimeout(() => {
      setLoading(false);
      setSuccessToast(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      setTimeout(() => {
        setSuccessToast(false);
        onSuccess(Number(amount));
        onClose();
      }, 1200);
    }, 1500);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={true}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          {successToast ? (
            <View style={styles.successContainer}>
              <Text style={styles.successIcon}>🎉</Text>
              <Text style={styles.successText}>₦{Number(amount).toLocaleString()} Funded Successfully!</Text>
            </View>
          ) : (
            <>
              <Text style={styles.title}>🏦 Demo Bank Gateway</Text>
              <Text style={styles.subtitle}>Simulating live bank deposit for presentation</Text>

              <Text style={styles.label}>Amount (₦)</Text>
              <TextInput
                style={styles.input}
                value={amount}
                onChangeText={setAmount}
                keyboardType="numeric"
              />

              <TouchableOpacity style={styles.fundButton} onPress={handleDeposit} disabled={loading}>
                {loading ? <ActivityIndicator color="#000" /> : <Text style={styles.fundButtonText}>Confirm Deposit</Text>}
              </TouchableOpacity>

              <TouchableOpacity onPress={onClose} style={styles.cancelButton}>
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
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { width: '85%', backgroundColor: '#121212', borderRadius: 20, padding: 20, borderWidth: 1, borderColor: '#00FF9D' },
  title: { fontSize: 18, fontWeight: 'bold', color: '#fff', marginBottom: 5 },
  subtitle: { fontSize: 12, color: '#aaa', marginBottom: 20 },
  label: { fontSize: 12, color: '#00FF9D', marginBottom: 8 },
  input: { backgroundColor: '#1a1a1a', color: '#fff', padding: 12, borderRadius: 8, fontSize: 16, borderWidth: 1, borderColor: '#333', marginBottom: 20 },
  fundButton: { backgroundColor: '#00FF9D', padding: 15, borderRadius: 10, alignItems: 'center' },
  fundButtonText: { color: '#000', fontWeight: 'bold', fontSize: 16 },
  cancelButton: { marginTop: 10, alignItems: 'center', padding: 10 },
  cancelText: { color: '#ff4d4d', fontSize: 14 },
  successContainer: { alignItems: 'center', padding: 20 },
  successIcon: { fontSize: 40, marginBottom: 10 },
  successText: { color: '#00FF9D', fontSize: 16, fontWeight: 'bold', textAlign: 'center' }
});