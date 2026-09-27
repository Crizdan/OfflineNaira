import { BleManager, Device, Subscription, State } from 'react-native-ble-plx';
import { PermissionsAndroid, Platform } from 'react-native';
import type { EventSubscription } from 'expo-modules-core';
import {
  OFFLINE_NAIRA_SERVICE_UUID,
  CHARACTERISTICS,
  frameMessage,
  MessageReassembler,
  FramedChunk,
} from '../../protocol/ble-protocol';
import { Buffer } from 'buffer';

// Safely attempt to load local native BlePeripheral module without throwing if missing from binary
let BlePeripheralModule: any = null;
try {
  const module = require('../../../modules/ble-peripheral');
  BlePeripheralModule = module.default || module;
} catch (e) {
  console.warn('BlePeripheral native module not linked or available:', e);
}

// Fallback proxy to prevent null-reference runtime crashes
const SafeBlePeripheral = {
  startAdvertising: async () => {
    if (BlePeripheralModule?.startAdvertising) {
      return await BlePeripheralModule.startAdvertising();
    }
    console.warn('BlePeripheral.startAdvertising is not available on this build.');
  },
  stopAdvertising: async () => {
    if (BlePeripheralModule?.stopAdvertising) {
      return await BlePeripheralModule.stopAdvertising();
    }
  },
  startGattServer: async () => {
    if (BlePeripheralModule?.startGattServer) {
      return await BlePeripheralModule.startGattServer();
    }
    console.warn('BlePeripheral.startGattServer is not available on this build.');
  },
  stopGattServer: async () => {
    if (BlePeripheralModule?.stopGattServer) {
      return await BlePeripheralModule.stopGattServer();
    }
  },
  addListener: (eventName: string, listener: Function): EventSubscription => {
    if (BlePeripheralModule?.addListener) {
      try {
        return BlePeripheralModule.addListener(eventName, listener);
      } catch (e) {
        console.warn(`Failed to attach listener ${eventName}:`, e);
      }
    }
    return { remove: () => {} } as EventSubscription;
  },
  notifyCharacteristic: async (key: string, data: string) => {
    if (BlePeripheralModule?.notifyCharacteristic) {
      return await BlePeripheralModule.notifyCharacteristic(key, data);
    }
  },
  isAdvertisingSupported: async (): Promise<boolean> => {
    if (BlePeripheralModule?.isAdvertisingSupported) {
      try {
        return await BlePeripheralModule.isAdvertisingSupported();
      } catch {
        return false;
      }
    }
    return false;
  },
};

export type BleConnectionState =
  | 'IDLE'
  | 'REQUESTING_PERMISSIONS'
  | 'SCANNING'
  | 'CONNECTING'
  | 'DISCOVERING'
  | 'CONNECTED'
  | 'ADVERTISING'
  | 'DISCONNECTED'
  | 'ERROR';

export interface DiscoveredPeer {
  deviceId: string;
  rssi: number | null;
  name: string | null;
}

type Listener<T> = (value: T) => void;

export class BleService {
  private manager: BleManager | null = null;
  private connected: Device | null = null;
  private centralReassembler = new MessageReassembler();
  private peripheralReassembler = new MessageReassembler();
  private stateListeners = new Set<Listener<BleConnectionState>>();
  private retryCount = 0;
  private readonly maxRetries = 3;

  private peripheralSubs: EventSubscription[] = [];
  private gattServerStarted = false;
  private advertisingStarted = false;

  constructor() {
    try {
      this.manager = new BleManager();
    } catch (err) {
      console.warn('Failed to initialize BleManager:', err);
    }
  }

  onStateChange(fn: Listener<BleConnectionState>): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private emitState(state: BleConnectionState): void {
    this.stateListeners.forEach((l) => l(state));
  }

  async requestPermissions(): Promise<boolean> {
    this.emitState('REQUESTING_PERMISSIONS');
    if (Platform.OS !== 'android') return true;

    const sdkInt = Platform.Version as number;
    const perms =
      sdkInt >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

    const results = await PermissionsAndroid.requestMultiple(perms);
    return Object.values(results).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
  }

