// Expo Go's RN exposes this hook at its internal path; Tamagui expects the public export.
const Native = require('react-native');
Native.usePressability = require('react-native/Libraries/Pressability/usePressability').default;
require('./App');
