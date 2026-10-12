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
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.util.UUID

/**
* True 128-bit vendor-specific UUIDs (avoids Bluetooth SIG Base UUID collision).
* MUST match src/protocol/ble-protocol.ts
*/
private val SERVICE_UUID: UUID = UUID.fromString("7e9a0001-a1b2-4c3d-8e5f-90123456789a")
private val CHAR_TX_OFFER: UUID = UUID.fromString("7e9a0003-a1b2-4c3d-8e5f-90123456789a")
private val CHAR_TX_ACK: UUID = UUID.fromString("7e9a0004-a1b2-4c3d-8e5f-90123456789a")
private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

class BlePeripheralModule : Module() {

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  private val bluetoothManager: BluetoothManager?
    get() = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager

  private var advertiser: BluetoothLeAdvertiser? = null
  @Volatile private var advertiseCallback: AdvertiseCallback? = null
  private var gattServer: BluetoothGattServer? = null
  private var connectedDevice: BluetoothDevice? = null
  private var txAckNotificationsEnabled = false

  private val mainHandler = Handler(Looper.getMainLooper())
  private var pendingServiceAddPromise: Promise? = null
  private var pendingNotifyPromise: Promise? = null

  private fun rejectPending(reason: String) {
    pendingServiceAddPromise?.reject("GATT_STOPPED", reason, null)
    pendingServiceAddPromise = null
    pendingNotifyPromise?.reject("GATT_STOPPED", reason, null)
    pendingNotifyPromise = null
  }

  private fun stopAdvertisingQuietly() {
    val cb = advertiseCallback ?: return
    advertiseCallback = null
    try { advertiser?.stopAdvertising(cb) }
    catch (_: SecurityException) {} catch (t: Throwable) { Log.w("BlePeripheralModule", "stopAdvertising failed", t) }
  }

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
      .setTimeout(0)
      .build()

    // Primary advertisement data (Service UUID only to stay under 31 bytes)
    val advertiseData = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .addServiceUuid(ParcelUuid(SERVICE_UUID))
      .build()

    // Scan response data (Provides device name on scan request)
    val scanResponseData = AdvertiseData.Builder()
      .setIncludeDeviceName(true)
      .build()

    stopAdvertisingQuietly()

    var resolved = false
    val callback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
        if (!resolved) {
          resolved = true
          promise.resolve(null)
        }
      }

      override fun onStartFailure(errorCode: Int) {
        if (advertiseCallback === this) advertiseCallback = null
        sendEvent("onAdvertisingFailed", mapOf("errorCode" to errorCode))
        if (!resolved) {
          resolved = true
          promise.reject("ADVERTISE_FAILED", "startAdvertising failed with error code $errorCode", null)
        }
      }
    }

    try {
      advertiseCallback = callback
      // Use 4-parameter startAdvertising to ensure cross-chipset compatibility
      leAdvertiser.startAdvertising(settings, advertiseData, scanResponseData, callback)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_DENIED", e.message ?: "SecurityException while starting advertising", e)
    }
  }

  private fun stopAdvertisingInternal(promise: Promise) {
    try {
      stopAdvertisingQuietly()
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
      gattServer?.close()
      gattServer = null
      connectedDevice = null
      txAckNotificationsEnabled = false
      rejectPending("GATT server restarted")

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

      pendingServiceAddPromise = promise
      if (!server.addService(service)) {
        pendingServiceAddPromise = null
        promise.reject("GATT_SERVICE_FAILED", "Failed to queue the Offline Naira GATT service for registration.", null)
        return
      }

      mainHandler.postDelayed({
        if (pendingServiceAddPromise === promise) {
          pendingServiceAddPromise = null
          promise.reject("GATT_SERVICE_TIMEOUT", "onServiceAdded never fired within 5s.", null)
        }
      }, 5000)
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
      rejectPending("GATT server stopped")
      promise.resolve(null)
    } catch (e: SecurityException) {
      promise.reject("PERMISSION_DENIED", e.message ?: "SecurityException while stopping the GATT server", e)
    }
  }

  private fun teardown() {
    try {
      stopAdvertisingQuietly()
      connectedDevice?.let { gattServer?.cancelConnection(it) }
      gattServer?.close()
    } catch (_: SecurityException) {
    }
    advertiser = null
    gattServer = null
    connectedDevice = null
    rejectPending("Module destroyed")
  }

  // ---------- sending a notification ----------

  @Suppress("DEPRECATION")
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

    if (pendingNotifyPromise != null) {
      promise.reject("BUSY", "A previous notification is still being sent; await it first.", null)
      return
    }

    try {
      characteristic.value = chunkJson.toByteArray(Charsets.UTF_8)
      pendingNotifyPromise = promise
      val notified = server.notifyCharacteristicChanged(device, characteristic, false)
      if (!notified) {
        pendingNotifyPromise = null
        promise.reject("NOTIFY_FAILED", "notifyCharacteristicChanged returned false.", null)
        return
      }

      mainHandler.postDelayed({
        if (pendingNotifyPromise === promise) {
          pendingNotifyPromise = null
          promise.reject("NOTIFY_TIMEOUT", "onNotificationSent never fired within 3s.", null)
        }
      }, 3000)
    } catch (e: SecurityException) {
      pendingNotifyPromise = null
      promise.reject("PERMISSION_DENIED", e.message ?: "SecurityException while notifying TX_ACK", e)
    }
  }

  // ---------- GATT server callback ----------

  private val gattServerCallback = object : BluetoothGattServerCallback() {

    override fun onServiceAdded(status: Int, service: BluetoothGattService) {
      if (service.uuid != SERVICE_UUID) return
      val p = pendingServiceAddPromise ?: return
      pendingServiceAddPromise = null
      if (status == BluetoothGatt.GATT_SUCCESS) {
        p.resolve(null)
      } else {
        p.reject("GATT_SERVICE_FAILED", "onServiceAdded reported GATT status $status", null)
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      val p = pendingNotifyPromise ?: return
      pendingNotifyPromise = null
      if (status == BluetoothGatt.GATT_SUCCESS) {
        p.resolve(null)
      } else {
        p.reject("NOTIFY_FAILED", "onNotificationSent reported GATT status $status", null)
      }
    }

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      when (newState) {
        BluetoothProfile.STATE_CONNECTED -> {
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
        }
      }
    }
  }

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
    } catch (_: Exception) {
    }
  }
}