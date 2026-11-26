// The one place the grammar's OverlaySheet reads the shared React Native Modal
// host and viewport class. Tests replace this module (packages/test-helpers/helpers/phone.ts)
// because Vitest cannot parse react-native's Flow source.
export { HullFloatingSurface, HullModal } from '@/components/buzz/HullDialog';
export { useIsDesktop } from '@/utils/responsive';
