import { NativeModule, requireNativeModule } from 'expo-modules-core';

/**
 * Mirrors the FramedChunk shape from src/protocol/ble-protocol.ts exactly —
 * the native side parses the incoming write's JSON and re-emits these same
 * fields as a typed event instead of a raw string, so JS never has to
 * JSON.parse() native event payloads.
 */
export type FramedChunkEvent = {
  msgId: string;
  index: number;
  count: number;
  payloadB64: string;
};

export type BlePeripheralModuleEvents = {
  onTxOfferReceived: (event: FramedChunkEvent) => void;
  onCentralConnected: (event: { deviceAddress: string }) => void;
  onCentralDisconnected: (event: { deviceAddress: string }) => void;
  onAdvertisingFailed: (event: { errorCode: number }) => void;
};

declare class BlePeripheralModule extends NativeModule<BlePeripheralModuleEvents> {
  /** Starts BLE advertising of OFFLINE_NAIRA_SERVICE_UUID. Requires BLUETOOTH_ADVERTISE. */
  startAdvertising(): Promise<void>;
  stopAdvertising(): Promise<void>;

  /** Opens the GATT server and registers TX_OFFER/TX_ACK. Requires BLUETOOTH_CONNECT. */
  startGattServer(): Promise<void>;
  stopGattServer(): Promise<void>;

  /**
   * Sends one already-framed chunk (a JSON.stringify'd FramedChunk — see
   * frameMessage() in ble-protocol.ts) as a notification to the currently
   * connected central. Native does no chunking or JSON parsing of its own
   * here — JS owns that logic for both the central and peripheral roles,
   * native is just the GATT relay. characteristicName is a key from
   * CHARACTERISTICS in ble-protocol.ts; only 'TX_ACK' is notify-capable on
   * this device's GATT server.
   */
  notifyCharacteristic(characteristicName: string, chunkJson: string): Promise<void>;

  /** True if this device's BLE chipset/OS exposes a peripheral-mode advertiser at all. */
  isAdvertisingSupported(): Promise<boolean>;
}

export default requireNativeModule<BlePeripheralModule>('BlePeripheral');
