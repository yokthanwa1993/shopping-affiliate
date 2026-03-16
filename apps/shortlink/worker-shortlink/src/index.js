export { BridgeDO } from './BridgeDO.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const account = getAccountKey(url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === '/__agent__') {
      return new Response(agentHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
      });
    }

    if (!account) {
      return json({ error: 'account param required' }, 400, CORS);
    }

    const id = env.BRIDGE.idFromName(account);
    const bridge = env.BRIDGE.get(id);
    const resp = await bridge.fetch(request);

    if (resp.status === 101) return resp;

    const headers = new Headers(resp.headers);
    Object.entries(CORS).forEach(([k, v]) => headers.set(k, v));
    return new Response(resp.body, { status: resp.status, headers });
  },
};

function getAccountKey(url) {
  const account = (url.searchParams.get('account') || '').trim().toLowerCase();
  if (!account) return '';
  if (!/^[a-z0-9_-]{1,64}$/.test(account)) return '';
  return account;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function agentHtml() {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><title>Shopee Shortlink Agent</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#111;color:#eee;padding:24px;margin:0}
  h2{color:#EE4D2D;margin:0 0 4px}.sub{color:#666;font-size:13px;margin-bottom:20px}
  .status{display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:14px}
  .dot{width:10px;height:10px;border-radius:50%;background:#666}
</style></head>
<body>
  <h2>Shopee Shortlink Agent</h2>
  <div class="sub">Keep this worker connected to a dedicated Electron runtime.</div>
</body></html>`;
}
