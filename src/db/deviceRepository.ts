import { getDb } from './connection';

export async function ensureDeviceRegistered(deviceId: string, publicKeyB64: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();

  // 1. Insert parent 'users' record (pin_hash is NOT NULL in schema)
  await db.runAsync(
    `INSERT OR IGNORE INTO users (id, pin_hash, created_at) VALUES (?, ?, ?);`,
    [deviceId, 'unassigned', now]
  );

  // 2. Insert parent 'devices' record (public_key_b64 & registered_at are required)
  await db.runAsync(
    `INSERT OR IGNORE INTO devices (device_id, user_id, public_key_b64, registered_at) VALUES (?, ?, ?, ?);`,
    [deviceId, deviceId, publicKeyB64, now]
  );
}