package expo.modules.bleperipheral

import android.Manifest
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.util.UUID

/**
 * BLE peripheral role for Offline Naira: advertising + a GATT server with
 * TX_OFFER (write, central -> this device) and TX_ACK (notify, this
 * device -> central) characteristics.
 *
 * Design note: this module does NOT chunk outgoing messages or reassemble
 * incoming ones — that logic lives once, in JS
 * (src/protocol/ble-protocol.ts's frameMessage/MessageReassembler), shared
 * by both the central and peripheral roles in BleService.ts. Native's job
 * is purely the GATT plumbing: relay each already-framed chunk out as a
 * notification, and parse just enough of each incoming write to hand the
 * chunk's fields to JS as an event. Keeping the framing logic in one
 * language avoids exactly the kind of hand-synced-in-two-places drift
 * flagged in docs/LIMITATIONS.md for the transaction signing format.
 *
 * UUIDs below MUST exactly match src/protocol/ble-protocol.ts.
 *
 * Not yet run on hardware. Things most likely to need adjustment once you
 * do: OEM-specific advertising payload limits on some Android skins, and
 * confirming the negotiated MTU (requested from the central side in
 * BleService.connect) is actually honored before the first chunk write —
 * if a central writes before MTU negotiation completes, a 180-byte chunk
 * can be silently truncated by the stack.
 */
private val SERVICE_UUID: UUID = UUID.fromString("7e9a0001-0000-1000-8000-00805f9b34fb")
private val CHAR_TX_OFFER: UUID = UUID.fromString("7e9a0003-0000-1000-8000-00805f9b34fb")
private val CHAR_TX_ACK: UUID = UUID.fromString("7e9a0004-0000-1000-8000-00805f9b34fb")
private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

class BlePeripheralModule : Module() {

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  private val bluetoothManager: BluetoothManager?
    get() = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

  private var advertiser: BluetoothLeAdvertiser? = null
  private var gattServer: BluetoothGattServer? = null
  private var connectedDevice: BluetoothDevice? = null
  private var txAckNotificationsEnabled = false

  override fun definition() = ModuleDefinition {
    Name("BlePeripheral")

    Events("onTxOfferReceived", "onCentralConnected", "onCentralDisconnected", "onAdvertisingFailed")

    AsyncFunction("startAdvertising") { promise: Promise -> startAdvertisingInternal(promise) }
    AsyncFunction("stopAdvertising") { promise: Promise -> stopAdvertisingInternal(promise) }
    AsyncFunction("startGattServer") { promise: Promise -> startGattServerInternal(promise) }
    AsyncFunction("stopGattServer") { promise: Promise -> stopGattServerInternal(promise) }
    AsyncFunction("notifyCharacteristic") { characteristicName: String, chunkJson: String, promise: Promise ->
      notifyCharacteristicInternal(characteristicName, chunkJson, promise)
    }
    AsyncFunction("isAdvertisingSupported") { promise: Promise ->
      promise.resolve(bluetoothManager?.adapter?.bluetoothLeAdvertiser != null)
    }

    OnDestroy {
      teardown()
    }
  }

  // ---------- permissions ----------
  // JS is expected to have already requested these via PermissionsAndroid
  // (BleService.requestPermissions) before calling into this module. These
  // checks are a safety net, not a substitute for that — a native module
  // has no clean way to drive the Android runtime permission dialog itself
  // without an Activity result launcher, which Expo modules don't give you
  // directly.

