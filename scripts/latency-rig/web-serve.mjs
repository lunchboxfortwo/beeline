#!/usr/bin/env node
/** Static Expo export server, scoped to the requested build directory. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve(process.argv[2]);
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
};
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__latency_blank.html') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Local fixture reset</title>');
      return;
    }
    const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (path !== root && !path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    const file = extname(path) ? path : resolve(root, 'index.html');
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(Number(process.env.LATENCY_RIG_WEB_PORT ?? 18089), '127.0.0.1');
