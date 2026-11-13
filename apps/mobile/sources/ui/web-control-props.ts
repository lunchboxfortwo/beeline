import { hooks, setupHooks } from '@tamagui/web';

/**
 * React Native roles that are not the web role of the same name.
 * The rest pass through (`button` stays `button`). Roles with no web
 * equivalent are omitted, matching react-native-web.
 */
const WEB_ROLE: Record<string, string | null> = {
  adjustable: 'slider',
  header: 'heading',
  image: 'img',
  imagebutton: null,
  keyboardkey: null,
  label: null,
  none: 'presentation',
  summary: 'region',
  text: null,
};

function mapWebControlProps(props: Record<string, unknown>): Record<string, unknown> {
  if (!('accessibilityRole' in props) && !('accessibilityLabel' in props)) return props;
  const { accessibilityRole, accessibilityLabel, ...rest } = props;
  if (rest.role == null && typeof accessibilityRole === 'string') {
    const mapped = Object.prototype.hasOwnProperty.call(WEB_ROLE, accessibilityRole)
      ? WEB_ROLE[accessibilityRole]
      : accessibilityRole;
    if (mapped) rest.role = mapped;
  }
  if (rest['aria-label'] == null && typeof accessibilityLabel === 'string') {
    rest['aria-label'] = accessibilityLabel;
  }
  return rest;
}

/**
 * Tamagui's web host still drops `accessibilityRole` and `accessibilityLabel`.
 * This transform writes `role` and `aria-label`. Every shared pressable already
 * sets the React Native names; this copies them onto the DOM element.
 *
 * Call after Tamagui installs its own prop transform. On phones that transform
 * returns nothing, so the React Native props stay on the native host.
 */
export function installWebControlProps(): void {
  const previous = hooks.usePropsTransform;
  setupHooks({
    usePropsTransform(elementType, propsIn, stateRef, willHydrate) {
      const transformed = previous?.(elementType, propsIn, stateRef, willHydrate);
      if (transformed == null || typeof elementType !== 'string') return transformed;
      return mapWebControlProps(transformed);
    },
  });
}
