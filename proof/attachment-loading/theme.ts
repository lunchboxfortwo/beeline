import { beelineThemes } from '../../apps/mobile/sources/buzz/groknight';
export const buzz = beelineThemes[new URLSearchParams(location.search).get('theme') === 'bone' ? 'bone' : 'obsidian'];
export const StyleSheet = { create: (factory: any) => factory({ buzz }) };
