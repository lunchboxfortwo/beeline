import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);

function read(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

function mainWithoutReturnLink(html) {
  const main = html.match(/<main>([\s\S]*)<\/main>/);
  assert.ok(main, 'legal page has a main element');
  return main[1].replace(/\n[ \t]*<p class="back"><a href="\/">Back to Beeline<\/a><\/p>/, '');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Hashes of each page's <main> after the one allowed edit: removing the
// previous-version anchor. Adding Back to Beeline must not change this text.
const legalBody = {
  'apps/site/terms/index.html': 'ae10e9dc3bfdca1d92f5aa4f61cb7009346b6971c692196f891837756c0b0bd2',
  'apps/site/privacy/index.html': '5b26f1765f153f0c0ee384d30eb4ba416d999aae5ed3ca022ac2c0bf84fb8b4f',
  'apps/site/privacy/2026-10-26.html': 'dacd6c90c083dcd077f633e506d9a171b3720f6bcd53c616b179395df4c76440',
  'apps/site/privacy/2026-10-18.html': '47157c1e48d0abfe7a524aa579ebcbd03cc6ce2fd5c55aad03a9e756c9d5ef3e',
  'apps/site/privacy/2026-10-16.html': 'f7a3db0d7fb5cec786eba7963a31855ca8c97ce8905eb49473fe8d245babbee7',
};

const dateLine = {
  'apps/site/terms/index.html': '<p class="updated">Effective: October 16, 2026</p>',
  'apps/site/privacy/index.html': '<p class="updated">Effective: 27 October 2026</p>',
  'apps/site/privacy/2026-10-26.html': '<p class="updated">Effective: 26 October 2026</p>',
  'apps/site/privacy/2026-10-18.html': '<p class="updated">Effective: 18 October 2026</p>',
  'apps/site/privacy/2026-10-16.html': '<p class="updated">Effective: October 16, 2026</p>',
};

test('legal pages keep their text and add one home link', () => {
  for (const [path, hash] of Object.entries(legalBody)) {
    const html = read(path);
    assert.equal(sha256(mainWithoutReturnLink(html)), hash, path);
    assert.equal(html.match(/Back to Beeline/g)?.length, 1, path);
    assert.match(html, /<p class="back"><a href="\/">Back to Beeline<\/a><\/p>/);
    assert.match(html, /<div class="mark">Beeline<\/div>/);
    assert.doesNotMatch(html, /Previous version/);
    assert.ok(html.includes(dateLine[path]), path);
    assert.match(html, /rel="icon" href="\/favicon.ico"/);
    assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
    assert.match(html, /property="og:image" content="https:\/\/usebeeline\.app\/apple-touch-icon\.png"/);
    assert.match(html, /name="twitter:card" content="summary"/);
    assert.doesNotMatch(html, /summary_large_image/);
    assert.match(html, /\.back a:focus/);
    assert.doesNotMatch(html, /apps\/mobile/);
  }
  const terms = read('apps/site/terms/index.html');
  assert.match(terms, /href="\/privacy\/"/);
  assert.match(terms, /href="\/privacy\/#service-review"/);
  const current = read('apps/site/privacy/index.html');
  assert.match(current, /href="\/subprocessors\/"/);
  assert.doesNotMatch(current, /href="\/privacy\/2026-10-26\.html"/);
});

test('homepage publishes the icon and keeps its yellow card', () => {
  const home = read('apps/site/index.html');
  assert.match(home, /rel="icon" href="\/favicon.ico"/);
  assert.match(home, /href="\/icon-512.png"/);
  assert.match(home, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
  assert.match(home, /property="og:image" content="https:\/\/usebeeline\.app\/og-4-bold-color-v2\.png"/);
  assert.match(home, /name="twitter:image" content="https:\/\/usebeeline\.app\/og-4-bold-color-v2\.png"/);
  assert.match(home, /name="twitter:card" content="summary_large_image"/);
  assert.doesNotMatch(home, /property="og:image" content="https:\/\/usebeeline\.app\/apple-touch-icon\.png"/);
  assert.equal(home.match(/og-4-bold-color-v2\.png/g)?.length, 2);
});

test('icon files are real images copied into the pages site', () => {
  const ico = readFileSync(new URL('apps/site/favicon.ico', root));
  const touch = readFileSync(new URL('apps/site/apple-touch-icon.png', root));
  const icon = readFileSync(new URL('apps/site/icon-512.png', root));
  assert.equal(ico.subarray(0, 4).toString('ascii'), '\x00\x00\x01\x00');
  assert.equal(touch.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const builder = read('packages/scripts/pages-site.mjs');
  for (const file of ['favicon.ico', 'apple-touch-icon.png', 'icon-512.png']) {
    assert.match(builder, new RegExp(`'${file.replace('.', '\\.')}'`));
  }
});
