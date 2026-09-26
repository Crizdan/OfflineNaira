# Migrating Offline Naira into your Expo project

## First, an important correction to the original ask

You asked for "the refactored code for App.tsx." Your project's `AGENTS.md`
says: *"Use Expo Router for all navigation. Routes live in `src/app/` —
every file there is a screen."* That's not optional guidance to route
around — on Expo SDK 56+, **Expo Router no longer allows importing
`@react-navigation/*` packages directly in application code**, which is
what the original prototype's navigation was built on. So the honest
answer is: **`App.tsx` goes away.** Expo Router replaces it with
`index.ts` (the entry point) + `src/app/_layout.tsx` (the root layout,
doing what `App.tsx`/`NavigationContainer` used to do) + one file per
screen under `src/app/`.

**Action: delete `App.tsx` from your project root.** Everything it would
have done now lives in the files below.

## What changed from the original code, and why

| Original (bare RN prototype) | This migration | Why |
|---|---|---|
| `App.tsx` + React Navigation stack | `index.ts` + `src/app/_layout.tsx` + `src/app/*.tsx` | Expo Router is mandatory per your AGENTS.md; also required since SDK 56 blocks direct `@react-navigation/*` imports |
| `react-native-sqlite-storage` | `expo-sqlite` (async API: `openDatabaseAsync`, `runAsync`, `getFirstAsync`, `getAllAsync`, `withExclusiveTransactionAsync`) | Included in Expo Go / first-party, no extra native linking headaches |
| `react-native-keychain` | `expo-secure-store` | Same Keystore/Keychain-backed guarantee, first-party Expo module |
| Raw `ReactContextBaseJavaModule` Kotlin for BLE peripheral | Expo Modules API (`Module()` / `ModuleDefinition` DSL) via a **local Expo module** | Your project uses Continuous Native Generation — you must never hand-edit `android/`; native code has to be added as a module the CNG/autolinking system picks up |
| build-step schema embedding (`schema.sql` → `schema.sql.json`) | `src/db/schema.ts` (plain TS string) | Metro bundles `.ts` natively; `expo-sqlite`'s `execAsync()` runs a whole multi-statement string directly, so the extra build step from the bare-RN version isn't needed here |

Everything else — money math, Ed25519 signing/verification, the
transaction state machine, the wallet reservation logic, the BLE wire
protocol, the FastAPI backend — is unchanged in substance. Only the glue
to Expo's APIs changed.

## 1. Install dependencies

Run these from your project root — **use `npx expo install`, not `npm
install`**, so versions get resolved against your SDK 57 lockfile (per
your AGENTS.md):

```bash
npx expo install expo-router expo-linking expo-constants
npx expo install expo-sqlite expo-secure-store
npx expo install react-native-screens react-native-safe-area-context
npx expo install react-native-get-random-values
npx expo install tweetnacl tweetnacl-util
npx expo install react-native-ble-plx
```

Test tooling (dev-only, not SDK-versioned, plain npm is fine here):

```bash
npm install --save-dev jest-expo jest @types/jest
```

Then sanity-check everything resolved to compatible versions:

```bash
npx expo install --fix
npx expo-doctor
```

## 2. Files to replace at your project root

Copy these from this zip into your project root, overwriting what's there:

- `package.json` — adds the dependencies above and points `main` at
  `expo-router/entry`. **Run `npx expo install --fix` after copying it in**
  — the version numbers I wrote are placeholders; that command corrects
  them to what SDK 57 actually needs.
- `app.json` — adds the `expo-router`, `expo-sqlite`, `expo-secure-store`,
  and `react-native-ble-plx` config plugins, a `scheme` (required by Expo
  Router for deep linking), Android Bluetooth permissions, and switches
  `userInterfaceStyle` to `"dark"` to match the app's theme (revert that
  one line if you'd rather keep it system-driven).
- `index.ts` — new custom entry point. Loads the crypto polyfill, then
  hands off to `expo-router/entry`.
- `jest.config.js` — new, uses the `jest-expo` preset.
- **Delete `App.tsx`** — see above.
- `tsconfig.json` — no changes needed, leave yours as-is.

## 3. Folders to create

Create these under your project root exactly as laid out in this zip:

- **`src/app/`** — one file per screen (`index.tsx`, `wallet.tsx`,
  `send.tsx`, `receive.tsx`, `history.tsx`, `settings.tsx`, `sync.tsx`)
  plus `_layout.tsx`. Expo Router turns each file into a route
  automatically — don't rename them casually, the filename is the URL.
- **`src/theme/`**, **`src/components/`** — shared UI theme and building
  blocks (buttons, cards, status pills).
- **`src/domain/`** — integer-kobo money math, no floats anywhere near a
  balance.
- **`src/crypto/`** — Ed25519 device identity via `expo-secure-store` +
  `tweetnacl`.
- **`src/protocol/`** — signed transaction format, the transaction state
  machine, and the BLE wire/chunking protocol.
- **`src/db/`** — the SQLite schema and repositories (`expo-sqlite`).
- **`src/services/`** — `WalletService` (the only code path allowed to
  touch a balance), `PaymentEngine` (orchestrates a send/receive through
  the state machine), `SyncService`, and `src/services/ble/BleService.ts`
  (central/client BLE role via `react-native-ble-plx`).
- **`modules/ble-peripheral/`** — see below, this one needs an extra step,
  it isn't just "copy the folder."
- **`__tests__/`** — Jest tests for the money math, signature validation,
  and state machine (unaffected by the Expo migration, since none of that
  logic touched React Native APIs directly).

## 4. The one piece that needs more than copying files: BLE peripheral role

`react-native-ble-plx` can only make your phone act as a BLE **central**
(scan/connect to someone else). For your phone to be **discoverable** —
advertising + running a GATT server — you need native code, and in an
Expo/CNG project that has to be a proper **local Expo module**, not a
file dropped into `android/`.

```bash
npx create-expo-module@latest --local
# module name: ble-peripheral
# native module name: BlePeripheral
# platforms: Android
```

That generates the real scaffold. Then follow
`modules/ble-peripheral/README.md` in this zip to drop in the Kotlin
skeleton I wrote (`BlePeripheralModule.kt`) and finish the `TODO`s.

**This is genuinely unfinished** — every method in that skeleton rejects
with `NOT_IMPLEMENTED`. I can't compile or test Kotlin/Android from here.
The `Receive` screen already reflects this honestly (it shows "Not
advertising yet" rather than faking a connection).

## 5. Things that will NOT work in Expo Go

`react-native-ble-plx` and the local `ble-peripheral` module both need
custom native code. You need a **development build**:

```bash
npx expo prebuild
npx expo run:android
```

or an EAS development build (`eas build --profile development`) if you're
not building locally. Expo Go will not load this app once
`react-native-ble-plx` is installed.

## 6. Verify

```bash
npx expo install --fix
npx expo-doctor
npx tsc --noEmit
npm test
```

I wrote the Jest tests with real assertions but have not run them in this
environment (no network access here to install dependencies) — run
`npm test` yourself and fix anything that surfaces.

## What's carried over unchanged from the original build

`docs/LIMITATIONS.md` and `docs/THREAT_MODEL.md` from the original zip
still apply as-is — nothing about this Expo migration changes the
double-spend risk model, the reconciliation window trade-off, or the fact
that this is simulated money, not a real bank rail. The FastAPI backend
is also unchanged; nothing here affects it.