  async waitForPoweredOn(timeoutMs = 5000): Promise<void> {
    if (!this.manager) return;
    const state = await this.manager.state();
    if (state === State.PoweredOn) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sub.remove();
        reject(new Error('Bluetooth did not power on in time'));
      }, timeoutMs);
      const sub = this.manager!.onStateChange((s) => {
        if (s === State.PoweredOn) {
          clearTimeout(timeout);
          sub.remove();
          resolve();
        }
      }, true);
    });
  }

  // ============================================================
  // CENTRAL ROLE — scan, connect, write offers, read acks
  // ============================================================

  scanForPeers(onFound: Listener<DiscoveredPeer>, timeoutMs = 15000): () => void {
    if (!this.manager) {
      this.emitState('ERROR');
      return () => {};
    }
    this.emitState('SCANNING');
    this.manager.startDeviceScan([OFFLINE_NAIRA_SERVICE_UUID], null, (error, device) => {
      if (error) {
        this.emitState('ERROR');
        return;
      }
      if (device) {
        onFound({ deviceId: device.id, rssi: device.rssi, name: device.name });
      }
    });

    const timer = setTimeout(() => this.manager?.stopDeviceScan(), timeoutMs);
    return () => {
      clearTimeout(timer);
      this.manager?.stopDeviceScan();
    };
  }

  async connect(bleDeviceId: string): Promise<Device> {
    if (!this.manager) throw new Error('BLE Manager not initialized');
    this.emitState('CONNECTING');
    try {
      const device = await this.manager.connectToDevice(bleDeviceId, { autoConnect: false });
      this.emitState('DISCOVERING');
      const discovered = await device.discoverAllServicesAndCharacteristics();

      try {
        await discovered.requestMTU(517);
      } catch {
        // Ignored
      }

      this.connected = discovered;
      this.retryCount = 0;
      this.emitState('CONNECTED');

      device.onDisconnected((_error) => {
        this.connected = null;
        this.emitState('DISCONNECTED');
      });

      return discovered;
    } catch (err) {
      this.emitState('ERROR');
      throw err;
    }
  }

  async retryConnect(bleDeviceId: string): Promise<Device> {
    while (this.retryCount < this.maxRetries) {
      try {
        return await this.connect(bleDeviceId);
      } catch (err) {
        this.retryCount++;
        await new Promise((r) => setTimeout(r, 500 * this.retryCount));
      }
    }
    throw new Error(`Failed to connect after ${this.maxRetries} attempts`);
  }

  async writeMessage(characteristicUUID: string, msgId: string, bytes: Uint8Array): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    const chunks = frameMessage(msgId, bytes);
    for (const chunk of chunks) {
      await this.connected.writeCharacteristicWithResponseForService(
        OFFLINE_NAIRA_SERVICE_UUID,
        characteristicUUID,
        chunkToBase64Payload(chunk),
      );
    }
  }

  subscribeMessages(characteristicUUID: string, onMessage: Listener<Uint8Array>): Subscription {
    if (!this.connected) throw new Error('Not connected');
    return this.connected.monitorCharacteristicForService(
      OFFLINE_NAIRA_SERVICE_UUID,
      characteristicUUID,
      (error, characteristic) => {
        if (error || !characteristic?.value) return;
        const chunk = base64PayloadToChunk(characteristic.value);
        const complete = this.centralReassembler.addChunk(chunk);
        if (complete) onMessage(complete);
      },
    );
  }

  async disconnect(): Promise<void> {
    if (this.connected && this.manager) {
      await this.manager.cancelDeviceConnection(this.connected.id);
      this.connected = null;
    }
    this.emitState('DISCONNECTED');
  }

  // ============================================================
  // PERIPHERAL ROLE — advertise, run GATT server, receive offers, send acks
  // ============================================================

  async startAdvertising(): Promise<void> {
    await SafeBlePeripheral.startAdvertising();
    this.advertisingStarted = true;
    this.emitState('ADVERTISING');
  }

  async stopAdvertising(): Promise<void> {
    if (!this.advertisingStarted) return;
    await SafeBlePeripheral.stopAdvertising();
    this.advertisingStarted = false;
  }

  async startGattServer(): Promise<void> {
    await SafeBlePeripheral.startGattServer();
    this.gattServerStarted = true;

    this.peripheralSubs.push(
      SafeBlePeripheral.addListener('onCentralConnected', () => this.emitState('CONNECTED')),
      SafeBlePeripheral.addListener('onCentralDisconnected', () => this.emitState('DISCONNECTED')),
      SafeBlePeripheral.addListener('onAdvertisingFailed', () => this.emitState('ERROR')),
    );
  }

  async stopGattServer(): Promise<void> {
    if (!this.gattServerStarted) return;
    await SafeBlePeripheral.stopGattServer();
    this.gattServerStarted = false;
    this.peripheralSubs.forEach((s) => s.remove());
    this.peripheralSubs = [];
  }

  subscribeToOffers(onOffer: Listener<Uint8Array>): () => void {
    const sub = SafeBlePeripheral.addListener('onTxOfferReceived', (event: any) => {
      const complete = this.peripheralReassembler.addChunk(event);
      if (complete) onOffer(complete);
    });
    this.peripheralSubs.push(sub);
    return () => sub.remove();
  }

  async sendTxAck(bytes: Uint8Array): Promise<void> {
    const chunks = frameMessage(newMsgId(), bytes);
    for (const chunk of chunks) {
      await SafeBlePeripheral.notifyCharacteristic(
        characteristicKeyFor(CHARACTERISTICS.TX_ACK),
        JSON.stringify(chunk),
      );
    }
  }

  async isAdvertisingSupported(): Promise<boolean> {
    return SafeBlePeripheral.isAdvertisingSupported();
  }

  destroy(): void {
    if (this.manager) {
      this.manager.destroy();
    }
    this.peripheralSubs.forEach((s) => s.remove());
    this.peripheralSubs = [];
  }
}

function chunkToBase64Payload(chunk: FramedChunk): string {
  const json = JSON.stringify(chunk);
  return typeof btoa === 'function' ? btoa(json) : Buffer.from(json).toString('base64');
}

function base64PayloadToChunk(payload: string): FramedChunk {
  const json = typeof atob === 'function' ? atob(payload) : Buffer.from(payload, 'base64').toString();
  return JSON.parse(json) as FramedChunk;
}

function newMsgId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function characteristicKeyFor(uuid: string): string {
  const entry = Object.entries(CHARACTERISTICS).find(([, v]) => v === uuid);
  if (!entry) throw new Error(`Unknown characteristic UUID: ${uuid}`);
  return entry[0];
}

export { CHARACTERISTICS };