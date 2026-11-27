#!/usr/bin/env node
// Build desktop packages for Papifa (Windows x64 portable .exe / zip, Linux AppImage + tar.gz, macOS zip).
// Stages the game through ../scripts/build-web.mjs --stage so the desktop app always ships one exact release
// with no copied game files, and needs only Node and Git on Windows, macOS, and Linux.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const desktopDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(desktopDir, '..');

function usage() {
  console.log(`Usage: node build.mjs [options]
  --ref <git-ref>          Git commit/ref to stage via scripts/build-web.mjs (default: PAPIFA_REF or HEAD)
  --worktree               Build uncommitted files from game/ (marks release id as "<commit>-dirty")
  --relay <url|none>       Pass a WebSocket relay URL to scripts/build-web.mjs (default: PAPIFA_RELAY_URL or private deploy/relay.json, else none)
  --no-relay               Build with no relay configured (direct invite-code WebRTC only)
  --out <dir>              Output directory (default: PAPIFA_DESKTOP_OUT or ~/scratch/papifa/desktop-dist)
  --linux                  Build Linux x64 (AppImage + tar.gz)
  --win                    Build Windows x64 (portable .exe, or zip if Wine is missing on Linux)
  --mac                    Build macOS zip (on macOS)
  --all                    Build Linux + Windows
  --win-target <target>    Windows target: auto | portable | zip (default: auto)
  --help                   Show this message`);
}

export function readPrivateDesktopAppId(repo = repoDir) {
  const cfgPath = join(repo, 'deploy', 'relay.json');
  if (!existsSync(cfgPath)) return 'io.github.artnoage.papifa';
  try {
    const data = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (typeof data?.desktopAppId === 'string' && data.desktopAppId.trim()) {
      return data.desktopAppId.trim();
    }
  } catch { /* fallback to public app id */ }
  return 'io.github.artnoage.papifa';
}

export function parseArgs(argv, { platform = process.platform, env = process.env } = {}) {
  const opts = {
    ref: env.PAPIFA_REF || 'HEAD',
    refExplicit: false,
    worktree: false,
    relay: env.PAPIFA_RELAY_URL !== undefined ? env.PAPIFA_RELAY_URL : undefined,
    relayExplicit: env.PAPIFA_RELAY_URL !== undefined,
    out: env.PAPIFA_DESKTOP_OUT || join(homedir(), 'scratch', 'papifa', 'desktop-dist'),
    linux: false,
    win: false,
    mac: false,
    winTarget: 'auto',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a === '--ref') { opts.ref = argv[++i]; opts.refExplicit = true; }
    else if (a === '--worktree') opts.worktree = true;
    else if (a === '--relay') {
      const val = argv[++i];
      if (val === undefined) throw new Error('--relay needs a wss:// URL or "none"');
      opts.relay = val;
      opts.relayExplicit = true;
    }
    else if (a === '--no-relay') {
      opts.relay = 'none';
      opts.relayExplicit = true;
    }
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--linux') opts.linux = true;
    else if (a === '--win') opts.win = true;
    else if (a === '--mac') opts.mac = true;
    else if (a === '--all') { opts.linux = true; opts.win = true; }
    else if (a === '--win-target') opts.winTarget = argv[++i];
    else throw new Error(`Unknown option: ${a}`);
  }
  if (opts.worktree && opts.refExplicit) {
    throw new Error('Cannot combine --worktree with --ref');
  }
  if (!opts.linux && !opts.win && !opts.mac) {
    if (platform === 'win32') {
      opts.win = true;
    } else if (platform === 'darwin') {
      opts.mac = true;
    } else {
      opts.linux = true;
      opts.win = true;
    }
  }
  if (!['auto', 'portable', 'zip'].includes(opts.winTarget)) {
    throw new Error(`Invalid --win-target: ${opts.winTarget}`);
  }
  return opts;
}

function commandExists(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(finder, [cmd], { stdio: 'ignore' });
  return res.status === 0;
}

