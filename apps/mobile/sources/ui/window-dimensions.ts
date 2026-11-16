// The one place the app reads react-native's window size. Tests replace this module
// (packages/test-helpers/helpers/phone.ts) because Vitest cannot parse react-native's Flow source.
export { useWindowDimensions } from 'react-native';
