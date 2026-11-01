'use strict';

const http = require('node:http');

/**
 * A stand-in for the SMSTunnel API on a free local port. Each test sets `server.handler`, which gets the request
 * and returns { status, body, headers } (or a promise of it). Every request is kept in `server.requests`.
 */
async function startFakeApi() {
  const fake = {
    requests: [],
    handler: () => ({ status: 404, body: { message: 'No handler', statusCode: 404 } }),
    url: '',
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://localhost');
      const entry = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      fake.requests.push(entry);
      try {
        const answer = (await fake.handler(entry)) || {};
        const body =
          answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
        res.writeHead(answer.status || 200, { 'Content-Type': 'application/json', ...(answer.headers || {}) });
        res.end(body);
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.reset = () => {
    fake.requests = [];
    fake.handler = () => ({ status: 404, body: { message: 'No handler', statusCode: 404 } });
  };
  fake.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  return fake;
}

function sent(id, extra = {}) {
  return {
    status: 200,
    body: {
      success: true,
      messageId: id,
      queued: false,
      data: { messageId: id, branded: false, queued: false, remaining: { clean: 95, total: 'unlimited' }, ...extra },
    },
  };
}

/** Resolves when `count` calls of `event` (e.g. 'input' on a helper node) have happened. */
function collect(node, event, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const timer = setTimeout(
      () => reject(new Error(`Expected ${count} "${event}", got ${seen.length}`)),
      timeoutMs,
    );
    node.on(event, (value) => {
      seen.push(value);
      if (seen.length === count) {
        clearTimeout(timer);
        resolve(seen);
      }
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { collect, delay, sent, startFakeApi };