function runChecked(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with status ${res.status}`);
}

// ---------- Pure-Node multi-size PNG -> Windows ICO builder (zero external tools) ----------
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng8Bit(pngBuf) {
  if (pngBuf.length < 33 || !pngBuf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts = [];
  let off = 8;
  while (off + 8 <= pngBuf.length) {
    const len = pngBuf.readUInt32BE(off);
    const type = pngBuf.subarray(off + 4, off + 8).toString('ascii');
    const data = pngBuf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`Unsupported PNG format (depth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idatParts));
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const srcRow = y * (stride + 1) + 1;
    const dstRow = y * stride;
    for (let x = 0; x < stride; x++) {
      const byte = raw[srcRow + x];
      const left = x >= bpp ? pixels[dstRow + x - bpp] : 0;
      const up = y > 0 ? pixels[dstRow - stride + x] : 0;
      const upLeft = (x >= bpp && y > 0) ? pixels[dstRow - stride + x - bpp] : 0;
      let val;
      if (filter === 0) val = byte;
      else if (filter === 1) val = (byte + left) & 0xff;
      else if (filter === 2) val = (byte + up) & 0xff;
      else if (filter === 3) val = (byte + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) val = (byte + paeth(left, up, upLeft)) & 0xff;
      else throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[dstRow + x] = val;
    }
  }
  return { width, height, channels: bpp, pixels };
}

function encodePng8Bit({ width, height, channels, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function downsampleHalf(img) {
  const nw = Math.max(1, img.width >> 1);
  const nh = Math.max(1, img.height >> 1);
  const c = img.channels;
  const out = Buffer.alloc(nw * nh * c);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const dst = (y * nw + x) * c;
      const s00 = ((y * 2) * img.width + (x * 2)) * c;
      const s10 = ((y * 2) * img.width + (x * 2 + 1)) * c;
      const s01 = ((y * 2 + 1) * img.width + (x * 2)) * c;
      const s11 = ((y * 2 + 1) * img.width + (x * 2 + 1)) * c;
      for (let k = 0; k < c; k++) {
        out[dst + k] = Math.round((img.pixels[s00 + k] + img.pixels[s10 + k] + img.pixels[s01 + k] + img.pixels[s11 + k]) / 4);
      }
    }
  }
  return { width: nw, height: nh, channels: c, pixels: out };
}

