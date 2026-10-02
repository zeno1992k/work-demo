import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer, parsePort } from './server.mjs';

let fixture;
let server;
let port;
let hasOutsideLink;

before(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), 'async-file-server-'));
  const root = path.join(fixture, 'app');
  const outside = path.join(fixture, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await mkdir(path.join(root, 'assets'));
  await Promise.all([
    writeFile(path.join(root, 'index.html'), '<!doctype html><h1>파일 처리</h1>'),
    writeFile(path.join(root, 'app.css'), 'body { color: black; }'),
    writeFile(path.join(root, 'app.js'), 'export const ready = true;'),
    writeFile(path.join(root, 'data.json'), '{"ready":true}'),
    writeFile(path.join(root, 'notes.txt'), '한글 텍스트\n둘째 줄'),
    writeFile(path.join(root, '.hidden'), 'hidden test data'),
    writeFile(path.join(outside, 'private.txt'), 'outside test data'),
  ]);
  try {
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    hasOutsideLink = true;
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    hasOutsideLink = false;
  }
  server = createStaticServer({ root });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

function get(target, method = 'GET') {
  // http.request keeps dot segments intact so traversal cases reach the server.
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path: target, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('serves the index and UTF-8 assets with the correct MIME types and no caching', async () => {
  const assets = [
    ['/', 'text/html; charset=utf-8', '파일 처리'],
    ['/app.css?fresh=1', 'text/css; charset=utf-8', 'color: black'],
    ['/app.js', 'text/javascript; charset=utf-8', 'export const'],
    ['/data.json', 'application/json; charset=utf-8', '"ready":true'],
    ['/notes.txt', 'text/plain; charset=utf-8', '한글 텍스트'],
  ];
  for (const [target, mime, content] of assets) {
    const result = await get(target);
    assert.equal(result.status, 200, target);
    assert.equal(result.headers['content-type'], mime);
    assert.match(result.headers['cache-control'], /no-store/);
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.ok(result.body.includes(content));
    assert.equal(Number(result.headers['content-length']), Buffer.byteLength(result.body));
  }
});

test('HEAD sends the GET headers without a response body', async () => {
  const result = await get('/notes.txt', 'HEAD');
  assert.equal(result.status, 200);
  assert.equal(result.body, '');
  assert.equal(Number(result.headers['content-length']), Buffer.byteLength('한글 텍스트\n둘째 줄'));
});

test('missing files and directories are not listed', async () => {
  assert.equal((await get('/missing.txt')).status, 404);
  assert.equal((await get('/assets')).status, 404);
  assert.equal((await get('/assets/')).status, 404);
  assert.equal((await get('/')).status, 200);
});

test('rejects non-read HTTP methods', async () => {
  const result = await get('/notes.txt', 'POST');
  assert.equal(result.status, 405);
  assert.equal(result.headers.allow, 'GET, HEAD');
});

test('rejects raw, encoded, nested encoded and Windows-style traversal', async () => {
  const paths = [
    '/../outside/private.txt',
    '/%2e%2e/outside/private.txt',
    '/%2E%2E%2Foutside/private.txt',
    '/%252e%252e/outside/private.txt',
    '/%2e/notes.txt',
    '/samples/../../outside/private.txt',
    '/..%5Coutside%5Cprivate.txt',
    '/C:/Windows/win.ini',
    '/C%3A%5CWindows%5Cwin.ini',
    '//server/share/private.txt',
    '/notes.txt%00',
    '/.hidden',
    '/.git/config',
    'http://127.0.0.1/notes.txt',
  ];
  for (const target of paths) {
    const result = await get(target);
    assert.equal(result.status, 403, target);
    assert.ok(!result.body.includes('outside test data'), target);
  }
});

test('rejects malformed URL encoding', async () => {
  assert.equal((await get('/%ZZ')).status, 400);
});

test('a symlink or Windows junction cannot expose files outside the served root', async (context) => {
  if (!hasOutsideLink) return context.skip('This system does not permit creating test symlinks.');
  const result = await get('/linked/private.txt');
  assert.equal(result.status, 403);
  assert.ok(!result.body.includes('outside test data'));
});

test('port selection supports defaults, environment values and command-line overrides', () => {
  assert.equal(parsePort([], null), 4175);
  assert.equal(parsePort([], '4180'), 4180);
  assert.equal(parsePort(['--port', '4190'], 'bad-value'), 4190);
  assert.equal(parsePort(['--port=4200'], '4180'), 4200);
  for (const value of ['0', '-1', '65536', '3.5', '', 'not-a-port']) {
    assert.throws(() => parsePort(['--port', value]), /Port must/);
  }
  assert.throws(() => parsePort(['--port']), /requires a value/);
  assert.throws(() => parsePort(['--host', '0.0.0.0']), /Unknown argument/);
});

test('samples contain readable Korean UTF-8, valid JSON and a real JSON syntax error', async () => {
  const samples = path.join(path.dirname(fileURLToPath(import.meta.url)), 'samples');
  const [notes, valid, invalid] = await Promise.all([
    readFile(path.join(samples, 'notes.txt'), 'utf8'),
    readFile(path.join(samples, 'valid.json'), 'utf8'),
    readFile(path.join(samples, 'invalid.json'), 'utf8'),
  ]);
  assert.match(notes, /[가-힣]/);
  assert.ok(notes.trim().split(/\r?\n/).length >= 3);
  const data = JSON.parse(valid);
  assert.equal(data.project, '가상의 바람 도서관');
  assert.equal(data.tasks.length, 2);
  assert.throws(() => JSON.parse(invalid), SyntaxError);
});
