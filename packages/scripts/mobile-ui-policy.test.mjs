import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  grandfatherRegistry,
  isInventoriedUiFile,
  judgeUiRegistry,
  scanUiSource,
} from './mobile-ui-policy.mjs';

it('inventories component files and symbols across both components/ and ui/', () => {
  assert.equal(isInventoriedUiFile('components/buzz/Button.tsx'), true);
  assert.equal(isInventoriedUiFile('ui/grammar-overlay.tsx'), true);
  assert.equal(isInventoriedUiFile('ui/screens/tags/WorkItemDetail.tsx'), true);
  assert.equal(isInventoriedUiFile('app/(app)/beeline/settings/workflows.tsx'), false);

  const componentScan = scanUiSource(
    'export function SharedBanner() { return <div />; }\n',
    'components/buzz/SharedBanner.tsx',
  );
  const uiScan = scanUiSource(
    'export function OverlaySheet() { return <div />; }\nexport function SheetHelper() { return <span />; }\n',
    'ui/grammar-overlay.tsx',
  );
  const screenScan = scanUiSource(
    'export function CustomScreenCard() { return <div />; }\n',
    'ui/screens/settings/CustomScreenCard.tsx',
  );

  const registry = grandfatherRegistry([componentScan, uiScan]);
  assert.deepEqual(registry.components['components/buzz/SharedBanner.tsx'], ['SharedBanner']);
  assert.deepEqual(registry.components['ui/grammar-overlay.tsx'], ['OverlaySheet', 'SheetHelper']);
  assert.deepEqual(judgeUiRegistry([componentScan, uiScan], registry), []);

  // Unregistered file under ui/screens/ is rejected.
  const missingFileErrors = judgeUiRegistry([componentScan, uiScan, screenScan], registry);
  assert.ok(
    missingFileErrors.some(
      (error) =>
        error.file === 'ui/screens/settings/CustomScreenCard.tsx' &&
        error.rule === 'component-file',
    ),
  );
  assert.ok(
    missingFileErrors.some(
      (error) =>
        error.file === 'ui/screens/settings/CustomScreenCard.tsx' &&
        error.rule === 'component-symbol' &&
        error.message.includes('CustomScreenCard'),
    ),
  );

  // Unregistered new symbol in an existing ui/ file is rejected.
  const expandedUiScan = scanUiSource(
    'export function OverlaySheet() { return <div />; }\nexport function SheetHelper() { return <span />; }\nexport function UnregisteredDrawer() { return <div />; }\n',
    'ui/grammar-overlay.tsx',
  );
  const missingSymbolErrors = judgeUiRegistry([componentScan, expandedUiScan], registry);
  assert.ok(
    missingSymbolErrors.some(
      (error) =>
        error.file === 'ui/grammar-overlay.tsx' &&
        error.rule === 'component-symbol' &&
        error.message.includes('UnregisteredDrawer'),
    ),
  );
});