export function buildMultiSizeIcoFromPng512(pngPath, icoPath) {
  let img = decodePng8Bit(readFileSync(pngPath));
  if (img.width !== 512 || img.height !== 512) {
    throw new Error(`Expected 512x512 PNG for ICO generation, got ${img.width}x${img.height}`);
  }
  const frames = [];
  for (const targetSize of [256, 128, 64, 32, 16]) {
    img = downsampleHalf(img);
    if (img.width !== targetSize || img.height !== targetSize) {
      throw new Error(`Unexpected downsampled size ${img.width}x${img.height}`);
    }
    frames.push({ size: targetSize, data: encodePng8Bit(img) });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICO
  header.writeUInt16LE(frames.length, 4);

  const dirEntries = [];
  let dataOffset = 6 + frames.length * 16;
  for (const f of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(f.size >= 256 ? 0 : f.size, 0);
    entry.writeUInt8(f.size >= 256 ? 0 : f.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(f.data.length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    dataOffset += f.data.length;
    dirEntries.push(entry);
  }
  writeFileSync(icoPath, Buffer.concat([header, ...dirEntries, ...frames.map((f) => f.data)]));
}

function prepareIcons(webDir, buildResDir) {
  mkdirSync(buildResDir, { recursive: true });
  const png512 = join(webDir, 'assets', 'icons', 'papifa-512.png');
  if (!existsSync(png512)) {
    throw new Error(`Expected staged icon at ${png512}`);
  }
  const outPng = join(buildResDir, 'icon.png');
  const outIco = join(buildResDir, 'icon.ico');
  copyFileSync(png512, outPng);
  buildMultiSizeIcoFromPng512(png512, outIco);
  return { outPng, outIco };
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB (${bytes.toLocaleString('en-US')} bytes)`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = resolve(opts.out);
  const builderCli = join(desktopDir, 'node_modules', 'electron-builder', 'cli.js');
  if (!existsSync(builderCli)) {
    throw new Error('electron-builder is not installed. Run `npm ci` in desktop/ first.');
  }

  let shortCommit;
  if (opts.worktree) {
    const revRes = spawnSync('git', ['-C', repoDir, 'rev-parse', '--short=10', 'HEAD'], { encoding: 'utf8' });
    shortCommit = revRes.status === 0 ? `${revRes.stdout.trim()}-dirty` : 'worktree-dirty';
  } else {
    const revRes = spawnSync('git', ['-C', repoDir, 'rev-parse', '--short=10', opts.ref], { encoding: 'utf8' });
    if (revRes.status !== 0) {
      throw new Error(`Invalid git ref ${opts.ref}: ${(revRes.stderr || '').trim()}`);
    }
    shortCommit = revRes.stdout.trim();
  }

  const pkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));
  const isWinHost = process.platform === 'win32';
  const hasWine = isWinHost ? false : commandExists('wine');

  let winTarget = opts.winTarget;
  if (winTarget === 'auto') {
    winTarget = (isWinHost || hasWine) ? 'portable' : 'zip';
  }
  if (opts.win && !isWinHost && winTarget === 'portable' && !hasWine) {
    console.warn('Wine is not installed on this machine; falling back to Windows zip target without executable icon editing.');
    winTarget = 'zip';
  }

  const workTmp = mkdtempSync(join(tmpdir(), 'papifa-desktop-build-'));
  try {
    const webDir = join(workTmp, 'web');
    const buildResDir = join(workTmp, 'build-resources');
    const configPath = join(workTmp, 'electron-builder.json');

    const stageLabel = opts.worktree ? `worktree (${shortCommit})` : `${opts.ref} (${shortCommit})`;
    console.log(`Staging web release at ${stageLabel} via scripts/build-web.mjs --stage ...`);
    const stageArgs = [join(repoDir, 'scripts', 'build-web.mjs'), '--stage', webDir];
    if (opts.worktree) stageArgs.push('--worktree');
    else stageArgs.push('--ref', opts.ref);
    if (opts.relayExplicit) stageArgs.push('--relay', opts.relay);
    runChecked(process.execPath, stageArgs);

    const { outPng, outIco } = prepareIcons(webDir, buildResDir);
    mkdirSync(outDir, { recursive: true });

    const config = {
      appId: readPrivateDesktopAppId(repoDir),
      productName: 'Papifa',
      executableName: 'papifa',
      asar: true,
      compression: 'normal',
      directories: {
        output: outDir,
        buildResources: buildResDir,
      },
      files: [
        'main.js',
        'package.json',
        '!node_modules/**',
      ],
      extraResources: [
        { from: webDir, to: 'web' },
        { from: outPng, to: 'icon.png' },
      ],
      linux: {
        icon: outPng,
        category: 'Game',
        syncDesktopName: true,
        desktop: {
          entry: {
            Name: 'Papifa',
            Comment: 'The orthodox way to play soccer',
            Categories: 'Game;SportsGame;',
          },
        },
        target: [
          { target: 'AppImage', arch: ['x64'] },
          { target: 'tar.gz', arch: ['x64'] },
        ],
        artifactName: `Papifa-\${version}-${shortCommit}-linux-\${arch}.\${ext}`,
      },
      win: {
        icon: outIco,
        signAndEditExecutable: isWinHost || hasWine,
        target: [
          { target: winTarget, arch: ['x64'] },
        ],
        artifactName: winTarget === 'portable'
          ? `Papifa-\${version}-${shortCommit}-win-\${arch}-portable.\${ext}`
          : `Papifa-\${version}-${shortCommit}-win-\${arch}.\${ext}`,
      },
      mac: {
        icon: outPng,
        category: 'public.app-category.sports-games',
        identity: null,
        target: ['zip'],
        artifactName: `Papifa-\${version}-${shortCommit}-mac-\${arch}.\${ext}`,
      },
      publish: null,
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const builderArgs = [builderCli, '--config', configPath, '--publish', 'never'];
    if (opts.linux) builderArgs.push('--linux');
    if (opts.win) builderArgs.push('--win');
    if (opts.mac) builderArgs.push('--mac');

    console.log(`Packaging Papifa ${pkg.version} (${shortCommit}) -> ${outDir}`);
    runChecked(process.execPath, builderArgs, { cwd: desktopDir });

    console.log('\nBuilt artifacts:');
    for (const name of readdirSync(outDir).sort()) {
      const full = join(outDir, name);
      const st = statSync(full);
      if (st.isFile()) {
        console.log(`  ${name}  ${formatMiB(st.size)}`);
      }
    }
  } finally {
    rmSync(workTmp, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
