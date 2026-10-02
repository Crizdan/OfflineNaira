import { BleService } from './BleService';

/**
 * The single BleService for the whole app. send.tsx and receive.tsx used to
 * each call `new BleService()`, which created two BleManager instances in one
 * process (react-native-ble-plx expects exactly one) even though receive.tsx's
 * comment claimed it was sharing Send's instance.
 */
export const ble = new BleService();
