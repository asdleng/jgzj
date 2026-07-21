const assert = require('assert');
const http = require('http');
const test = require('node:test');
const express = require('express');

const { registerLidarMapUploadProxyRoutes } = require('./lidar-map-upload-proxy');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method || 'GET',
        headers: options.headers || {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('streams resumable uploads and status calls to the authenticated receiver', async () => {
  const upstreamRequests = [];
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      upstreamRequests.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization,
        contentRange: req.headers['content-range'],
        body: Buffer.concat(chunks).toString('utf8')
      });
      if (req.headers.authorization !== 'Bearer test-token') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"unauthorized"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const receiverPort = await listen(receiver);

  const app = express();
  registerLidarMapUploadProxyRoutes(app, {
    receiverBaseUrl: `http://127.0.0.1:${receiverPort}`,
    timeoutMs: 5000
  });
  const gateway = http.createServer(app);
  const gatewayPort = await listen(gateway);

  try {
    const asset = 'keyframes.retrieval_refresh_20260720.tar.gz';
    const upload = await request(
      gatewayPort,
      `/api/auto_ad/lidar-map-upload/BIT-0030/${asset}`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-length': '5',
          'content-range': 'bytes 0-4/10'
        },
        body: 'abcde'
      }
    );
    assert.strictEqual(upload.statusCode, 200);
    assert.deepStrictEqual(upstreamRequests[0], {
      method: 'POST',
      path: `/upload/BIT-0030/${asset}`,
      authorization: 'Bearer test-token',
      contentRange: 'bytes 0-4/10',
      body: 'abcde'
    });

    const status = await request(
      gatewayPort,
      `/api/auto_ad/lidar-map-upload/BIT-0030/${asset}/status`,
      { headers: { authorization: 'Bearer test-token' } }
    );
    assert.strictEqual(status.statusCode, 200);
    assert.strictEqual(upstreamRequests[1].path, `/upload/BIT-0030/${asset}/status`);

    const unauthorized = await request(
      gatewayPort,
      `/api/auto_ad/lidar-map-upload/BIT-0030/${asset}/status`
    );
    assert.strictEqual(unauthorized.statusCode, 401);

    const invalid = await request(
      gatewayPort,
      '/api/auto_ad/lidar-map-upload/BIT-0030/not-allowed.bin'
    );
    assert.strictEqual(invalid.statusCode, 400);
    assert.strictEqual(upstreamRequests.length, 3);
  } finally {
    await close(gateway);
    await close(receiver);
  }
});
