const fs = require('node:fs');
const path = require('node:path');

// Metro follows every re-export in the icon barrel. Use the package's own
// alias map to load only the named icons, through its public icon subpaths.
const root = path.resolve(path.dirname(require.resolve('lucide-react-native')), '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const exportsText = fs.readFileSync(path.join(root, manifest.module), 'utf8');
const icons = new Map();
for (const [, names, icon] of exportsText.matchAll(/export\s*\{([^}]+)\}\s*from\s*['"]\.\/icons\/([^'"]+)\.mjs['"]/g)) {
  for (const [, name] of names.matchAll(/default\s+as\s+(\w+)/g)) icons.set(name, icon);
}

module.exports = function directLucideImports({ types: t }) {
  return {
    visitor: {
      ImportDeclaration(importPath) {
        const node = importPath.node;
        if (node.source.value !== 'lucide-react-native' || node.importKind === 'type' || !node.specifiers.length) return;
        const direct = [];
        node.specifiers = node.specifiers.filter(specifier => {
          if (!t.isImportSpecifier(specifier) || specifier.importKind === 'type') return true;
          const icon = icons.get(specifier.imported.name);
          if (!icon) return true;
          direct.push(t.importDeclaration([t.importDefaultSpecifier(specifier.local)],
            t.stringLiteral(`lucide-react-native/icons/${icon}`)));
          return false;
        });
        if (node.specifiers.length) importPath.insertAfter(direct);
        else importPath.replaceWithMultiple(direct);
      },
    },
  };
};
