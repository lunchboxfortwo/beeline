#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const IOS_DISPLAY_VERSION = /^\d+(\.\d+){0,2}$/;

function assertIosDisplayVersion(candidate) {
  if (typeof candidate !== 'string' || !IOS_DISPLAY_VERSION.test(candidate)) {
    throw new Error(
      `apps/mobile/package.json must use an iOS display version with one to three numeric components: ${candidate}`,
    );
  }
}

function main() {
  const packagePath = path.resolve(__dirname, '../package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const apply = process.argv[2] === '--apply-store-version';
  const version = apply ? process.env.NATIVE_APP_VERSION : pkg.version;
  // Native store versions are resolved independently of public release tags.
  assertIosDisplayVersion(version);
  if (apply) {
    pkg.version = version;
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  }

  console.log(version);
}

if (require.main === module) main();

module.exports = { assertIosDisplayVersion };
