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
  scanForPeers(
    onFound: Listener<DiscoveredPeer>,
    timeoutMs = 15000,
    onError?: Listener<Error>,
  ): () => void {
    this.emitState('SCANNING');
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

    const timer = setTimeout(() => this.manager.stopDeviceScan(), timeoutMs);
    return () => {
      clearTimeout(timer);
      this.manager.stopDeviceScan();
    };
  }

  async connect(bleDeviceId: string): Promise<Device> {
    // 1. Never connect while a scan is running. The radio is busy scanning and
    //    the connection request is frequently dropped, which Android reports
    //    as GATT status 133.
    this.manager.stopDeviceScan();
    // 2. Never hold two GATT client slots at once; drop any previous link.
    if (this.connected) await this.disconnect();
    this.emitState('CONNECTING');
    // 3. Give the controller a moment to settle after the scan stops.
    await sleep(300);
    try {
      const device = await this.manager.connectToDevice(bleDeviceId, {
        autoConnect: false, // user-initiated transfer: direct connect, never background polling
        timeout: 10_000,
        // Android caches a device's GATT table. If an earlier discovery
        // happened before the peer's server had registered its service, the
        // cache stays empty and the Offline Naira service is never "found".
        // VERIFY ON DEVICE: option name/value per react-native-ble-plx v3
        // (RefreshGattMoment.OnConnected); cast because the enum is not
        // imported here.
        refreshGatt: 'OnConnected',
      } as any);
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
      // A connect that half-succeeded (link up, discovery failed) leaves a
      // live GATT client behind. Android only has a handful of those slots;
      // once they are all leaked every later connect fails instantly with
      // status 133. Always cancel before surfacing the error.
      try {
        await this.manager.cancelDeviceConnection(bleDeviceId);
      } catch {
        // already disconnected - nothing to clean up
      }
      this.connected = null;
      this.emitState('ERROR');
      throw err;
    }
  }

  async retryConnect(bleDeviceId: string): Promise<Device> {
    // Local counter: the old instance-level retryCount was never reset after
    // an exhausted run, so after one total failure every later call skipped
    // the loop and threw immediately without trying.
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.connect(bleDeviceId);
      } catch (err) {
        lastError = err;
        await sleep(500 * attempt); // backoff
      }
    }
    throw new Error(
      `Failed to connect after ${this.maxRetries} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /**
   * The step the Send flow was missing entirely: scan for a device
   * advertising the Offline Naira service, stop scanning, then connect.
   * Without this nothing ever set `this.connected`, so writeMessage threw
   * "Not connected" on every send.
   *
   * Connects to the first peer found. The advertisement carries only the
   * service UUID (no device identity), so who you reached is verified
   * cryptographically afterwards: PaymentEngine rejects any receipt whose
   * receiverDeviceId is not the device you meant to pay.
   */
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
      await this.notifyChunkWithRetry(JSON.stringify(chunk));
    }
  }

  /**
   * The central enables TX_ACK notifications by writing the CCCD; that can
   * land a moment after its offer write. Native rejects with
   * NOTIFICATIONS_DISABLED (or BUSY while the previous chunk is in flight)
   * in those windows - both are transient, so retry briefly instead of
   * failing a payment that was already committed locally.
   */
  private async notifyChunkWithRetry(chunkJson: string): Promise<void> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
