import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function requestPath(rawUrl) {
  // Inspect the raw request before a URL parser can normalize away traversal.
  const rawPath = rawUrl.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { status: 400, message: 'Invalid URL encoding.' };
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\0:]/.test(decoded)) {
    return { status: 403, message: 'Forbidden path.' };
  }
  // Reject nested encodings, dot segments, and hidden files or directories.
  if (/%[0-9a-f]{2}/i.test(decoded) || decoded.split('/').some((part) => part.startsWith('.'))) {
    return { status: 403, message: 'Forbidden path.' };
  }
  return { pathname: decoded === '/' ? '/index.html' : decoded };
}

function sendText(request, response, status, message) {
  const body = `${message}\n`;
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

export function createStaticServer({ root = APP_ROOT } = {}) {
  const servedRoot = realpathSync(root);
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendText(request, response, 405, 'Method not allowed.');
      return;
    }

    const parsed = requestPath(request.url ?? '');
    if (parsed.status) {
      sendText(request, response, parsed.status, parsed.message);
      return;
    }

    const candidate = path.resolve(servedRoot, `.${parsed.pathname}`);
    if (!isWithin(servedRoot, candidate)) {
      sendText(request, response, 403, 'Forbidden path.');
      return;
    }

    try {
      const resolved = await realpath(candidate);
      // Symlinks and Windows junctions must also remain inside this app.
      if (!isWithin(servedRoot, resolved)) {
        sendText(request, response, 403, 'Forbidden path.');
        return;
      }
      if (!(await stat(resolved)).isFile()) {
        sendText(request, response, 404, 'File not found.');
        return;
      }
      const body = await readFile(resolved);
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const missing = ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code);
      const forbidden = ['EACCES', 'EPERM'].includes(error.code);
      sendText(request, response, missing ? 404 : forbidden ? 403 : 500,
        missing ? 'File not found.' : forbidden ? 'Forbidden path.' : 'Unable to read file.');
    }
  });
}

export function parsePort(args = [], envPort = process.env.PORT) {
  let requestedPort;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--port') {
      requestedPort = args[++index];
      if (requestedPort === undefined) throw new Error('--port requires a value.');
    } else if (argument.startsWith('--port=')) {
      requestedPort = argument.slice('--port='.length);
    } else {
      throw new Error(`Unknown argument: ${argument}. Usage: npm start -- --port 4175`);
    }
  }
  const value = requestedPort ?? envPort ?? '4175';
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('Port must be an integer from 1 to 65535.');
  }
  return Number(value);
}

async function run() {
  try {
    const port = parsePort(process.argv.slice(2));
    const server = createStaticServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    console.log(`Async File 2026 is ready at http://127.0.0.1:${port}`);
    console.log('Press Ctrl+C to stop.');
    const stop = () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error(`Unable to start the local server: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
