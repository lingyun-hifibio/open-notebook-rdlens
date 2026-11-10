#!/usr/bin/env node
/**
 * Synthetic host page for Issue #1134 (d2-v1 Note 删除入口) fork visual evidence.
 *
 * Serves one HTML page whose full-viewport iframe embeds the real fork
 * Research workbench (Next dev) in embedded mode. The host performs the
 * documented research-v0 ready→token handshake with a **fabricated, unsigned**
 * Research Token (claims only; signature verification is Gateway-side and the
 * Gateway is route-mocked in this harness). No credentials, no real project or
 * user identity.
 *
 * Role support (Issue #1134 E9 "Admin 只读无删除入口"):
 *   - the host URL query `?role=admin_readonly` makes the initial token claim
 *     `role: "admin_readonly"` instead of `owner` (same synthetic viewer/project);
 *   - `window.__hostSendToken(projectId, role)` re-posts a research-v0 `token`
 *     message on the SAME channel/nonce the iframe generated in its `ready`
 *     handshake (documented dev hook; the contract path a real host uses to
 *     switch project/identity).
 *   - `window.__hostLastHandshake -> {channel, nonce} | null` (evidence/debug)
 *   - `window.__hostTokenCount`, `window.__hostInitialRole`
 *
 * The `project.name` sent with each token is synthetic (`[synthetic] Project
 * P1`), rendered by the fork top bar (`rdlens-target-project-name`), so a
 * screenshot can prove which synthetic project the workspace is bound to.
 *
 * Usage: node host_server.js <port> <iframeUrl> [parentOrigin]
 *   e.g. node host_server.js 8994 http://127.0.0.1:8941/research?legacy=1
 */
const http = require('node:http')

const port = Number(process.argv[2] || 8994)
const iframeUrl = process.argv[3] || 'http://127.0.0.1:8941/research?legacy=1'
const parentOrigin = process.argv[4] || `http://127.0.0.1:${port}`

/** Synthetic project readable names (never real project/tenant names). */
const PROJECT_NAMES = {
  p1: '[synthetic] Project P1',
}

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
<title>RDLens host — Issue #1134 note-delete evidence (synthetic)</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #ffffff; }
  body { display: flex; flex-direction: column; }
  /* Synthetic host chrome: visibly marks every screenshot as harness output and
     exposes which synthetic project/role the token is bound to (no real data). */
  #hostbar {
    flex: 0 0 24px; display: flex; align-items: center; gap: 10px;
    padding: 0 10px; background: #f1f3f5; border-bottom: 1px solid #d7dbe0;
    color: #3f4650; font: 12px/24px ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #hostbar b { color: #1f2630; }
  #hostbar .tag {
    padding: 0 6px; border-radius: 3px; background: #e2e6ea; color: #4a525c;
  }
  #app { display: block; width: 100vw; flex: 1 1 auto; min-height: 0; border: 0; }
</style>
<script>
  (function () {
    window.__hostBoot = true;
    window.__hostLastHandshake = null;
    window.__hostTokenCount = 0;
    console.log('[synthetic-host] boot');
    var PROJECT_NAMES = ${JSON.stringify(PROJECT_NAMES)};
    var CHILD_ORIGIN = ${JSON.stringify(childOrigin)};
    var PARENT_ORIGIN = ${JSON.stringify(parentOrigin)};

    function b64url(obj) {
      return btoa(JSON.stringify(obj)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }
    function makeToken(projectId, role) {
      var payload = {
        sub: '1',
        project_id: projectId,
        role: role || 'owner',
        scopes: role === 'admin_readonly'
          ? ['workspace:read', 'research:read']
          : ['research:read', 'research:write'],
        exp: Math.floor(Date.now() / 1000) + 86400,
      };
      return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url(payload) + '.synthetic-signature';
    }
    function postToken(projectId, role) {
      var iframe = document.getElementById('app');
      if (!iframe || !iframe.contentWindow || !window.__hostLastHandshake) return false;
      var effectiveRole = role || window.__hostInitialRole || 'owner';
      var base = {
        schema: 'research-v0',
        channel: window.__hostLastHandshake.channel,
        nonce: window.__hostLastHandshake.nonce,
      };
      var name = PROJECT_NAMES[projectId] || '[synthetic] Project ' + String(projectId);
      iframe.contentWindow.postMessage(
        Object.assign({}, base, {
          type: 'token',
          token: makeToken(projectId, effectiveRole),
          expires_at: Date.now() + 3600 * 1000,
          project: { name: name },
        }),
        CHILD_ORIGIN,
      );
      iframe.contentWindow.postMessage(
        Object.assign({}, base, { type: 'theme', theme: 'light' }),
        CHILD_ORIGIN,
      );
      window.__hostTokenCount += 1;
      var label = document.getElementById('host-project');
      if (label) label.textContent = projectId;
      var roleLabel = document.getElementById('host-role');
      if (roleLabel) roleLabel.textContent = effectiveRole;
      console.log('[synthetic-host] token sent project=' + projectId + ' role=' + effectiveRole + ' index=' + window.__hostTokenCount);
      return true;
    }
    // Documented harness dev hook: switch project/role through the real host
    // contract path (token re-post on the same channel/nonce).
    window.__hostSendToken = function (projectId, role) {
      if (!window.__hostLastHandshake) return { ok: false, reason: 'no_handshake' };
      var sent = postToken(String(projectId), role ? String(role) : undefined);
      return sent
        ? { ok: true, projectId: String(projectId), role: role || window.__hostInitialRole || 'owner', tokenIndex: window.__hostTokenCount }
        : { ok: false, reason: 'post_failed' };
    };

    window.addEventListener('message', function (event) {
      var iframe = document.getElementById('app');
      if (!iframe) return;
      var data = event.data || {};
      console.log('[synthetic-host] message', event.origin, JSON.stringify(data).slice(0, 160));
      if (event.origin !== CHILD_ORIGIN) return;
      if (event.source !== iframe.contentWindow) return;
      if (data.schema !== 'research-v0') return;
      if (data.type !== 'ready') return;
      // The iframe generates a fresh channel/nonce per session (including after
      // a full host reload); remember it so the dev hook can re-post a token.
      window.__hostLastHandshake = { channel: data.channel, nonce: data.nonce };
      window.__hostLastHandshakeAt = Date.now();
      postToken('p1');
      console.log('[synthetic-host] handshake stored + p1 token sent to', CHILD_ORIGIN);
    });
  })();
</script>
</head>
<body>
<div id="hostbar" role="note">
  <span class="tag">synthetic harness</span>
  <span>RDLens host contract v0 · issue #1134 note-delete visual evidence</span>
  <span>· iframe /research?legacy=1</span>
  <span>· synthetic project: <b id="host-project">p1</b></span>
  <span>· role: <b id="host-role">owner</b></span>
  <span>· no real data / no model calls</span>
</div>
<iframe id="app" title="research workspace" src="${iframeUrl}"></iframe>
<script>
  (function () {
    // ?role=admin_readonly selects the initial synthetic identity (E7).
    try {
      var params = new URLSearchParams(window.location.search);
      window.__hostInitialRole = params.get('role') === 'admin_readonly' ? 'admin_readonly' : 'owner';
    } catch (e) {
      window.__hostInitialRole = 'owner';
    }
    var roleLabel = document.getElementById('host-role');
    if (roleLabel) roleLabel.textContent = window.__hostInitialRole;
  })();
</script>
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
      `host page (#1134): http://127.0.0.1:${port}/ (iframe ${iframeUrl}, parent origin ${parentOrigin})`,
    )
  })
