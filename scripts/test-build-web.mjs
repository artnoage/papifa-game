#!/usr/bin/env node
// Unit & cross-platform (path.win32) dry-run tests for scripts/build-web.mjs and desktop/build.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  THREE_VERSION,
  buildReleaseId,
  buildWeb,
  normalizeBuildRelayUrl,
  parseArgs,
  readPrivateRelayDefault,
  resolveCacheDir,
  rewriteIndexHtml,
} from './build-web.mjs';
import {
  buildMultiSizeIcoFromPng512,
  parseArgs as parseDesktopArgs,
  readPrivateDesktopAppId,
} from '../desktop/build.mjs';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1. CLI parsing & env handling (including PAPIFA_REF and --worktree)
{
  const d = parseArgs([], { PAPIFA_REF: 'd21bc96' });
  assert.equal(d.ref, 'd21bc96');
  assert.equal(d.stage, null);
  assert.equal(d.worktree, false);

  const s = parseArgs(['--ref', '33acec1', '--stage', 'X:\\temp\\papifa-stage'], {});
  assert.equal(s.ref, '33acec1');
  assert.equal(s.stage, 'X:\\temp\\papifa-stage');

  const w = parseArgs(['--worktree', '--stage', 'X:\\temp\\dirty'], {});
  assert.equal(w.worktree, true);

  assert.throws(() => parseArgs(['--worktree', '--ref', '33acec1'], {}), /Cannot combine/);
}

// 2. Windows path.win32 cache path resolution
{
  const c1 = resolveCacheDir({
    platform: 'win32',
    env: { LOCALAPPDATA: 'X:\\TestUser\\AppData\\Local' },
    home: 'X:\\TestUser',
    pathMod: path.win32,
  });
  assert.equal(c1, `X:\\TestUser\\AppData\\Local\\papifa-vendor\\three-${THREE_VERSION}`);

  const c2 = resolveCacheDir({
    platform: 'win32',
    env: {},
    home: 'X:\\TestUser',
    pathMod: path.win32,
  });
  assert.equal(c2, `X:\\TestUser\\AppData\\Local\\papifa-vendor\\three-${THREE_VERSION}`);

  const c3 = resolveCacheDir({
    platform: 'linux',
    env: {},
    home: '/tmp/user',
    pathMod: path.posix,
  });
  assert.equal(c3, `/tmp/user/.cache/papifa-vendor/three-${THREE_VERSION}`);
}

// 3. Release ID formatting
{
  assert.equal(buildReleaseId('33acec1441', false), '33acec1441');
  assert.equal(buildReleaseId('33acec1441', true), '33acec1441-dirty');
  assert.equal(buildReleaseId('', true), 'worktree-dirty');
}