  private fun hasPermission(permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  private fun hasAdvertisePermission(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S || hasPermission(Manifest.permission.BLUETOOTH_ADVERTISE)

  private fun hasConnectPermission(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S || hasPermission(Manifest.permission.BLUETOOTH_CONNECT)

  // ---------- advertising ----------

  private fun startAdvertisingInternal(promise: Promise) {
    if (!hasAdvertisePermission()) {
      promise.reject(
        "PERMISSION_DENIED",
        "BLUETOOTH_ADVERTISE not granted. Request it from JS (PermissionsAndroid) before calling startAdvertising.",
        null,
      )
      return
    }

    val adapter = bluetoothManager?.adapter
    if (adapter == null || !adapter.isEnabled) {
      promise.reject("BLUETOOTH_OFF", "Bluetooth adapter is unavailable or disabled.", null)
      return
    }

    val leAdvertiser = adapter.bluetoothLeAdvertiser
    if (leAdvertiser == null) {
      promise.reject("ADVERTISING_UNSUPPORTED", "This device does not support BLE advertising.", null)
      return
    }
    advertiser = leAdvertiser

    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true)
      .build()

    // Keep the advertisement itself small (just the service UUID) — device
    // identity is exchanged after connection, not broadcast.
    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .addServiceUuid(ParcelUuid(SERVICE_UUID))
      .build()

    var resolved = false
    val callback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
        if (!resolved) {
          resolved = true
          promise.resolve(null)
        }
      }

      override fun onStartFailure(errorCode: Int) {
        sendEvent("onAdvertisingFailed", mapOf("errorCode" to errorCode))
        if (!resolved) {
          resolved = true
          promise.reject("ADVERTISE_FAILED", "startAdvertising failed with error code $errorCode", null)
        }
      }
    }

    try {
      leAdvertiser.startAdvertising(settings, data, callback)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_DENIED", e.message ?: "SecurityException while starting advertising", e)
    }
  }

  private fun stopAdvertisingInternal(promise: Promise) {
    try {
      advertiser?.stopAdvertising(object : AdvertiseCallback() {})
      promise.resolve(null)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_DENIED", e.message ?: "SecurityException while stopping advertising", e)
    }
  }

  // ---------- GATT server ----------

  private fun startGattServerInternal(promise: Promise) {
    if (!hasConnectPermission()) {
      promise.reject(
        "PERMISSION_DENIED",
        "BLUETOOTH_CONNECT not granted. Request it from JS before calling startGattServer.",
        null,
      )
      return
    }

    val manager = bluetoothManager
    if (manager == null) {
      promise.reject("BLUETOOTH_UNAVAILABLE", "BluetoothManager is not available on this device.", null)
      return
    }

    try {
      val server = manager.openGattServer(context, gattServerCallback)
      if (server == null) {
        promise.reject("GATT_SERVER_FAILED", "openGattServer returned null.", null)
        return
      }
      gattServer = server

      val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

      val txOfferChar = BluetoothGattCharacteristic(
        CHAR_TX_OFFER,
        BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
        BluetoothGattCharacteristic.PERMISSION_WRITE,
      )

      val txAckChar = BluetoothGattCharacteristic(
        CHAR_TX_ACK,
        BluetoothGattCharacteristic.PROPERTY_NOTIFY,
        BluetoothGattCharacteristic.PERMISSION_READ,
      )
      val cccd = BluetoothGattDescriptor(
        CCCD_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      )
      txAckChar.addDescriptor(cccd)

      service.addCharacteristic(txOfferChar)
      service.addCharacteristic(txAckChar)

      if (!server.addService(service)) {
        promise.reject("GATT_SERVICE_FAILED", "Failed to queue the Offline Naira GATT service for registration.", null)
        return
      }
      promise.resolve(null)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_DENIED", e.message ?: "SecurityException while starting the GATT server", e)
    }
  }

  private fun stopGattServerInternal(promise: Promise) {
    try {
      connectedDevice?.let { gattServer?.cancelConnection(it) }
      gattServer?.close()
      gattServer = null
      connectedDevice = null
      txAckNotificationsEnabled = false
      promise.resolve(null)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_DENIED", e.message ?: "SecurityException while stopping the GATT server", e)
    }
  }

  private fun teardown() {
    try {
      advertiser?.stopAdvertising(object : AdvertiseCallback() {})
      connectedDevice?.let { gattServer?.cancelConnection(it) }
      gattServer?.close()
    } catch (_: SecurityException) {
      // best-effort cleanup when the module is being torn down
    }
    advertiser = null
    gattServer = null
    connectedDevice = null
  }

  // ---------- sending a notification (one already-framed chunk) ----------

