#!/usr/bin/env node
// Build the public static release of Papifa (cross-platform Node-only port of build-web.sh).
//
//   node scripts/build-web.mjs                    build and publish (Linux nginx host only)
//   node scripts/build-web.mjs --stage DIR        build into DIR only, no publish
//   node scripts/build-web.mjs --ref <commit>     build a specific git commit (default: PAPIFA_REF or HEAD)
//   node scripts/build-web.mjs --worktree --stage DIR   build uncommitted game/ files (release id "<sha>-dirty")
//
// Needs only Node (stdlib) and Git on PATH. No curl, tar, rsync, python3, or POSIX shell tools.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO = resolve(dirname(SCRIPT_PATH), '..');

export const THREE_VERSION = '0.170.0';
export const VENDOR_FILES = [
  {
    rel: 'three.module.js',
    upstream: 'build/three.module.js',
    sha256: 'ce1fa418de16a19495a9f72495580e3015d7745c296d3ce0485897f902ddedfb',
  },
  {
    rel: 'addons/loaders/GLTFLoader.js',
    upstream: 'examples/jsm/loaders/GLTFLoader.js',
    sha256: '45139faddd5aaf48ed2d62203d976e5cbd703db1a592de40527f9f6cf58abd44',
  },
  {
    rel: 'addons/utils/BufferGeometryUtils.js',
    upstream: 'examples/jsm/utils/BufferGeometryUtils.js',
    sha256: 'c25b7930e570e9ec56173cd3b866ec8d2e10016630db3937efb439daf1cedbf6',
  },
  {
    rel: 'addons/utils/SkeletonUtils.js',
    upstream: 'examples/jsm/utils/SkeletonUtils.js',
    sha256: 'ee412be1aa05f3051c2bda8ea89612c1ba70c5c87de62b56040282120d5eb991',
  },
];

export function usage() {
  return `Usage: node scripts/build-web.mjs [options]
  --stage <dir>      Stage the release into <dir> without publishing
  --ref <commit>     Git commit/ref to build (default: PAPIFA_REF or HEAD)
  --worktree         Build uncommitted files from game/ (marks release id as "<commit>-dirty"; requires --stage)
  --relay <url|none> Bake a WebSocket relay URL (default: PAPIFA_RELAY_URL, or deploy/relay.json if present, else none)
  --no-relay         Build with no relay configured (direct invite-code WebRTC only)
  --target <dir>     Publish target directory on Linux (default: PAPIFA_WEB_TARGET or /srv/www/papifa)
  --help, -h         Show this help`;
}

export function normalizeBuildRelayUrl(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return null;
  if (/[\s"'<>]/.test(trimmed)) {
    throw new Error(`Invalid relay URL (contains whitespace or quotes): ${trimmed}`);
  }
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`Invalid relay URL: ${trimmed}`);
  }
  if (u.username || u.password || u.hash) {
    throw new Error(`Relay URL must not include credentials or a fragment: ${trimmed}`);
  }
  const hostLower = u.hostname.toLowerCase();
  const isLoopback = hostLower === 'localhost' || hostLower === '127.0.0.1' || hostLower === '[::1]' || hostLower === '::1';
  if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && isLoopback)) {
    throw new Error(`Relay URL must use wss:// (ws:// is only allowed for loopback): ${trimmed}`);
  }
  if (!u.hostname) {
    throw new Error(`Relay URL is missing a hostname: ${trimmed}`);
  }
  if (!u.pathname || u.pathname === '/') {
    u.pathname = '/papifa/net';
  }
  return { url: u.href, origin: `${u.protocol}//${u.host}` };
}

export function readPrivateRelayDefault(repo = DEFAULT_REPO) {
  const cfgPath = join(repo, 'deploy', 'relay.json');
  if (!existsSync(cfgPath)) return null;
  const data = JSON.parse(readFileSync(cfgPath, 'utf8'));
  return data?.relayUrl ? normalizeBuildRelayUrl(data.relayUrl) : null;
}

