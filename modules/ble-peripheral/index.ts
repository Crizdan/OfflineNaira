import { requireNativeModule, EventEmitter } from 'expo-modules-core';

// Define the events emitted by the native module
type BlePeripheralEvents = {
  onChange: (event: any) => void;
};

// Load the native Kotlin module
const BlePeripheralModule = requireNativeModule('BlePeripheral');

// Pass the event map to EventEmitter
const emitter = new EventEmitter<BlePeripheralEvents>(BlePeripheralModule);

export function addChangeListener(listener: (event: any) => void) {
  return emitter.addListener('onChange', listener);
}

export async function setValueAsync(value: string): Promise<void> {
  return await BlePeripheralModule.setValueAsync(value);
}

export function hello(): string {
  return BlePeripheralModule.hello();
}

export default BlePeripheralModule;