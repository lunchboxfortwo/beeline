module.exports = function (api) {
  const web = api.caller((caller) => caller?.platform === 'web');

  // Determine which worklets plugin to use based on installed versions
  // Reanimated v4+ uses react-native-worklets/plugin
  // Reanimated v3.x uses react-native-reanimated/plugin
  let workletsPlugin = 'react-native-worklets/plugin';
  try {
    const reanimatedVersion = require('react-native-reanimated/package.json').version;
    const majorVersion = parseInt(reanimatedVersion.split('.')[0], 10);

    // For Reanimated v3.x, use the old plugin
    if (majorVersion < 4) {
      workletsPlugin = 'react-native-reanimated/plugin';
    }
  } catch (e) {
    // If reanimated isn't installed, default to newer plugin
    // This won't cause issues since the plugin won't be needed anyway
  }

  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // The web export compiles object spread with babel-preset-expo's loose
      // transform, which turns `{ ...value, get val() {} }` into Object.assign
      // and drops the getter. Tamagui's useTheme() tracks theme keys through
      // that getter, so `.val` readers missed live Light/Dark switches. The
      // strict transform runs first and keeps getters.
      ...(web ? [require.resolve('@babel/plugin-transform-object-rest-spread')] : []),
      require.resolve('./plugins/direct-lucide-imports.cjs'),
      require.resolve('./plugins/direct-library-imports.cjs'),
      ...(process.env.BEELINE_TRANSCRIPT_MEASURE === '1'
        ? [require.resolve('../../packages/scripts/transcript-speed/commits.cjs')]
        : []),
      workletsPlugin // Must be last - automatically selects correct plugin for version
    ],
  };
};
