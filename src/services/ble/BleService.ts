/**
 * NOTE (Expo): react-native-ble-plx and the local BlePeripheral module both
 * require custom native code, so none of this runs inside Expo Go. You
 * need a development build: `npx expo prebuild` then `npx expo run:android`
 * (or an EAS development build). See MIGRATION.md for the config plugin
 * setup.
 *
 * This service now covers BOTH BLE roles:
 *  - Central/client (scan, connect, write, subscribe to notifications) via
 *    react-native-ble-plx — this part has been here since the first draft.
 *  - Peripheral/server (advertise, run a GATT server, receive writes, send
 *    notifications) via the local `BlePeripheral` Expo Module in
 *    modules/ble-peripheral/ — this part is new. That module's Kotlin side
 *    is a real implementation now, not a stub, but it has not been built
 *    or run on hardware from this environment — treat it as an unverified
 *    first draft, not a guarantee. See modules/ble-peripheral/README.md.
 *
 * Central and peripheral each get their own MessageReassembler instance —
 * a device could in principle be mid-send (central) and mid-receive
 * (peripheral) at the same time, and their chunk streams must never mix.
 */
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
import BlePeripheral, { FramedChunkEvent } from '../../../modules/ble-peripheral';
import { Buffer } from 'buffer';

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
  deviceId: string; // BLE device id (not the Offline Naira deviceId — that's exchanged post-connect)
  rssi: number | null;
  name: string | null;
}

type Listener<T> = (value: T) => void;

export class BleService {
  private manager = new BleManager();
  private connected: Device | null = null;
  private centralReassembler = new MessageReassembler();
  private peripheralReassembler = new MessageReassembler();
  private stateListeners = new Set<Listener<BleConnectionState>>();
  private retryCount = 0;
  private readonly maxRetries = 3;

  private peripheralSubs: EventSubscription[] = [];
  private gattServerStarted = false;
  private advertisingStarted = false;

  onStateChange(fn: Listener<BleConnectionState>): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private emitState(state: BleConnectionState): void {
    this.stateListeners.forEach((l) => l(state));
  }

  /**
   * Same permission set covers both roles: BLUETOOTH_SCAN/CONNECT are
   * needed to be a central, BLUETOOTH_ADVERTISE to be a peripheral, and
   * ACCESS_FINE_LOCATION on pre-12 devices for scanning either way. Call
   * this once before using either role.
   */
  async requestPermissions(): Promise<boolean> {
    this.emitState('REQUESTING_PERMISSIONS');
    if (Platform.OS !== 'android') return true;

    // VERIFY ON DEVICE: exact permission set depends on target SDK / Android
    // version (12+ uses BLUETOOTH_SCAN/CONNECT/ADVERTISE; below that, ACCESS_FINE_LOCATION).
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

  /** Scans for nearby devices advertising the Offline Naira service UUID. */
  scanForPeers(onFound: Listener<DiscoveredPeer>, timeoutMs = 15000): () => void {
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

    const timer = setTimeout(() => this.manager.stopDeviceScan(), timeoutMs);
    return () => {
      clearTimeout(timer);
      this.manager.stopDeviceScan();
    };
  }

  async connect(bleDeviceId: string): Promise<Device> {
    this.emitState('CONNECTING');
    try {
      const device = await this.manager.connectToDevice(bleDeviceId, { autoConnect: false });
      this.emitState('DISCOVERING');
      const discovered = await device.discoverAllServicesAndCharacteristics();

      // Default unnegotiated ATT MTU is 23 bytes (≈20 usable), which is far
      // too small for a chunk whose JSON envelope + base64'd payload can run
      // several hundred bytes (see MAX_CHUNK_BYTES in ble-protocol.ts).
      // Without this, writes will either fail outright or silently truncate
      // depending on the OS/stack. 517 is the practical Android ceiling.
      try {
        await discovered.requestMTU(517);
      } catch {
        // Some devices/stacks reject MTU requests — not fatal, but large
        // chunks may fail; consider lowering MAX_CHUNK_BYTES if this happens
        // consistently on your test devices.
      }

      this.connected = discovered;
      this.retryCount = 0;
      this.emitState('CONNECTED');

      device.onDisconnected((_error) => {
        this.connected = null;
        this.emitState('DISCONNECTED');
        // Reconnect/retry handling is done by the caller (PaymentEngine),
        // which knows whether a COMMITTED-but-unconfirmed transaction is
        // outstanding and needs PENDING_RECONCILIATION instead of a silent retry.
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
        await new Promise((r) => setTimeout(r, 500 * this.retryCount)); // backoff
      }
    }
    throw new Error(`Failed to connect after ${this.maxRetries} attempts`);
  }

  /** Writes a full logical message (chunked as needed) to a characteristic. */
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

  /** Subscribes to notifications on a characteristic, reassembling chunked messages. */
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
      await this.manager.cancelDeviceConnection(this.connected.id);
      this.connected = null;
    }
    this.emitState('DISCONNECTED');
  }

