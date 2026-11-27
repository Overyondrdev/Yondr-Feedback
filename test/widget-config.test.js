// The widget's config parsing (data-* attributes and its own script URL) is a pure function between markers in
// public/widget.js; this test lifts it out and runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/widget.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('/* yfb-config:start'), src.indexOf('/* yfb-config:end */'));
const readConfig = new Function(body + '; return readConfig;')();
const cfg = (attrs, host = 'ads.overyondrdev.com', script = 'https://feedback.overyondrdev.com/widget.js') =>
  readConfig((n) => (n in attrs ? attrs[n] : null), host, script);

test('API and asset base come from the script’s own URL', () => {
  assert.equal(cfg({}).api, 'https://feedback.overyondrdev.com/api/');
  assert.equal(cfg({}, 'x', 'http://localhost:8787/widget.js?v=2').base, 'http://localhost:8787');
  assert.equal(cfg({}, 'x', '').base, 'https://feedback.overyondrdev.com');
  assert.equal(cfg({}, 'x', 'not a url').base, 'https://feedback.overyondrdev.com');
});

test('project: data-project, else the host’s first label (portal for the apex/www)', () => {
  assert.equal(cfg({ 'data-project': 'V1' }).project, 'v1');
  assert.equal(cfg({}).project, 'ads');
  assert.equal(cfg({}, 'requests.overyondrdev.com').project, 'requests');
  assert.equal(cfg({}, 'overyondrdev.com').project, 'portal');
  assert.equal(cfg({}, 'www.overyondrdev.com').project, 'portal');
  assert.equal(cfg({ 'data-project': 'bad name!' }, 'cards.overyondrdev.com').project, 'cards');
});

test('toolbar is off unless data-toolbar="website"; position defaults to right', () => {
  assert.equal(cfg({}).toolbar, null);
  assert.equal(cfg({ 'data-toolbar': 'website' }).toolbar, 'website');
  assert.equal(cfg({ 'data-toolbar': 'yes' }).toolbar, null);
  assert.equal(cfg({}).position, 'right');
  assert.equal(cfg({ 'data-position': 'left' }).position, 'left');
  assert.equal(cfg({ 'data-position': 'none' }).position, 'none');
  assert.equal(cfg({ 'data-position': 'top' }).position, 'right');
});

test('default asset from data-asset / data-asset-label', () => {
  assert.equal(cfg({}).asset, null);
  assert.deepEqual(cfg({ 'data-asset': ' ad-42 ', 'data-asset-label': 'Spring LinkedIn ad' }).asset, { id: 'ad-42', label: 'Spring LinkedIn ad' });
  assert.deepEqual(cfg({ 'data-asset': 'ad-42' }).asset, { id: 'ad-42', label: null });
  assert.equal(cfg({ 'data-asset-label': 'no id' }).asset, null);
});
