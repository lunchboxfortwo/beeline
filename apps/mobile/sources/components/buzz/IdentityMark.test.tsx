import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const theme = vi.hoisted(() => ({ dark: true }));
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { StyleSheet: { create: (value: unknown) => value }, Platform: { OS: 'android' }, View: host('View'), Image: host('Image') };
});
vi.mock('react-native-svg', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  const names = ['G', 'Path', 'Rect', 'SvgUri', 'Polygon', 'Circle', 'Ellipse', 'Line', 'Polyline'];
  return { default: host('Svg'), Text: host('SvgText'), ...Object.fromEntries(names.map((name) => [name, host(name)])) };
});
vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: { buzz: { dark: theme.dark, brandMark: 'brand', accent: 'accent' } } }),
}));
vi.mock('./MonoHull', () => ({ HullLivePulse: (props: any) => React.createElement('View', props, props.children) }));
import { IdentityMark, isPersonPictureUrl, personInitial } from './IdentityMark';
import { PERSON_PLATE } from '@/buzz/faces/face-tile';
import { INK } from '@/buzz/faces/animals';
import { identityPalette } from '@/buzz/identity-mark';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(element: React.ReactElement) {
  let tree: any;
  await act(async () => { tree = create(element); });
  return tree;
}
const letters = (tree: any) => tree.root.findAll((node: any) => node.type === 'SvgText');

describe('person marks', () => {
  afterEach(() => { theme.dark = true; });

  it('draws the display name initial in the person hue on the dark person plate', async () => {
    const tree = await render(<IdentityMark kind="human" seed="pk-dan" name="dan" handle="lunchbox" face="fox" />);
    const glyphs = letters(tree);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].props.children).toBe('D');
    expect(glyphs[0].props.fill).toBe(identityPalette('pk-dan', 'human').mid);
    const plate = tree.root.findAll((node: any) => node.type === 'Rect')[0];
    expect(plate.props.fill).toBe(PERSON_PLATE.dark);
    expect(tree.root.findAll((node: any) => node.props.testID === 'face-figure')).toHaveLength(0);
  });

  it('falls back to the handle and gives the light letter the Ink edge', async () => {
    theme.dark = false;
    const tree = await render(<IdentityMark kind="human" seed="pk-b" handle="@bananaman614305" />);
    const glyphs = letters(tree);
    expect(glyphs.map((node: any) => node.props.children)).toEqual(['B', 'B']);
    expect(glyphs[0].props.stroke).toBe(INK);
    expect(glyphs[0].props.fill).toBe(INK);
    expect(glyphs[1].props.stroke).toBeUndefined();
    expect(tree.root.findAll((node: any) => node.type === 'Rect')[0].props.fill).toBe(PERSON_PLATE.light);
  });

  it('names the tile once as an image', async () => {
    const tree = await render(<IdentityMark kind="human" seed="pk-k" name="Kai" testID="kai" />);
    const tile = tree.root.find((node: any) => node.props.testID === 'kai' && node.type === 'View');
    expect(tile.props.accessibilityRole).toBe('image');
    expect(tile.props.accessibilityLabel).toBe('Kai, person');
  });

  it('fills the same box with uploaded and stored provider photos', async () => {
    const photo = 'https://beeline.example/v1/person-avatars/11111111-1111-4111-8111-111111111111';
    const uploaded = await render(<IdentityMark kind="human" seed="pk" name="Dan" avatarUrl={photo} />);
    const image = uploaded.root.find((node: any) => node.type === 'Image');
    expect(image.props.source).toEqual({ uri: photo });
    expect(letters(uploaded)).toHaveLength(0);
    const provider = await render(<IdentityMark kind="human" seed="pk" name="Dan" avatarUrl="https://lh3.googleusercontent.com/a/photo" />);
    expect(provider.root.find((node: any) => node.type === 'Image').props.source.uri).toBe('https://lh3.googleusercontent.com/a/photo');
    expect(letters(provider)).toHaveLength(0);
    const github = await render(<IdentityMark kind="human" seed="pk" name="Dan" avatarUrl="https://avatars.githubusercontent.com/u/42" />);
    expect(github.root.find((node: any) => node.type === 'Image').props.source.uri).toBe('https://avatars.githubusercontent.com/u/42');
  });

  it('keeps agents as animals', async () => {
    const tree = await render(<IdentityMark kind="agent" seed="pk-alan" name="Alan" face="fox" />);
    expect(letters(tree)).toHaveLength(0);
    expect(tree.root.findAll((node: any) => node.props.testID === 'face-figure').length).toBeGreaterThan(0);
  });
});

describe('initials', () => {
  it('takes the first letter of the name, else the handle', () => {
    expect(personInitial('maya', 'm')).toBe('M');
    expect(personInitial(' ', '@priya')).toBe('P');
    expect(personInitial(undefined, undefined)).toBe('?');
    expect(isPersonPictureUrl('/v1/person-avatars/11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isPersonPictureUrl('/v1/avatars/11111111-1111-4111-8111-111111111111')).toBe(false);
  });
});