// 4. index.html rewriting (CSP hash, base href, manifest path, CRLF input resilience, relay vs no-relay CSP)
{
  const sampleHtml = [
    '<!doctype html>',
    '<head>',
    '<meta charset="utf-8">',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<script type="importmap">',
    '{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js" } }',
    '</script>',
    '</head>',
  ].join('\r\n');
  const outNoRelay = rewriteIndexHtml(sampleHtml, '33acec1441-dirty');
  assert.ok(outNoRelay.includes('<base href="r/33acec1441-dirty/">'));
  assert.ok(outNoRelay.includes('<link rel="manifest" href="../../manifest.webmanifest">'));
  assert.ok(outNoRelay.includes("manifest-src 'self'"));
  assert.ok(outNoRelay.includes("connect-src 'self' data: blob:;"), 'no-relay CSP has no wss:');
  assert.ok(!outNoRelay.includes('wss:'), 'no-relay build contains zero wss: references');
  assert.ok(!outNoRelay.includes('papifa-relay'), 'no-relay build omits papifa-relay meta');
  assert.ok(!outNoRelay.includes('cdn.jsdelivr'));

  const outWithRelay = rewriteIndexHtml(sampleHtml, '33acec1441', { relayUrl: 'wss://relay.example/papifa/net' });
  assert.ok(outWithRelay.includes("connect-src 'self' wss://relay.example data: blob:;"));
  assert.ok(outWithRelay.includes('<meta name="papifa-relay" content="wss://relay.example/papifa/net">'));

  const imapMatch = outNoRelay.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert.ok(imapMatch);
  const expectedDigest = createHash('sha256').update(imapMatch[1], 'utf8').digest('base64');
  assert.ok(outNoRelay.includes(`script-src 'self' 'sha256-${expectedDigest}'`));

  // Relay CLI flags, env, URL validation, and missing deploy/relay.json fallback.
  assert.equal(normalizeBuildRelayUrl('none'), null);
  assert.equal(normalizeBuildRelayUrl('wss://relay.example').url, 'wss://relay.example/papifa/net');
  assert.throws(() => normalizeBuildRelayUrl('http://relay.example/papifa/net'), /wss:\/\//);
  assert.equal(parseArgs(['--no-relay'], {}).relay, 'none');
  assert.equal(parseArgs(['--relay', 'wss://relay.example/papifa/net'], {}).relayExplicit, true);
  assert.equal(parseArgs([], { PAPIFA_RELAY_URL: 'wss://env.example/papifa/net' }).relay, 'wss://env.example/papifa/net');
  const tmpEmpty = mkdtempSync(join(tmpdir(), 'papifa-empty-repo-'));
  try {
    assert.equal(readPrivateRelayDefault(tmpEmpty), null, 'public repo without deploy/relay.json defaults to no relay');
    assert.equal(readPrivateDesktopAppId(tmpEmpty), 'io.github.artnoage.papifa', 'public repo uses generic appId');
  } finally {
    rmSync(tmpEmpty, { recursive: true, force: true });
  }
}

// 5. Platform and dirty publish guards
{
  await assert.rejects(
    () => buildWeb(parseArgs([], {}), { repo: repoDir, platform: 'win32' }),
    /Linux-only/,
  );
  await assert.rejects(
    () => buildWeb(parseArgs(['--worktree'], {}), { repo: repoDir, platform: 'linux' }),
    /Refusing to publish/,
  );
}

// 6. Desktop build.mjs platform defaults (Windows builds Windows natively; Linux builds Linux + Windows; macOS builds macOS)
{
  const winDefaults = parseDesktopArgs([], { platform: 'win32', env: {} });
  assert.equal(winDefaults.win, true);
  assert.equal(winDefaults.linux, false);
  assert.equal(winDefaults.mac, false);

  const linuxDefaults = parseDesktopArgs([], { platform: 'linux', env: {} });
  assert.equal(linuxDefaults.linux, true);
  assert.equal(linuxDefaults.win, true);
  assert.equal(linuxDefaults.mac, false);

  const macDefaults = parseDesktopArgs([], { platform: 'darwin', env: {} });
  assert.equal(macDefaults.mac, true);
  assert.equal(macDefaults.linux, false);
  assert.equal(macDefaults.win, false);

  const noRelayDesk = parseDesktopArgs(['--no-relay'], { platform: 'linux', env: {} });
  assert.equal(noRelayDesk.relay, 'none');
  assert.equal(noRelayDesk.relayExplicit, true);
}

// 7. Pure-Node multi-size ICO generator produces a valid 5-frame ICO (256, 128, 64, 32, 16)
{
  const tmp = mkdtempSync(join(tmpdir(), 'papifa-ico-test-'));
  try {
    const icoPath = join(tmp, 'icon.ico');
    buildMultiSizeIcoFromPng512(join(repoDir, 'game', 'assets', 'icons', 'papifa-512.png'), icoPath);
    const ico = readFileSync(icoPath);
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 5);
    const expectedSizes = [256, 128, 64, 32, 16];
    for (let i = 0; i < expectedSizes.length; i++) {
      const e = 6 + i * 16;
      const w = ico.readUInt8(e) || 256;
      const h = ico.readUInt8(e + 1) || 256;
      const size = ico.readUInt32LE(e + 8);
      const offset = ico.readUInt32LE(e + 12);
      assert.equal(w, expectedSizes[i]);
      assert.equal(h, expectedSizes[i]);
      const png = ico.subarray(offset, offset + size);
      assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(png.readUInt32BE(16), expectedSizes[i]);
      assert.equal(png.readUInt32BE(20), expectedSizes[i]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('build-web.mjs & desktop/build.mjs cross-platform unit + path.win32 dry-run tests PASSED.');
