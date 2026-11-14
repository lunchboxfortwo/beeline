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

module.exports = function directLibraryImports(api) {
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
  return { visitor: { Program: { exit(programPath) {
    // JSX and type transforms have finished; references are ordinary values.
    programPath.scope.crawl();
    programPath.traverse({ ImportDeclaration(importPath) {
    const node = importPath.node;
    const tamagui = node.source.value === 'tamagui';
    const lazy = ['livekit-client', 'posthog-react-native'].includes(node.source.value);
    if ((!tamagui && !lazy) || node.importKind === 'type' || !node.specifiers.length) return;
    let changed = false;
    const direct = [];
    node.specifiers = node.specifiers.filter(specifier => {
      if (specifier.importKind === 'type' || t.isImportNamespaceSpecifier(specifier)) return true;
      if (tamagui && !t.isImportSpecifier(specifier)) return true;
      const imported = t.isImportDefaultSpecifier(specifier) ? t.identifier('default') : specifier.imported;
      const source = tamagui ? imports.get(imported.name) : node.source.value;
      if (!source) return true;
      if (tamagui) {
        // Keep requested components ready for the first interaction. Only the
        // unused barrel modules disappear; their setup is still preserved.
        direct.push(t.importDeclaration([specifier], t.stringLiteral(target(source))));
        changed = true;
        return false;
      }
      const binding = importPath.scope.getBinding(specifier.local.name);
      // A re-export still needs a local binding. Preserve its eager semantics.
      if (!binding || binding.referencePaths.some(reference => !reference.isIdentifier() || reference.parentPath.isExportSpecifier())) return true;
      for (const reference of binding.referencePaths) {
        reference.scope.rename('require');
        const value = t.memberExpression(t.callExpression(t.identifier('require'),
          [t.stringLiteral(target(source))]), t.cloneNode(imported), t.isStringLiteral(imported));
        reference.replaceWith(reference.parentPath.isCallExpression({ callee: reference.node })
          ? t.sequenceExpression([t.numericLiteral(0), value]) : value);
      }
      changed = true;
      return false;
    });
    if (!changed) return;
    // Preserve the barrel's setup while loading only its requested components.
    if (tamagui) direct.unshift(t.importDeclaration([], t.stringLiteral(setup)));
    if (node.specifiers.length) importPath.insertAfter(direct);
    else importPath.replaceWithMultiple(direct);
    } });
  } } } };
};
