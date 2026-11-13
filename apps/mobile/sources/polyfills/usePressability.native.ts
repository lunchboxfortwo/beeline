// Tamagui reads `require('react-native').usePressability` for every pressable
// on native. React Native 0.83 keeps that hook internal and does not export
// it, so every pressable threw "undefined is not a function" on phones.
// Expose the same internal hook on the real module exports (an `import *`
// namespace would be a copy Tamagui never reads) before the first render.
/* eslint-disable @typescript-eslint/no-require-imports */
type UsePressability = (config: unknown) => unknown;
const internal = require('react-native/Libraries/Pressability/usePressability') as { default: UsePressability };
const exported = require('react-native') as { usePressability?: UsePressability };
if (typeof exported.usePressability !== 'function') {
    Object.defineProperty(exported, 'usePressability', { value: internal.default, configurable: true });
}
