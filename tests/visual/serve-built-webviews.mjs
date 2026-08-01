#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve(process.cwd(), 'dist/webview');
const port = 4173;
const host = '127.0.0.1';

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

function safePath(url) {
  try {
    const pathname = decodeURIComponent(new URL(url, `http://${host}:${port}`).pathname);
    const requested = pathname === '/' ? '/index.html' : pathname;
    const candidate = resolve(root, `.${requested}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
    return candidate;
  } catch {
    return null;
  }
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }

  const filePath = safePath(request.url ?? '/');
  if (filePath === null) {
    response.writeHead(400);
    response.end('Invalid path');
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('not a file');
    const headers = {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream'
    };

    if (request.method === 'HEAD') {
      response.writeHead(200, headers);
      response.end();
      return;
    }

    if (extname(filePath) === '.html') {
      const html = (await readFile(filePath, 'utf8')).replace(
        /<meta http-equiv="Content-Security-Policy" content="__CSP__"\s*\/>/,
        ''
      );
      response.writeHead(200, headers);
      response.end(html);
      return;
    }

    response.writeHead(200, headers);
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Schegent visual fixture server listening on http://${host}:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
