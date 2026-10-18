import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const output = fileURLToPath(new URL('../docs/.vitepress/dist/', import.meta.url));
const origin = 'https://mirkomignini.github.io';
const base = '/pico/';
const pages = new Map();

for (const file of readdirSync(output, { recursive: true })) {
  if (!file.endsWith('.html')) continue;
  const dom = new JSDOM(readFileSync(join(output, file), 'utf8'));
  const document = dom.window.document;
  assert.equal(document.documentElement.lang, 'en-US', `${file}: missing language`);
  assert.ok(document.title.includes('Pico'), `${file}: missing page title`);
  for (const image of document.querySelectorAll('img')) {
    assert.ok(image.hasAttribute('alt'), `${file}: image missing alt text`);
  }
  pages.set(file, {
    ids: new Set([...document.querySelectorAll('[id]')].map((element) => element.id)),
    references: [...document.querySelectorAll('a[href], img[src], script[src], link[rel="stylesheet"], link[rel="icon"]')]
      .map((element) => element.getAttribute('href') ?? element.getAttribute('src')),
  });
  dom.window.close();
}

for (const required of ['index.html', 'INSTALLATION.html', 'SETUP.html', 'SECURITY.html', '404.html']) {
  assert.ok(pages.has(required), `Missing essential page: ${required}`);
}
assert.ok(!pages.has('ATTACHMENTS-RESEARCH.html'), 'Research proposals are not product documentation');
assert.ok(!pages.has('COMPARISON.html'), 'Internal comparisons do not belong in the getting-started site');

let checked = 0;
for (const [file, page] of pages) {
  const pageUrl = new URL(base + file.replace(/index\.html$/, '').replace(/\.html$/, ''), origin);
  for (const reference of page.references) {
    const url = new URL(reference, pageUrl);
    if (url.origin !== origin) continue;
    assert.ok(url.pathname.startsWith(base), `${file}: link escapes Pages base: ${reference}`);
    let target = decodeURIComponent(url.pathname.slice(base.length));
    if (target.endsWith('/') || target === '') target += 'index.html';
    else if (!extname(target)) target += '.html';
    const path = resolve(output, target);
    assert.ok(path.startsWith(output), `${file}: link escapes output: ${reference}`);
    assert.ok(existsSync(path), `${file}: missing local target: ${reference}`);
    if (url.hash && pages.has(target)) {
      assert.ok(pages.get(target).ids.has(decodeURIComponent(url.hash.slice(1))), `${file}: missing anchor: ${reference}`);
    }
    checked++;
  }
}

const setup = readFileSync(join(output, 'CHANNELS.html'), 'utf8');
assert.ok(setup.includes('https://github.com/MirkoMignini/pico/blob/main/src/contracts.ts'), 'Source links must point to GitHub');
console.log(`Documentation: checked ${pages.size} pages and ${checked} local links, anchors and assets.`);