  // ============================================================
  // PERIPHERAL ROLE — advertise, run GATT server, receive offers, send acks
  // ============================================================

  /** Starts advertising OFFLINE_NAIRA_SERVICE_UUID so a central can find this device. */
  async startAdvertising(): Promise<void> {
    await BlePeripheral.startAdvertising();
    this.advertisingStarted = true;
    this.emitState('ADVERTISING');
  }

  async stopAdvertising(): Promise<void> {
    if (!this.advertisingStarted) return;
    await BlePeripheral.stopAdvertising();
    this.advertisingStarted = false;
  }

  /**
   * Opens the GATT server and starts listening for TX_OFFER writes. Call
   * `subscribeToOffers` first (or right after) to actually receive them —
   * this only opens the server, it doesn't hand you offers by itself.
   */
  async startGattServer(): Promise<void> {
    await BlePeripheral.startGattServer();
    this.gattServerStarted = true;

    // Wire connection-state events into the same onStateChange stream
    // SendScreen already listens to for the central role, so ReceiveScreen
    // can drive its UI off one consistent state machine.
    this.peripheralSubs.push(
      BlePeripheral.addListener('onCentralConnected', () => this.emitState('CONNECTED')),
      BlePeripheral.addListener('onCentralDisconnected', () => this.emitState('DISCONNECTED')),
      BlePeripheral.addListener('onAdvertisingFailed', () => this.emitState('ERROR')),
    );
  }

  async stopGattServer(): Promise<void> {
    if (!this.gattServerStarted) return;
    await BlePeripheral.stopGattServer();
    this.gattServerStarted = false;
    this.peripheralSubs.forEach((s) => s.remove());
    this.peripheralSubs = [];
  }

  /**
   * Subscribes to reassembled TX_OFFER messages (i.e. full signed
   * transactions, already stitched back together from chunks — the caller
   * never sees individual FramedChunks). Feed the resulting bytes straight
   * into PaymentEngine.handleIncomingOffer.
   */
  subscribeToOffers(onOffer: Listener<Uint8Array>): () => void {
    const sub = BlePeripheral.addListener('onTxOfferReceived', (event: FramedChunkEvent) => {
      const complete = this.peripheralReassembler.addChunk(event);
      if (complete) onOffer(complete);
    });
    this.peripheralSubs.push(sub);
    return () => sub.remove();
  }

  /** Sends a full logical message (e.g. a SignedReceipt) back over TX_ACK, chunked as needed. */
  async sendTxAck(bytes: Uint8Array): Promise<void> {
    const chunks = frameMessage(newMsgId(), bytes);
    for (const chunk of chunks) {
      await BlePeripheral.notifyCharacteristic(
        characteristicKeyFor(CHARACTERISTICS.TX_ACK),
        JSON.stringify(chunk),
      );
    }
  }

  async isAdvertisingSupported(): Promise<boolean> {
    return BlePeripheral.isAdvertisingSupported();
  }

  destroy(): void {
    this.manager.destroy();
    this.peripheralSubs.forEach((s) => s.remove());
    this.peripheralSubs = [];
  }
}

// --- chunk <-> base64 GATT payload helpers (central role) ---
// VERIFY ON DEVICE: react-native-ble-plx expects/returns characteristic
// values as base64 strings already; here we additionally JSON-encode our
// FramedChunk envelope (msgId/index/count) then base64 it, since the chunk
// itself needs structure beyond raw bytes.
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

// CHARACTERISTICS maps name -> UUID; the native module's notifyCharacteristic
// takes the name ('TX_ACK' etc.), so invert the lookup once here.
function characteristicKeyFor(uuid: string): string {
  const entry = Object.entries(CHARACTERISTICS).find(([, v]) => v === uuid);
  if (!entry) throw new Error(`Unknown characteristic UUID: ${uuid}`);
  return entry[0];
}

export { CHARACTERISTICS };
