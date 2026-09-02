export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  const url = new URL(request.url);

  // 1. 如果是直接在浏览器打开根路径，返回一个漂亮的健康检查面板
  if (url.pathname === '/' || url.pathname === '') {
    return new Response(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Edge Proxy Status</title></head>
<body style="font-family:sans-serif;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="background:#1e293b;padding:30px;border-radius:12px;border:1px solid #334155;text-align:center;">
    <h1 style="color:#38bdf8;margin:0 0 10px 0;">⚡ Google API Edge Proxy 运行正常</h1>
    <p style="color:#94a3b8;margin:0 0 20px 0;">节点已锁定 Vercel 美国机房 (sfo1) · 原生支持 Google Gemini & Antigravity</p>
    <div style="background:#090d16;padding:12px;border-radius:8px;font-family:monospace;color:#10b981;">
      Endpoint Ready: ${url.origin}
    </div>
  </div>
</body>
</html>`, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // 2. 路由分流
  let targetHost = 'generativelanguage.googleapis.com';
  if (url.pathname.includes('v1internal') || url.pathname.includes('loadCodeAssist')) {
    targetHost = 'cloudcode-pa.googleapis.com';
  }

  const targetUrl = new URL(url.pathname + url.search, `https://${targetHost}`);

  // 3. 构建请求头
  const forwardHeaders = new Headers();
  for (const [key, val] of request.headers.entries()) {
    const k = key.toLowerCase();
    if (!k.startsWith('x-vercel-') && k !== 'host' && k !== 'x-real-ip' && k !== 'x-forwarded-for') {
      forwardHeaders.set(key, val);
    }
  }
  forwardHeaders.set('host', targetHost);

  try {
    const fetchInit = {
      method: request.method,
      headers: forwardHeaders,
      redirect: 'follow',
    };

    if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
      fetchInit.body = request.body;
      fetchInit.duplex = 'half';
    }

    const upstreamResponse = await fetch(targetUrl.toString(), fetchInit);

    const outHeaders = new Headers(upstreamResponse.headers);
    outHeaders.set('access-control-allow-origin', '*');
    outHeaders.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
    outHeaders.set('access-control-allow-headers', '*');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: outHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