export function parseArgs(argv, env = process.env) {
  const opts = {
    stage: null,
    ref: env.PAPIFA_REF || 'HEAD',
    refExplicit: false,
    worktree: false,
    relay: env.PAPIFA_RELAY_URL !== undefined ? env.PAPIFA_RELAY_URL : undefined,
    relayExplicit: env.PAPIFA_RELAY_URL !== undefined,
    target: env.PAPIFA_WEB_TARGET || '/srv/www/papifa',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--stage') {
      const dir = argv[++i];
      if (!dir) throw new Error('--stage needs a directory');
      opts.stage = dir;
    } else if (a === '--ref') {
      const ref = argv[++i];
      if (!ref) throw new Error('--ref needs a git commit or ref');
      opts.ref = ref;
      opts.refExplicit = true;
    } else if (a === '--worktree') {
      opts.worktree = true;
    } else if (a === '--relay') {
      const val = argv[++i];
      if (val === undefined) throw new Error('--relay needs a wss:// URL or "none"');
      opts.relay = val;
      opts.relayExplicit = true;
    } else if (a === '--no-relay') {
      opts.relay = 'none';
      opts.relayExplicit = true;
    } else if (a === '--target') {
      const dir = argv[++i];
      if (!dir) throw new Error('--target needs a directory');
      opts.target = dir;
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  if (opts.worktree && opts.refExplicit) {
    throw new Error('Cannot combine --worktree with --ref');
  }
  return opts;
}

export function resolveCacheDir({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  pathMod = path,
} = {}) {
  const base = env.XDG_CACHE_HOME
    ? env.XDG_CACHE_HOME
    : platform === 'win32'
      ? (env.LOCALAPPDATA || pathMod.join(home, 'AppData', 'Local'))
      : pathMod.join(home, '.cache');
  return pathMod.join(base, 'papifa-vendor', `three-${THREE_VERSION}`);
}

export function buildReleaseId(shortSha, worktree = false) {
  if (worktree) return `${shortSha || 'worktree'}-dirty`;
  if (!shortSha) throw new Error('Missing commit SHA for release id');
  return shortSha;
}

export function rewriteIndexHtml(html, rel, { relayUrl = null } = {}) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html has no import map');
  const imap =
    '\n{ "imports": {\n  "three": "./vendor/three/three.module.js",\n' +
    '  "three/addons/": "./vendor/three/addons/"\n} }\n';
  const start = m.index + '<script type="importmap">'.length;
  const end = start + m[1].length;
  let out = html.slice(0, start) + imap + html.slice(end);

  const relay = normalizeBuildRelayUrl(relayUrl);
  const connectSrc = relay
    ? `'self' ${relay.origin} data: blob:`
    : `'self' data: blob:`;

  const digest = createHash('sha256').update(imap, 'utf8').digest('base64');
  let csp =
    "default-src 'none'; " +
    `script-src 'self' 'sha256-${digest}'; ` +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    `connect-src ${connectSrc}; ` +
    "media-src 'self' blob:; " +
    "worker-src 'self' blob:; " +
    "font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";
  if (out.includes('<link rel="manifest"')) {
    csp += "; manifest-src 'self'";
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const relayMeta = relay ? `\n<meta name="papifa-relay" content="${relay.url.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">` : '';
  const base = `<base href="r/${rel}/">`;
  const charsetTag = '<meta charset="utf-8">';
  const charsetIdx = out.indexOf(charsetTag);
  if (charsetIdx !== -1) {
    out = out.slice(0, charsetIdx) + `${charsetTag}\n${meta}${relayMeta}\n${base}` + out.slice(charsetIdx + charsetTag.length);
  }
  out = out.replaceAll(
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="manifest" href="../../manifest.webmanifest">',
  );
  if (out.includes('cdn.jsdelivr')) {
    throw new Error('index.html still references the CDN');
  }
  return out;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

function runGit(repo, args, encoding = 'utf8') {
  const res = spawnSync('git', ['-C', repo, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const errText = encoding ? res.stderr : res.stderr.toString('utf8');
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${errText.trim()}`);
  }
  return res.stdout;
}

// Export `game/` directly from Git's object database (no `tar`, no CRLF distortion on Windows).
async function exportGitGameTree(repo, ref, destRoot) {
  const rawList = runGit(repo, ['ls-tree', '-r', '-z', ref, '--', 'game'], null);
  const entries = [];
  let offset = 0;
  while (offset < rawList.length) {
    const nul = rawList.indexOf(0, offset);
    if (nul === -1) break;
    const record = rawList.subarray(offset, nul).toString('utf8');
    offset = nul + 1;
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const gitRelPath = record.slice(tab + 1);
    if (type !== 'blob') continue;
    if (mode === '120000') {
      throw new Error(`Refusing to export symlink in game tree: ${gitRelPath}`);
    }
    entries.push({ oid, gitRelPath });
  }
  if (entries.length === 0) {
    throw new Error(`No files found under game/ at ref ${ref}`);
  }

  await new Promise((resolveDone, rejectDone) => {
    const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', rejectDone);

    let buf = Buffer.alloc(0);
    let entryIndex = 0;
    let expectingBody = null; // { outPath, size }

    function drainBuffer() {
      while (entryIndex < entries.length) {
        if (!expectingBody) {
          const nl = buf.indexOf(0x0a);
          if (nl === -1) return;
          const header = buf.subarray(0, nl).toString('utf8');
          buf = buf.subarray(nl + 1);
          const parts = header.split(' ');
          if (parts.length < 3 || parts[1] !== 'blob') {
            throw new Error(`Unexpected git cat-file header: ${header}`);
          }
          const size = Number.parseInt(parts[2], 10);
          if (!Number.isInteger(size) || size < 0) {
            throw new Error(`Invalid blob size in header: ${header}`);
          }
          const relParts = entries[entryIndex].gitRelPath.split('/');
          if (relParts.some((seg) => seg === '' || seg === '.' || seg === '..')) {
            throw new Error(`Unsafe path in git tree: ${entries[entryIndex].gitRelPath}`);
          }
          expectingBody = { outPath: join(destRoot, ...relParts), size };
        }
        // cat-file --batch appends one trailing LF after the exact blob bytes.
        if (buf.length < expectingBody.size + 1) return;
        const body = buf.subarray(0, expectingBody.size);
        buf = buf.subarray(expectingBody.size + 1);
        mkdirSync(dirname(expectingBody.outPath), { recursive: true });
        writeFileSync(expectingBody.outPath, body);
        expectingBody = null;
        entryIndex++;
      }
    }

    let failed = false;
    child.stdout.on('data', (chunk) => {
      if (failed) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        drainBuffer();
      } catch (err) {
        failed = true;
        child.kill();
        rejectDone(err);
      }
    });

    child.on('close', (code) => {
      if (failed) return;
      if (code !== 0) {
        rejectDone(new Error(`git cat-file --batch exited ${code}: ${stderr.trim()}`));
      } else if (entryIndex !== entries.length) {
        rejectDone(new Error(`git cat-file --batch ended early (${entryIndex}/${entries.length} blobs)`));
      } else {
        resolveDone();
      }
    });

    const input = entries.map((e) => e.oid).join('\n') + '\n';
    child.stdin.end(input);
  });
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function ensureVendoredThree(cacheDir, appDir) {
  for (const item of VENDOR_FILES) {
    const cachePath = join(cacheDir, ...item.rel.split('/'));
    if (!existsSync(cachePath)) {
      mkdirSync(dirname(cachePath), { recursive: true });
      const url = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/${item.upstream}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
      }
      const data = Buffer.from(await res.arrayBuffer());
      const actual = sha256Hex(data);
      if (actual !== item.sha256) {
        throw new Error(`checksum mismatch while downloading ${item.rel}: got ${actual}, expected ${item.sha256}`);
      }
      const tmpFile = `${cachePath}.${process.pid}.tmp`;
      writeFileSync(tmpFile, data);
      renameSync(tmpFile, cachePath);
    }
    const cached = readFileSync(cachePath);
    const actual = sha256Hex(cached);
    if (actual !== item.sha256) {
      throw new Error(`checksum mismatch: ${item.rel}`);
    }
    const destPath = join(appDir, 'vendor', 'three', ...item.rel.split('/'));
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, cached);
  }
}

function copyFileEnsured(src, dest, mode = null) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  if (mode !== null && process.platform !== 'win32') chmodSync(dest, mode);
}

function copyTree(srcDir, destDir, { dirMode = null, fileMode = null, exclude = null } = {}) {
  mkdirSync(destDir, { recursive: true });
  if (dirMode !== null && process.platform !== 'win32') chmodSync(destDir, dirMode);
  for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
    if (exclude && exclude(ent.name)) continue;
    const s = join(srcDir, ent.name);
    const d = join(destDir, ent.name);
    if (ent.isDirectory()) {
      copyTree(s, d, { dirMode, fileMode });
    } else if (ent.isFile()) {
      copyFileEnsured(s, d, fileMode);
    }
  }
}

function copyMatchingFlat(srcDir, destDir, predicate) {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) return;
  mkdirSync(destDir, { recursive: true });
  for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
    if (ent.isFile() && predicate(ent.name)) {
      copyFileEnsured(join(srcDir, ent.name), join(destDir, ent.name));
    }
  }
}

function collectFiles(rootDir, out = []) {
  for (const ent of readdirSync(rootDir, { withFileTypes: true })) {
    const full = join(rootDir, ent.name);
    if (ent.isDirectory()) collectFiles(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function checkNoExternalOrigins(stageDir, appDir) {
  const rx = /https?:\/\/(cdn|unpkg|fonts)\./;
  const targets = [];
  if (existsSync(join(appDir, 'src'))) {
    for (const f of collectFiles(join(appDir, 'src'))) {
      if (/\.(js|html|css)$/i.test(f)) targets.push(f);
    }
  }
  for (const ent of readdirSync(stageDir, { withFileTypes: true })) {
    if (ent.isFile() && ent.name.endsWith('.html')) targets.push(join(stageDir, ent.name));
  }
  for (const ent of readdirSync(appDir, { withFileTypes: true })) {
    if (ent.isFile() && ent.name.endsWith('.css')) targets.push(join(appDir, ent.name));
  }
  const offending = [];
  for (const f of targets) {
    const text = readFileSync(f, 'utf8');
    if (rx.test(text)) offending.push(f);
  }
  if (offending.length) {
    for (const f of offending) console.error(f);
    throw new Error('release references an external origin');
  }
}

function syncDirectory(srcDir, destDir, { dirMode = null, fileMode = null, skipTopLevel = null } = {}) {
  mkdirSync(destDir, { recursive: true });
  if (dirMode !== null && process.platform !== 'win32') chmodSync(destDir, dirMode);

  const keep = new Set();
  for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
    if (skipTopLevel && skipTopLevel(ent.name)) continue;
    keep.add(ent.name);
  }
  for (const ent of readdirSync(destDir, { withFileTypes: true })) {
    if (skipTopLevel && skipTopLevel(ent.name)) continue;
    if (!keep.has(ent.name)) {
      rmSync(join(destDir, ent.name), { recursive: true, force: true });
    }
  }
  for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
    if (skipTopLevel && skipTopLevel(ent.name)) continue;
    const s = join(srcDir, ent.name);
    const d = join(destDir, ent.name);
    if (ent.isDirectory()) {
      syncDirectory(s, d, { dirMode, fileMode });
    } else if (ent.isFile()) {
      copyFileEnsured(s, d, fileMode);
    }
  }
}

export async function buildWeb(opts, { repo = DEFAULT_REPO, platform = process.platform, env = process.env } = {}) {
  if (!opts.stage) {
    if (platform !== 'linux') {
      throw new Error('Default publish mode is Linux-only (nginx host). Use --stage <dir> to build a release on this platform.');
    }
    if (opts.worktree) {
      throw new Error('Refusing to publish an uncommitted --worktree build. Pass --stage <dir> instead.');
    }
  }

  let shortSha = '';
  if (opts.worktree) {
    try {
      shortSha = runGit(repo, ['rev-parse', '--short=10', 'HEAD']).trim();
    } catch {
      shortSha = 'worktree';
    }
  } else {
    shortSha = runGit(repo, ['rev-parse', '--short=10', opts.ref]).trim();
  }
  const rel = buildReleaseId(shortSha, opts.worktree);
  const cacheDir = resolveCacheDir({ platform, env });

  const relayConfig = opts.relayExplicit
    ? normalizeBuildRelayUrl(opts.relay)
    : readPrivateRelayDefault(repo);

  const stage = mkdtempSync(join(tmpdir(), 'papifa-web-stage-'));
  const srcTmp = opts.worktree ? null : mkdtempSync(join(tmpdir(), 'papifa-web-src-'));
  try {
    let gameDir;
    if (opts.worktree) {
      gameDir = join(repo, 'game');
      if (!existsSync(join(gameDir, 'index.html'))) {
        throw new Error(`Worktree game directory not found at ${gameDir}`);
      }
    } else {
      await exportGitGameTree(repo, opts.ref, srcTmp);
      gameDir = join(srcTmp, 'game');
    }

    const appDir = join(stage, 'r', rel);
    mkdirSync(appDir, { recursive: true });

    // 1. Vendor three.js (download once, verify SHA-256 every time).
    await ensureVendoredThree(cacheDir, appDir);

    // 2. Copy the game (no tests, no dev viewer, no source assets).
    copyFileEnsured(join(gameDir, 'index.html'), join(stage, 'index.html'));
    copyMatchingFlat(gameDir, appDir, (name) => name.endsWith('.css'));

    // Earlier release commits predate the installable app.
    if (existsSync(join(gameDir, 'manifest.webmanifest'))) {
      copyFileEnsured(join(gameDir, 'favicon.svg'), join(appDir, 'favicon.svg'));
      copyFileEnsured(join(gameDir, 'manifest.webmanifest'), join(stage, 'manifest.webmanifest'));
      copyFileEnsured(join(gameDir, 'favicon.svg'), join(stage, 'favicon.svg'));
      for (const root of [stage, appDir]) {
        for (const icon of ['papifa-192.png', 'papifa-512.png']) {
          copyFileEnsured(
            join(gameDir, 'assets', 'icons', icon),
            join(root, 'assets', 'icons', icon),
          );
        }
      }
    }

    copyTree(join(gameDir, 'src'), join(appDir, 'src'));

    for (const dirName of ['models', 'textures', 'ui']) {
      copyMatchingFlat(
        join(gameDir, 'assets', dirName),
        join(appDir, 'assets', dirName),
        (name) => name.endsWith('.glb') || name.endsWith('.webp'),
      );
    }
    for (const lang of ['en', 'el']) {
      copyMatchingFlat(
        join(gameDir, 'assets', 'narration', lang),
        join(appDir, 'assets', 'narration', lang),
        (name) => name.endsWith('.mp3'),
      );
    }
    const cameosSrc = join(gameDir, 'assets', 'cameos');
    if (existsSync(cameosSrc) && statSync(cameosSrc).isDirectory()) {
      copyMatchingFlat(cameosSrc, join(appDir, 'assets', 'cameos'), (name) => name.endsWith('.glb'));
      copyMatchingFlat(
        join(cameosSrc, 'audio'),
        join(appDir, 'assets', 'cameos', 'audio'),
        (name) => name.endsWith('.mp3'),
      );
    }

    // 3. Point the import map at the vendored copy and inject the Content-Security-Policy.
    const indexPath = join(stage, 'index.html');
    const rewritten = rewriteIndexHtml(readFileSync(indexPath, 'utf8'), rel, { relayUrl: relayConfig?.url ?? null });
    writeFileSync(indexPath, rewritten, 'utf8');

    // Nothing in the release may reach another origin.
    checkNoExternalOrigins(stage, appDir);

    const allFiles = collectFiles(stage);
    const totalBytes = allFiles.reduce((sum, f) => sum + statSync(f).size, 0);
    const sizeLabel = formatBytes(totalBytes);

    if (opts.stage) {
      const stageTarget = resolve(opts.stage);
      syncDirectory(stage, stageTarget);
      console.log(`Staged ${allFiles.length} file(s), ${sizeLabel}, in ${opts.stage}`);
      return { rel, fileCount: allFiles.length, totalBytes, outputDir: stageTarget };
    }

    // 4. Publish (Linux nginx target).
    const target = resolve(opts.target);
    let writable = false;
    try {
      writable = statSync(target).isDirectory();
      if (writable) accessSync(target, fsConstants.W_OK);
    } catch {
      writable = false;
    }
    if (!writable) {
      const user = env.USER || userInfo().username;
      throw new Error(
        `Missing or unwritable ${target}. One-time setup:\n  sudo install -d -o ${user} -g ${user} -m 755 ${target}`,
      );
    }

    const targetReleases = join(target, 'r');
    mkdirSync(targetReleases, { recursive: true });
    const targetRelDir = join(targetReleases, rel);
    syncDirectory(appDir, targetRelDir, { dirMode: 0o755, fileMode: 0o644 });
    const now = new Date();
    utimesSync(targetRelDir, now, now);

    syncDirectory(stage, target, {
      dirMode: 0o755,
      fileMode: 0o644,
      skipTopLevel: (name) => name.startsWith('.') || name === 'r',
    });

    // Keep the three newest release folders so open tabs and in-flight loads still resolve.
    const relDirs = readdirSync(targetReleases, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => {
        const full = join(targetReleases, ent.name);
        return { full, mtimeMs: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of relDirs.slice(3)) {
      rmSync(stale.full, { recursive: true, force: true });
    }

    console.log(`Published ${allFiles.length} file(s), ${sizeLabel}, to ${target}/r/${rel} (commit ${rel})`);
    return { rel, fileCount: allFiles.length, totalBytes, outputDir: targetRelDir };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    if (srcTmp) rmSync(srcTmp, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(usage());
      process.exit(0);
    }
    await buildWeb(opts);
  } catch (err) {
    console.error(err?.message || err);
    process.exit(1);
  }
}
