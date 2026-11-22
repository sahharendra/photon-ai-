'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');

describe('Website Performance & PageSpeed Optimization Tests', () => {
  it('1: index.html has zero render-blocking scripts in <head>', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const headEnd = html.indexOf('</head>');
    const head = html.slice(0, headEnd);

    // No synchronous scripts in head
    const hasSyncScriptInHead = /<script\s+src=/i.test(head);
    assert.equal(hasSyncScriptInHead, false, 'There should be no synchronous <script src> in <head>');
  });

  it('2: index.html has preconnect and dns-prefetch for gstatic', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(html.includes('<link rel="preconnect" href="https://www.gstatic.com" crossorigin>'), 'Must have preconnect');
    assert.ok(html.includes('<link rel="dns-prefetch" href="https://www.gstatic.com">'), 'Must have dns-prefetch');
  });

  it('3: index.html does not contain Cache-Control: no-cache meta tags that break caching', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const headEnd = html.indexOf('</head>');
    const head = html.slice(0, headEnd);
    assert.ok(!head.includes('http-equiv="Cache-Control"'), 'Must not have no-cache meta tags');
    assert.ok(!head.includes('http-equiv="Pragma"'), 'Must not have Pragma no-cache meta tags');
  });

  it('4: dead/duplicate CSS is removed from index.html', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    // .artifact-page was dead prototype CSS
    assert.ok(!html.includes('.artifact-page{max-width:none'), 'Dead .artifact-page CSS must be removed');
  });

  it('5: getModelCat JavaScript function is not duplicated inside showAllModels', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const matches = html.match(/function\s+getModelCat\s*\(/g) || [];
    assert.equal(matches.length, 1, 'getModelCat should only be declared once in root scope');
  });

  it('6: server serves Brotli and Gzip compression with > 70% size reduction', async () => {
    const getRes = (encoding) => new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:3000/', { headers: { 'Accept-Encoding': encoding } }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          size: Buffer.concat(chunks).length,
        }));
      }).on('error', reject);
    });

    const uncompressedSize = fs.statSync(path.join(ROOT, 'index.html')).size;
    const brRes = await getRes('br');
    assert.equal(brRes.statusCode, 200);
    assert.equal(brRes.headers['content-encoding'], 'br');
    assert.ok(brRes.size < uncompressedSize * 0.35, 'Brotli must achieve > 65% compression');

    const gzRes = await getRes('gzip');
    assert.equal(gzRes.statusCode, 200);
    assert.equal(gzRes.headers['content-encoding'], 'gzip');
    assert.ok(gzRes.size < uncompressedSize * 0.35, 'Gzip must achieve > 65% compression');
  });

  it('7: static assets have long cache headers and ETag validation', async () => {
    const getAsset = (url, headers = {}) => new Promise((resolve, reject) => {
      http.get(url, { headers }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          size: Buffer.concat(chunks).length,
        }));
      }).on('error', reject);
    });

    const qrRes = await getAsset('http://127.0.0.1:3000/upi-qr.jpg');
    assert.equal(qrRes.statusCode, 200);
    assert.ok(qrRes.headers['cache-control'].includes('max-age=86400'), 'Must have 1-day max-age');
    assert.ok(qrRes.headers.etag, 'Must send ETag');

    // Conditional 304 Not Modified
    const notModified = await getAsset('http://127.0.0.1:3000/upi-qr.jpg', { 'If-None-Match': qrRes.headers.etag });
    assert.equal(notModified.statusCode, 304, 'Must respond with 304 Not Modified');
    assert.equal(notModified.size, 0, '304 must have 0 body bytes');
  });

  it('8: sensitive user and API data is never cached (Cache-Control: no-store)', async () => {
    const getApi = (url) => new Promise((resolve, reject) => {
      http.get(url, (res) => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
        });
      }).on('error', reject);
    });

    const apiRes = await getApi('http://127.0.0.1:3000/api/profile/config');
    assert.equal(apiRes.statusCode, 200);
    assert.ok(apiRes.headers['cache-control'].includes('no-store'), 'Sensitive API data must have no-store');
  });
});
