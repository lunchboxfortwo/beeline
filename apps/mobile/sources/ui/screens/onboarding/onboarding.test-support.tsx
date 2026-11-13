import React from 'react';

/**
 * Node renders of the grammar screens: Tamagui, lucide and the rise-in
 * motion become named host elements, so tests read the grammar primitives'
 * props (`testID`, `aria-label`, `onPress`, text children) directly.
 */
const host = (name: string) => (props: any) => React.createElement(name, props, props.children);

export function tamaguiMock() {
  return {
    Button: host('Button'),
    Card: host('Card'),
    Input: host('Input'),
    ListItem: host('ListItem'),
    ScrollView: host('ScrollView'),
    Separator: host('Separator'),
    Sheet: Object.assign(host('Sheet'), {
      Overlay: host('SheetOverlay'), Handle: host('SheetHandle'),
      Container: host('SheetContainer'), Background: host('SheetBackground'),
    }),
    Spinner: host('Spinner'),
    Text: host('Text'),
    Theme: host('Theme'),
    XStack: host('XStack'),
    YStack: host('YStack'),
    useTheme: () => ({}),
    useThemeName: () => 'dark_brass',
  };
}

export function lucideMock() {
  return Object.fromEntries(
    ['ArrowLeft', 'Bot', 'Check', 'ChevronDown', 'ChevronRight', 'Copy', 'Link', 'Lock', 'Mail', 'Sparkles', 'Terminal', 'Users']
      .map((name) => [name, host(name)]),
  );
}

export function riseMock() {
  return { Rise: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children) };
}

/** Every string a host `Text` renders, one entry per text node. */
export function texts(root: any): string[] {
  return root
    .findAll((node: any) => node.type === 'Text')
    .map((node: any) => ([] as unknown[]).concat(node.props.children).filter((part) => typeof part === 'string').join(''));
}
