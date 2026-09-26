// Custom entry point: needed only because tweetnacl requires a real
// crypto.getRandomValues, which Hermes/React Native doesn't provide by
// default. This polyfill MUST be imported before anything else touches
// tweetnacl (directly or via src/crypto/identity.ts).
import 'react-native-get-random-values';

// Hands off to Expo Router, which reads src/app/_layout.tsx as the root.
import 'expo-router/entry';
