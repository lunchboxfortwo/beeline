#!/usr/bin/env node
/** Disposable S3 stand-in for the local web rig; no real keys or remote storage. */
import { createServer } from 'node:http';
const objects = new Map();
const port = Number(process.env.LATENCY_RIG_OBJECT_PORT ?? 18092);
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (!path.startsWith('/latency-rig/')) return res.writeHead(404).end();
  if (req.method === 'PUT') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) return res.writeHead(413).end();
      chunks.push(chunk);
    }
    objects.set(path, {
      bytes: Buffer.concat(chunks),
      type: req.headers['content-type'] ?? 'application/octet-stream',
    });
    return res.writeHead(200).end();
  }
  const object = objects.get(path);
  if (!object) return res.writeHead(404).end();
  if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end();
  res.writeHead(200, { 'content-type': object.type, 'content-length': object.bytes.length });
  res.end(req.method === 'HEAD' ? undefined : object.bytes);
}).listen(port, '127.0.0.1');
