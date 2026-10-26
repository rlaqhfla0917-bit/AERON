'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {resolvePublicFile, isTrustedOrigin} = require('../security');
const root = path.join(process.cwd(), 'AERON_fixture');
test('only public UI files are served', () => {
  assert.equal(resolvePublicFile(root, '/login.html'), path.join(root, 'login.html'));
  assert.equal(resolvePublicFile(root, '/docs/index.html'), path.join(root, 'docs', 'index.html'));
});
test('private files and traversals are refused', () => {
  for (const target of ['/.env','/server.js','/sample_field_terms.csv',
    '/%2e%2e/.env','/%2F.env','/package.json','/README.md']) {
    assert.equal(resolvePublicFile(root, target), null, target);
  }
});
test('cross-origin browser writes are refused', () => {
  assert.equal(isTrustedOrigin('http://localhost:5173', 5173), true);
  assert.equal(isTrustedOrigin('http://127.0.0.1:5173', 5173), true);
  assert.equal(isTrustedOrigin('https://evil.example', 5173), false);
  assert.equal(isTrustedOrigin('http://localhost:9999', 5173), false);
  assert.equal(isTrustedOrigin('null', 5173), false);
});
