export const config = {
  runtime: 'edge',
  regions: ['sfo1', 'iad1'], // 强制调度到美国旧金山/美东机房
};

export default async function handler(request) {
  const url = new URL(request.url);

  // 路由分流：
  // 1. Antigravity / Cloud Code (/v1internal) -> cloudcode-pa.googleapis.com
  // 2. Gemini API (/v1beta, /v1) -> generativelanguage.googleapis.com
  let targetHost = 'generativelanguage.googleapis.com';
  if (url.pathname.includes('/v1internal') || url.pathname.includes('loadCodeAssist')) {
    targetHost = 'cloudcode-pa.googleapis.com';
  }

  const targetUrl = new URL(url.pathname + url.search, `https://${targetHost}`);

  // 清洗客户端地域头，防止地理位置泄漏
  const headers = new Headers(request.headers);
  headers.set('host', targetHost);
  headers.delete('x-real-ip');
  headers.delete('x-forwarded-for');
  headers.delete('x-vercel-ip-country');
  headers.delete('x-vercel-ip-city');

  try {
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      duplex: 'half',
      redirect: 'follow',
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
