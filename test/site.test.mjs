// Checks the built site in dist/ (run `npm run build` first).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { site } from '../src/site.mjs';

const DIST = new URL('../dist/', import.meta.url).pathname;
const read = (f) => readFileSync(join(DIST, f), 'utf8');
const htmlFiles = readdirSync(DIST).filter((f) => f.endsWith('.html'));

const attr = (html, re) => html.match(re)?.[1];
const meta = (html, key) => attr(html, new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`));
const pngSize = (file) => {
  const buf = readFileSync(join(DIST, file));
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${file} is not a PNG`);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
};

// Maps a site path to the file Workers static assets would serve for it.
const resolve = (path) => {
  const p = path.split(/[?#]/)[0];
  if (p === '/') return 'index.html';
  for (const candidate of [p.slice(1), `${p.slice(1)}.html`, `${p.slice(1)}/index.html`]) {
    if (candidate && existsSync(join(DIST, candidate))) return candidate;
  }
  return null;
};

describe('home page', () => {
  const html = read('index.html');
  const url = new URL('/', site.origin).href;

  test('has lang, title and a search-friendly description', () => {
    assert.match(html, new RegExp(`<html lang="${site.lang}">`));
    assert.equal(attr(html, /<title>([^<]+)<\/title>/), site.title);
    const description = meta(html, 'description');
    assert.ok(description.length >= 50 && description.length <= 160, `description is ${description.length} chars`);
  });

  test('canonical and og:url point at itself', () => {
    assert.equal(attr(html, /<link rel="canonical" href="([^"]+)">/), url);
    assert.equal(meta(html, 'og:url'), url);
  });

  test('social preview image exists at 1200x630 with alt text', () => {
    const image = new URL(meta(html, 'og:image'));
    assert.equal(image.origin, site.origin);
    assert.deepEqual(pngSize(image.pathname.slice(1)), [1200, 630]);
    assert.equal(meta(html, 'og:image:width'), '1200');
    assert.equal(meta(html, 'og:image:height'), '630');
    assert.ok(meta(html, 'og:image:alt'));
    assert.equal(meta(html, 'twitter:card'), 'summary_large_image');
  });

  test('structured data is valid JSON describing the person', () => {
    const data = JSON.parse(attr(html, /<script type="application\/ld\+json">(.+?)<\/script>/));
    assert.equal(data['@type'], 'ProfilePage');
    assert.equal(data.url, url);
    assert.equal(data.mainEntity.name, site.name);
  });

  test('has exactly one h1', () => {
    assert.equal(html.match(/<h1>/g).length, 1);
  });
});

describe('every HTML file', () => {
  const headers = read('_headers');
  const styleSrc = attr(headers, /style-src ([^;]+);/);

  for (const file of htmlFiles) {
    const html = read(file);

    test(`${file}: inline style matches the CSP hash`, () => {
      const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
      assert.equal(styles.length, 1);
      assert.equal(`'sha256-${createHash('sha256').update(styles[0]).digest('base64')}'`, styleSrc);
      assert.doesNotMatch(html, /\sstyle="/, 'inline style attributes would be blocked by the CSP');
      assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")/, 'executable scripts would be blocked by the CSP');
    });

    test(`${file}: internal links and assets resolve`, () => {
      const refs = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
      assert.ok(refs.length > 0);
      for (const ref of refs) assert.ok(resolve(ref), `broken internal reference ${ref}`);
    });

    test(`${file}: fits in the first TCP round trip (< 14 KB gzipped)`, () => {
      assert.ok(gzipSync(html).length < 14 * 1024);
    });
  }
});

describe('site files', () => {
  test('old /en and /pt URLs redirect permanently to /', () => {
    const rules = read('_redirects');
    for (const from of ['/en', '/en/', '/pt', '/pt/']) {
      assert.match(rules, new RegExp(`^${from}\\s+/\\s+301$`, 'm'), from);
    }
  });

  test('sitemap lists the home page', () => {
    const xml = read('sitemap.xml');
    assert.ok(xml.includes(`<loc>${new URL('/', site.origin).href}</loc>`));
    assert.match(xml, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  });

  test('robots.txt points at the sitemap', () => {
    assert.match(read('robots.txt'), new RegExp(`Sitemap: ${site.origin}/sitemap.xml`));
  });

  test('security.txt has a contact and a valid Expires within a year (RFC 9116)', () => {
    const txt = read('.well-known/security.txt');
    assert.match(txt, /^Contact: mailto:/m);
    const expires = new Date(attr(txt, /^Expires: (.+)$/m));
    const days = (expires - Date.now()) / 86_400_000;
    assert.ok(days > 30 && days < 366, `expires in ${Math.round(days)} days`);
  });

  test('web manifest icons exist at their declared sizes', () => {
    const manifest = JSON.parse(read('manifest.webmanifest'));
    for (const icon of manifest.icons) {
      const [w, h] = icon.sizes.split('x').map(Number);
      assert.deepEqual(pngSize(icon.src.slice(1)), [w, h], icon.src);
    }
    assert.deepEqual(pngSize('apple-touch-icon.png'), [180, 180]);
  });

  test('favicon.ico is a valid icon', () => {
    const ico = readFileSync(join(DIST, 'favicon.ico'));
    assert.equal(ico.readUInt16LE(2), 1);
    assert.ok(ico.readUInt16LE(4) >= 1);
  });

  test('404 page is not indexable', () => {
    assert.match(read('404.html'), /<meta name="robots" content="noindex">/);
  });
});
