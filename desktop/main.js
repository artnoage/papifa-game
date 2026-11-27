'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { app, BrowserWindow, Menu, protocol, session, shell } = require('electron');

const SCHEME = 'papifa';
const HOST = 'app';
const ORIGIN = `${SCHEME}://${HOST}`;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const headless =
  process.argv.includes('--headless') ||
  process.argv.includes('--ozone-platform=headless') ||
  process.env.PAPIFA_HEADLESS === '1';

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function resolveWebRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'web');
  if (process.env.PAPIFA_WEB_DIR) return path.resolve(process.env.PAPIFA_WEB_DIR);
  return path.join(__dirname, 'web');
}

function resolveIconPath(webRoot) {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'icon.png'), path.join(webRoot, 'assets', 'icons', 'papifa-512.png')]
    : [path.join(webRoot, 'assets', 'icons', 'papifa-512.png')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function isAllowedAppUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin === ORIGIN;
  } catch {
    return false;
  }
}

function openExternalSafely(rawUrl) {
  if (headless) return;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      shell.openExternal(parsed.toString()).catch(() => {});
    }
  } catch {
    // Ignore malformed URLs.
  }
}

function parseByteRange(rangeHeader, fileSize) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;
  const spec = rangeHeader.slice('bytes='.length).split(',')[0].trim();
  const dash = spec.indexOf('-');
  if (dash === -1) return null;
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();

  let start;
  let end;
  if (startStr === '') {
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    end = endStr === '' ? fileSize - 1 : Number.parseInt(endStr, 10);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= fileSize) {
      return 'invalid';
    }
    end = Math.min(end, fileSize - 1);
  }
  return { start, end };
}

function createProtocolHandler(webRoot) {
  const realRoot = fs.realpathSync(webRoot);

  return async (request) => {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    if (url.protocol !== `${SCHEME}:` || url.hostname !== HOST) {
      return new Response('Forbidden', { status: 403 });
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (decodedPath.includes('\0')) {
      return new Response('Bad Request', { status: 400 });
    }

    const cleanRel = decodedPath.endsWith('/') ? `${decodedPath}index.html` : decodedPath;
    let candidate = path.resolve(realRoot, `.${cleanRel}`);

    const checkInside = (p) => {
      const rel = path.relative(realRoot, p);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    };

    if (!checkInside(candidate)) {
      return new Response('Forbidden', { status: 403 });
    }

    let stat;
    try {
      stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        candidate = path.join(candidate, 'index.html');
        stat = fs.statSync(candidate);
      }
      if (!stat.isFile()) {
        return new Response('Not Found', { status: 404 });
      }
      const realFile = fs.realpathSync(candidate);
      if (!checkInside(realFile)) {
        return new Response('Forbidden', { status: 403 });
      }
      candidate = realFile;
    } catch {
      return new Response('Not Found', { status: 404 });
    }

    const ext = path.extname(candidate).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    };

    const range = parseByteRange(request.headers.get('range'), stat.size);
    if (range === 'invalid') {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${stat.size}` },
      });
    }

    if (range) {
      const length = range.end - range.start + 1;
      const rangeHeaders = {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        'Content-Length': String(length),
      };
      if (method === 'HEAD') return new Response(null, { status: 206, headers: rangeHeaders });
      const stream = Readable.toWeb(fs.createReadStream(candidate, { start: range.start, end: range.end }));
      return new Response(stream, { status: 206, headers: rangeHeaders });
    }

    const fullHeaders = { ...headers, 'Content-Length': String(stat.size) };
    if (method === 'HEAD') return new Response(null, { status: 200, headers: fullHeaders });
    const stream = Readable.toWeb(fs.createReadStream(candidate));
    return new Response(stream, { status: 200, headers: fullHeaders });
  };
}

function attachNavigationGuards(contents) {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!isAllowedAppUrl(url)) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });

  contents.on('will-redirect', (event, url) => {
    if (!isAllowedAppUrl(url)) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });
}

app.on('web-contents-created', (_event, contents) => {
  attachNavigationGuards(contents);
});

function createMainWindow(webRoot) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'Papifa',
    backgroundColor: '#102a23',
    icon: resolveIconPath(webRoot),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  win.setMenuBarVisibility(false);

  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      !input.isAutoRepeat &&
      input.key === 'F11' &&
      !input.control &&
      !input.alt &&
      !input.meta &&
      !input.shift
    ) {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });

  if (!headless) {
    win.once('ready-to-show', () => {
      win.show();
    });
  } else if (process.argv.includes('--ozone-platform=headless')) {
    // Under Ozone headless, showing activates the offscreen compositor without opening a desktop window.
    win.once('ready-to-show', () => {
      win.show();
    });
  }

  win.loadURL(`${ORIGIN}/`);
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'fullscreen' || permission === 'pointerLock');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'fullscreen' || permission === 'pointerLock';
  });

  const webRoot = resolveWebRoot();
  if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
    throw new Error(`Bundled web release not found at ${webRoot}`);
  }

  protocol.handle(SCHEME, createProtocolHandler(webRoot));
  createMainWindow(webRoot);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(webRoot);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
