const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('@babel/parser');

const root = path.dirname(require.resolve('tamagui/package.json'));
const manifest = require('tamagui/package.json');
const entry = manifest.exports['.'].import;
const source = fs.readFileSync(path.join(root, entry), 'utf8');
const imports = new Map();
function exportsOf(file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  return parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module' }).program.body.flatMap(node => {
    if (node.type === 'ExportNamedDeclaration') return node.specifiers.map(specifier => specifier.exported.name);
    if (node.type === 'ExportAllDeclaration' && node.source.value.startsWith('.')) {
      return exportsOf(path.resolve(path.dirname(file), node.source.value), seen);
    }
    return [];
  });
}

for (const node of parse(source, { sourceType: 'module' }).program.body) {
  if (node.type === 'ImportDeclaration') {
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportSpecifier') imports.set(specifier.local.name, node.source.value);
    }
  }
  if (node.type === 'ExportAllDeclaration' && node.source.value.startsWith('.')) {
    for (const exported of exportsOf(path.resolve(root, path.dirname(entry), node.source.value))) {
      if (!imports.has(exported)) imports.set(exported, node.source.value);
    }
  }
  if (node.type === 'ExportAllDeclaration' && node.source.value.startsWith('@tamagui/')) {
    const name = node.source.value;
    const dependency = JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), 'utf8'));
    const dependencyRoot = path.dirname(require.resolve(`${name}/package.json`));
    const file = dependency.exports?.['.']?.import ?? dependency.module;
    if (typeof file === 'string') {
      for (const exported of exportsOf(path.join(dependencyRoot, file))) {
        if (!imports.has(exported)) imports.set(exported, name);
      }
    }
  }
}

module.exports = function directTamaguiImports(api) {
  const t = api.types;
  const native = api.caller(caller => caller?.platform !== undefined && caller.platform !== 'web');
  const target = source => {
    if (!source.startsWith('.')) return source;
    const relative = path.posix.join(path.posix.dirname(entry), source);
    const publicPath = Object.entries(manifest.exports).find(([, value]) => value.import === `./${relative}`)?.[0];
    if (publicPath) return `tamagui/${publicPath.slice(2)}`;
    return path.join(root, native ? relative.replace(/\.mjs$/, '.native.js') : relative);
  };
  const setup = target('./setup.mjs');
  return { visitor: { ImportDeclaration(importPath) {
    const node = importPath.node;
    if (node.source.value !== 'tamagui' || node.importKind === 'type' || !node.specifiers.length) return;
    const direct = [];
    node.specifiers = node.specifiers.filter(specifier => {
      if (!t.isImportSpecifier(specifier) || specifier.importKind === 'type') return true;
      const source = imports.get(specifier.imported.name);
      if (!source) return true;
      direct.push(t.importDeclaration([specifier], t.stringLiteral(target(source))));
      return false;
    });
    if (!direct.length) return;
    // Preserve the barrel's setup while loading only its requested components.
    direct.unshift(t.importDeclaration([], t.stringLiteral(setup)));
    if (node.specifiers.length) importPath.insertAfter(direct);
    else importPath.replaceWithMultiple(direct);
  } } };
};
