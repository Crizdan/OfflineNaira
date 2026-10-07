/**
* BleService handles both BLE roles:
*  - Central/client via react-native-ble-plx
*  - Peripheral/server via local `BlePeripheral` Expo Module
*/
import { BleManager, Device, Subscription, State } from 'react-native-ble-plx';
import { PermissionsAndroid, Platform } from 'react-native';
import type { EventSubscription } from 'expo-modules-core';
import { Buffer } from 'buffer';
import {
  OFFLINE_NAIRA_SERVICE_UUID,
  CHARACTERISTICS,
  frameMessage,
  MessageReassembler,
  FramedChunk,
} from '../../protocol/ble-protocol';
import BlePeripheral from '../../../modules/ble-peripheral';

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
  private _manager: BleManager | null = null;
  private connected: Device | null = null;
  private centralReassembler = new MessageReassembler();
  private peripheralReassembler = new MessageReassembler();
  private stateListeners = new Set<Listener<BleConnectionState>>();
  private retryCount = 0;
  private readonly maxRetries = 3;

  private peripheralSubs: EventSubscription[] = [];
  private gattServerStarted = false;
  private advertisingStarted = false;

  private get manager(): BleManager {
    if (!this._manager) {
      try {
        this._manager = new BleManager();
      } catch (err) {
        console.error('Failed to initialize BleManager:', err);
        throw new Error(
          'BLE native module is unavailable. Ensure you have installed the newly compiled APK build on this phone.',
        );
      }
    }
    return this._manager;
  }

  private checkPeripheralModule(): void {
    if (!BlePeripheral) {
      throw new Error(
        'BlePeripheral native module is not available in this build. Please reinstall the new APK.',
      );
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
    const state = await this.manager.state();
    if (state === State.PoweredOn) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sub.remove();
        reject(new Error('Bluetooth did not power on in time'));
      }, timeoutMs);
      const sub = this.manager.onStateChange((s) => {
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

  scanForPeers(
    onFound: Listener<DiscoveredPeer>,
    timeoutMs = 15000,
    onError?: Listener<Error>,
  ): () => void {
    this.emitState('SCANNING');
    try {
      this.manager.startDeviceScan([OFFLINE_NAIRA_SERVICE_UUID], null, (error, device) => {
        if (error) {
          this.emitState('ERROR');
          onError?.(error);
          return;
        }
        if (device) {
          onFound({ deviceId: device.id, rssi: device.rssi, name: device.name });
        }
      });
    } catch (err) {
      this.emitState('ERROR');
      onError?.(err instanceof Error ? err : new Error(String(err)));
      return () => {};
    }

    const timer = setTimeout(() => {
      try {
        this.manager.stopDeviceScan();
      } catch {}
    }, timeoutMs);

    return () => {
      clearTimeout(timer);
      try {
        this.manager.stopDeviceScan();
      } catch {}
    };
  }

  async connect(bleDeviceId: string): Promise<Device> {
    try {
      this.manager.stopDeviceScan();
    } catch {}

    if (this.connected) await this.disconnect();
    this.emitState('CONNECTING');
    await sleep(300);

    try {
      const device = await this.manager.connectToDevice(bleDeviceId, {
        autoConnect: false,
        timeout: 10_000,
        refreshGatt: 'OnConnected',
      } as any);

      this.emitState('DISCOVERING');
      const discovered = await device.discoverAllServicesAndCharacteristics();

      try {
        await discovered.requestMTU(517);
      } catch {
        // Ignored if device rejects MTU request
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
      try {
        await this.manager.cancelDeviceConnection(bleDeviceId);
      } catch {}
      this.connected = null;
      this.emitState('ERROR');
      throw err;
    }
  }

  async retryConnect(bleDeviceId: string): Promise<Device> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.connect(bleDeviceId);
      } catch (err) {
        lastError = err;
        await sleep(500 * attempt);
      }
    }
    throw new Error(
      `Failed to connect after ${this.maxRetries} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  async connectToNearestPeer(scanTimeoutMs = 10_000): Promise<Device> {
    const peer = await new Promise<DiscoveredPeer>((resolve, reject) => {
      let settled = false;
      let stopScan: () => void = () => {};
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopScan();
        fn();
      };
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new Error(
                'No Offline Naira device found nearby. Make sure the other phone is on its Receive screen with Bluetooth on.',
              ),
            ),
          ),
        scanTimeoutMs,
      );
      stopScan = this.scanForPeers(
        (found) => finish(() => resolve(found)),
        scanTimeoutMs,
        (err) => finish(() => reject(err)),
      );
    });
    return this.retryConnect(peer.deviceId);
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
    if (this.connected) {
      try {
        await this.manager.cancelDeviceConnection(this.connected.id);
      } catch {}
      this.connected = null;
    }
    this.emitState('DISCONNECTED');
  }

  // ============================================================
  // PERIPHERAL ROLE — advertise, run GATT server, receive offers, send acks
  // ============================================================

  async startAdvertising(): Promise<void> {
    this.checkPeripheralModule();
    await BlePeripheral.startAdvertising();
    this.advertisingStarted = true;
    this.emitState('ADVERTISING');
  }

  async stopAdvertising(): Promise<void> {
    if (!this.advertisingStarted || !BlePeripheral) return;
    try {
      await BlePeripheral.stopAdvertising();
    } catch (e) {
      console.warn('Failed to stop advertising cleanly:', e);
    } finally {
      this.advertisingStarted = false;
    }
  }

  async startGattServer(): Promise<void> {
    this.checkPeripheralModule();
    await BlePeripheral.startGattServer();
    this.gattServerStarted = true;

    if (typeof BlePeripheral.addListener === 'function') {
      this.peripheralSubs.push(
        BlePeripheral.addListener('onCentralConnected', () => this.emitState('CONNECTED')),
        BlePeripheral.addListener('onCentralDisconnected', () => this.emitState('DISCONNECTED')),
        BlePeripheral.addListener('onAdvertisingFailed', () => this.emitState('ERROR')),
      );
    }
  }

  async stopGattServer(): Promise<void> {
    if (!this.gattServerStarted || !BlePeripheral) return;
    try {
      await BlePeripheral.stopGattServer();
    } catch (e) {
      console.warn('Failed to stop GATT server cleanly:', e);
    } finally {
      this.gattServerStarted = false;
      this.peripheralSubs.forEach((s) => s.remove());
      this.peripheralSubs = [];
    }
  }

  subscribeToOffers(onOffer: Listener<Uint8Array>): () => void {
    this.checkPeripheralModule();
    if (typeof BlePeripheral.addListener !== 'function') {
      console.warn('BlePeripheral.addListener is not supported in this environment.');
      return () => {};
    }

    const sub = BlePeripheral.addListener('onTxOfferReceived', (event: FramedChunk) => {
      const complete = this.peripheralReassembler.addChunk(event);
      if (complete) onOffer(complete);
    });
    this.peripheralSubs.push(sub);
    return () => sub.remove();
  }

  async sendTxAck(bytes: Uint8Array): Promise<void> {
    const chunks = frameMessage(newMsgId(), bytes);
    for (const chunk of chunks) {
      await this.notifyChunkWithRetry(JSON.stringify(chunk));
    }
  }

  private async notifyChunkWithRetry(chunkJson: string): Promise<void> {
    this.checkPeripheralModule();
    const key = characteristicKeyFor(CHARACTERISTICS.TX_ACK);
    for (let attempt = 0; ; attempt++) {
      try {
        await BlePeripheral.notifyCharacteristic(key, chunkJson);
        return;
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const transient = code === 'NOTIFICATIONS_DISABLED' || code === 'BUSY';
        if (!transient || attempt >= 15) throw err;
        await sleep(200);
      }
    }
  }

  async isAdvertisingSupported(): Promise<boolean> {
    if (!BlePeripheral || typeof BlePeripheral.isAdvertisingSupported !== 'function') {
      return false;
    }
    return BlePeripheral.isAdvertisingSupported();
  }

  destroy(): void {
    try {
      this._manager?.destroy();
    } catch {}
    this.peripheralSubs.forEach((s) => s.remove());
    this.peripheralSubs = [];
  }
}

function chunkToBase64Payload(chunk: FramedChunk): string {
  const json = JSON.stringify(chunk);
  return Buffer.from(json).toString('base64');
}

function base64PayloadToChunk(payload: string): FramedChunk {
  const json = Buffer.from(payload, 'base64').toString('utf-8');
  return JSON.parse(json) as FramedChunk;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function newMsgId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function characteristicKeyFor(uuid: string): string {
  const entry = Object.entries(CHARACTERISTICS).find(
    ([, v]) => v.toLowerCase() === uuid.toLowerCase(),
  );
  if (!entry) throw new Error(`Unknown characteristic UUID: ${uuid}`);
  return entry[0];
}

export { CHARACTERISTICS };