  @Suppress("DEPRECATION") // notifyCharacteristicChanged(device, char, confirm) is deprecated on API 33+
  // in favor of an overload that takes the value directly, but this form still works down to
  // minSdk and keeps one code path for all supported Android versions.
  private fun notifyCharacteristicInternal(characteristicName: String, chunkJson: String, promise: Promise) {
    if (characteristicName != "TX_ACK") {
      promise.reject("UNSUPPORTED_CHARACTERISTIC", "Only TX_ACK is notify-capable on this GATT server.", null)
      return
    }
    if (!hasConnectPermission()) {
      promise.reject("PERMISSION_DENIED", "BLUETOOTH_CONNECT not granted.", null)
      return
    }

    val server = gattServer
    val device = connectedDevice
    val characteristic = server?.getService(SERVICE_UUID)?.getCharacteristic(CHAR_TX_ACK)

    if (server == null || device == null || characteristic == null) {
      promise.reject("NOT_CONNECTED", "No connected central device to notify.", null)
      return
    }
    if (!txAckNotificationsEnabled) {
      promise.reject(
        "NOTIFICATIONS_DISABLED",
        "The connected central has not subscribed to TX_ACK notifications yet.",
        null,
      )
      return
    }

    try {
      // chunkJson is already a complete FramedChunk JSON string built by
      // frameMessage() in ble-protocol.ts — set it as the raw GATT value
      // verbatim, no re-parsing or re-encoding needed on this side.
      characteristic.value = chunkJson.toByteArray(Charsets.UTF_8)
      val notified = server.notifyCharacteristicChanged(device, characteristic, false)
      if (!notified) {
        promise.reject("NOTIFY_FAILED", "notifyCharacteristicChanged returned false.", null)
        return
      }
      promise.resolve(null)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_DENIED", e.message ?: "SecurityException while notifying TX_ACK", e)
    }
  }

  // ---------- GATT server callback ----------

  private val gattServerCallback = object : BluetoothGattServerCallback() {

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      when (newState) {
        BluetoothProfile.STATE_CONNECTED -> {
          // Prototype note: single active connection is tracked. Extend
          // connectedDevice to a Set<BluetoothDevice> if you need this
          // device to serve multiple centrals at once.
          connectedDevice = device
          sendEvent("onCentralConnected", mapOf("deviceAddress" to device.address))
        }
        BluetoothProfile.STATE_DISCONNECTED -> {
          if (connectedDevice?.address == device.address) {
            connectedDevice = null
            txAckNotificationsEnabled = false
          }
          sendEvent("onCentralDisconnected", mapOf("deviceAddress" to device.address))
        }
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      if (characteristic.uuid == CHAR_TX_OFFER) {
        emitIncomingChunk(value)
      }
      if (responseNeeded) {
        try {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
        } catch (_: SecurityException) {
          // permission revoked mid-flight — nothing more we can do for this request
        }
      }
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      if (descriptor.uuid == CCCD_UUID && descriptor.characteristic.uuid == CHAR_TX_ACK) {
        txAckNotificationsEnabled = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
      }
      if (responseNeeded) {
        try {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
        } catch (_: SecurityException) {
          // ignore
        }
      }
    }
  }

  /**
   * The raw write value IS a FramedChunk JSON string (written verbatim by
   * the central's writeMessage, which base64-decodes its own btoa()'d
   * value en route — see chunkToBase64Payload/BleManager's write encoding
   * in BleService.ts). Parse just enough to forward typed fields to JS;
   * JS (MessageReassembler) does the actual reassembly across chunks.
   */
  private fun emitIncomingChunk(rawValue: ByteArray) {
    try {
      val json = JSONObject(String(rawValue, Charsets.UTF_8))
      sendEvent(
        "onTxOfferReceived",
        mapOf(
          "msgId" to json.getString("msgId"),
          "index" to json.getInt("index"),
          "count" to json.getInt("count"),
          "payloadB64" to json.getString("payloadB64"),
        ),
      )
    } catch (e: Exception) {
      // Malformed chunk JSON — drop it rather than crash the GATT callback
      // thread. A hardened build should log this to security_events (via
      // an event back to JS) rather than silently swallowing it, since a
      // malformed write could also be a probing attacker.
    }
  }
}
