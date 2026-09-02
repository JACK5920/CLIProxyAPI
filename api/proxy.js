export const config = {
  runtime: 'edge',
  regions: ['sfo1', 'iad1'],
};

export default async function handler(request) {
  try {
    const url = new URL(request.url);

    let targetHost = 'generativelanguage.googleapis.com';
    if (url.pathname.includes('v1internal') || url.pathname.includes('loadCodeAssist')) {
      targetHost = 'cloudcode-pa.googleapis.com';
    }

    const targetUrl = new URL(url.pathname + url.search, `https://${targetHost}`);

    const headers = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (!lowerKey.startsWith('x-vercel-') && lowerKey !== 'x-real-ip' && lowerKey !== 'x-forwarded-for' && lowerKey !== 'host') {
        headers.set(key, value);
      }
    }
    headers.set('host', targetHost);

    const fetchOptions = {
      method: request.method,
      headers: headers,
      redirect: 'follow',
    };

    if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
      fetchOptions.body = request.body;
      fetchOptions.duplex = 'half';
    }

    const response = await fetch(targetUrl.toString(), fetchOptions);

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
    return new Response(JSON.stringify({ 
      error: error.message, 
      stack: error.stack,
      hint: "Vercel Edge Proxy Internal Error" 
    }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
