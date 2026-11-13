// PEOPLE-1 proof resolver: the product Metro config, with expo-router replaced by
// an inert router so TabBar can mount without the app's navigation tree.
const fs = require('fs');
const path = require('path');
const config = require('../../metro.config');
const shim = path.resolve(__dirname, '../../.scratch/people-1/expo-router.js');
fs.mkdirSync(path.dirname(shim), { recursive: true });
fs.writeFileSync(shim, 'export const router = { canDismiss: () => false, dismissAll() {}, replace() {} };\n');
const original = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) =>
  name === 'expo-router' ? { type: 'sourceFile', filePath: shim } : (original ?? context.resolveRequest)(context, name, platform);
module.exports = config;
