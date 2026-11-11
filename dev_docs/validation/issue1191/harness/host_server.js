#!/usr/bin/env node
/**
 * Synthetic host page for Issue #1046 PR4 fork visual evidence.
 *
 * Serves one HTML page whose full-viewport iframe embeds the fork Research
 * workbench in embedded mode. The host performs the documented research-v0
 * ready→token handshake with a **fabricated, unsigned** Research Token (claims
 * only; signature verification is Gateway-side and the Gateway is route-mocked
 * in this harness). No credentials, no private content.
 *
 * Usage: node host_server.js <port> <iframeUrl> [parentOrigin]
 *   e.g. node host_server.js 8872 http://127.0.0.1:8871/research
 */
const http = require('node:http')

const port = Number(process.argv[2] || 8872)
const iframeUrl = process.argv[3] || 'http://127.0.0.1:8871/research'
const parentOrigin = process.argv[4] || `http://127.0.0.1:${port}`

const payload = {
  sub: '1',
  project_id: 'p1',
  role: 'owner',
  scopes: ['research:read', 'research:write'],
  exp: Math.floor(Date.now() / 1000) + 86400,
}
const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const token = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.synthetic-signature`
const expiresAt = Date.now() + 3600 * 1000

const childOrigin = (() => {
  try {
    return new URL(iframeUrl).origin
  } catch {
    return ''
  }
})()

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RDLens host — Issue #1046 PR4 visual evidence (synthetic)</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #ffffff; }
  #app { display: block; width: 100vw; height: 100vh; border: 0; }
</style>
<script>
  (function () {
    window.__hostBoot = true;
    console.log('[synthetic-host] boot');
    var TOKEN = ${JSON.stringify(token)};
    var EXPIRES_AT = ${expiresAt};
    var CHILD_ORIGIN = ${JSON.stringify(childOrigin)};
    var PARENT_ORIGIN = ${JSON.stringify(parentOrigin)};
    window.addEventListener('message', function (event) {
      var iframe = document.getElementById('app');
      if (!iframe) return;
      var data = event.data || {};
      console.log('[synthetic-host] message', event.origin, JSON.stringify(data).slice(0, 120));
      if (event.origin !== CHILD_ORIGIN) return;
      if (event.source !== iframe.contentWindow) return;
      if (data.schema !== 'research-v0') return;
      if (data.type !== 'ready') return;
      var base = { schema: 'research-v0', channel: data.channel, nonce: data.nonce };
      iframe.contentWindow.postMessage(
        Object.assign({}, base, { type: 'token', token: TOKEN, expires_at: EXPIRES_AT }),
        CHILD_ORIGIN,
      );
      iframe.contentWindow.postMessage(
        Object.assign({}, base, { type: 'theme', theme: 'light' }),
        CHILD_ORIGIN,
      );
      console.log('[synthetic-host] token sent to', CHILD_ORIGIN);
    });
  })();
</script>
</head>
<body>
<iframe id="app" title="research workspace" src="${iframeUrl}"></iframe>
</body>
</html>`

http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  .listen(port, '127.0.0.1', () => {
    console.log(
      `host page (#1046 PR4): http://127.0.0.1:${port}/ (iframe ${iframeUrl}, parent origin ${parentOrigin})`,
    )
  })
