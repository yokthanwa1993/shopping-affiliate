export { BridgeDO } from './BridgeDO.js';

function normalizeShopeeUrl(url) {
  const match = url.match(/[-.\/]i\.(\d+)\.(\d+)/);
  if (match) return `https://shopee.co.th/i-i.${match[1]}.${match[2]}`;
  return url;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // Agent page — extension เปิดค้างไว้
    if (url.pathname === '/__agent__') {
      return new Response(agentHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
      });
    }

    // Route ทุก request ผ่าน BridgeDO singleton
    const id = env.BRIDGE.idFromName('singleton');
    const bridge = env.BRIDGE.get(id);
    const resp = await bridge.fetch(request);

    // WebSocket upgrade (101) ต้อง pass-through ตรงๆ ห่อไม่ได้
    if (resp.status === 101) return resp;

    const headers = new Headers(resp.headers);
    Object.entries(CORS).forEach(([k, v]) => headers.set(k, v));
    return new Response(resp.body, { status: resp.status, headers });
  },
};

function agentHtml() {
  return `<!DOCTYPE html><html lang="th">
<head><meta charset="UTF-8"><title>Shopee Shortlink Agent</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#111;color:#eee;padding:24px;margin:0}
  h2{color:#EE4D2D;margin:0 0 4px}.sub{color:#666;font-size:13px;margin-bottom:20px}
  .status{display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:14px}
  .dot{width:10px;height:10px;border-radius:50%;background:#666}
  .dot.green{background:#4caf50} .dot.yellow{background:#ff9800} .dot.red{background:#f44336}
  #log{font-size:12px;font-family:monospace;color:#aaa;max-height:400px;overflow-y:auto}
  .ok{color:#4caf50} .err{color:#f44336}
</style></head>
<body>
  <h2>Shopee Shortlink Agent</h2>
  <div class="sub">เปิดหน้านี้ค้างไว้เพื่อรับงาน</div>
  <div class="status"><div class="dot" id="dot"></div><span id="statusText">กำลังเชื่อมต่อ...</span></div>
  <div id="log"></div>
</body></html>`;
}
