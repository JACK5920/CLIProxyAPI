// ============================================================
// Google API 万能网关（Vercel Edge 版）
// 支持 3 种用法：
//   1. Gemini 原生协议：/v1beta/models/xxx:generateContent（透明转发）
//   2. OpenAI 协议：    /v1/chat/completions（自动翻译成 Gemini 调用）
//   3. OpenAI 模型列表：/v1/models（自动翻译）
// ============================================================
export const config = {
  runtime: 'edge',
};

const GL_HOST = 'generativelanguage.googleapis.com';
const CLOUDCODE_HOST = 'cloudcode-pa.googleapis.com';

// ---------- 工具：提取 API Key ----------
function extractKey(request, url) {
  const auth = request.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const goog = request.headers.get('x-goog-api-key');
  if (goog) return goog.trim();
  return url.searchParams.get('key') || '';
}

// ---------- 工具：OpenAI messages -> Gemini contents ----------
function openAIToGemini(body) {
  const systemTexts = [];
  const contents = [];
  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      systemTexts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n');
    }
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  const out = { contents };
  if (systemTexts.length) out.systemInstruction = { parts: [{ text: systemTexts.join('\n') }] };
  const gen = {};
  if (body.temperature != null) gen.temperature = body.temperature;
  if (body.top_p != null) gen.topP = body.top_p;
  if (body.max_tokens != null) gen.maxOutputTokens = body.max_tokens;
  if (Object.keys(gen).length) out.generationConfig = gen;
  return out;
}

// ---------- 工具：Gemini 响应 -> OpenAI 响应（非流式） ----------
function geminiToOpenAI(gem, model) {
  const cand = (gem.candidates && gem.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.map((p) => p.text || '').join('');
  const finishMap = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter' };
  const u = gem.usageMetadata || {};
  return {
    id: 'chatcmpl-' + Math.random().toString(36).slice(2),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: finishMap[cand.finishReason] || 'stop',
      },
    ],
    usage: {
      prompt_tokens: u.promptTokenCount || 0,
      completion_tokens: u.candidatesTokenCount || 0,
      total_tokens: u.totalTokenCount || 0,
    },
  };
}

function chunk(model, delta, finish) {
  return {
    id: 'chatcmpl-' + Math.random().toString(36).slice(2),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  };
}

function jsonHeaders(extra) {
  const h = new Headers(extra || {});
  h.set('content-type', 'application/json');
  return h;
}

// ---------- 主处理 ----------
export default async function handler(request) {
  const url = new URL(request.url);
  const key = extractKey(request, url);
  const path = url.pathname;

  // 根路径状态页
  if (path === '/' || path === '') {
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Universal AI Gateway</title></head>
<body style="font-family:sans-serif;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="background:#1e293b;padding:30px;border-radius:12px;border:1px solid #334155;text-align:center;max-width:640px;">
<h1 style="color:#38bdf8;margin:0 0 10px;">⚡ 万能 AI 网关运行中</h1>
<p style="color:#94a3b8;margin:0 0 16px;">双协议支持：OpenAI (/v1/chat/completions) + Gemini (/v1beta)</p>
<div style="background:#090d16;padding:12px;border-radius:8px;font-family:monospace;color:#10b981;">${url.origin}</div>
</div></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
  }

  try {
    // ============ OpenAI 兼容：/v1/models ============
    if (path === '/v1/models' || path === '/models') {
      const upstream = await fetch(`https://${GL_HOST}/v1beta/models?pageSize=100&key=${encodeURIComponent(key)}`);
      const data = await upstream.json();
      if (!upstream.ok) return new Response(JSON.stringify(data), { status: upstream.status, headers: jsonHeaders() });
      const list = (data.models || []).map((m) => ({
        id: (m.name || '').replace(/^models\//, ''),
        object: 'model',
        created: 0,
        owned_by: 'google',
        display_name: m.displayName,
      }));
      return new Response(JSON.stringify({ object: 'list', data: list }), { status: 200, headers: jsonHeaders() });
    }

    // ============ OpenAI 兼容：/v1/chat/completions ============
    if (path.endsWith('/chat/completions')) {
      const body = await request.json();
      const model = body.model || 'gemini-flash-latest';
      const gemBody = openAIToGemini(body);
      const stream = !!body.stream;
      const method = stream ? 'streamGenerateContent' : 'generateContent';
      const targetUrl = new URL(`https://${GL_HOST}/v1beta/models/${encodeURIComponent(model)}:${method}`);
      targetUrl.searchParams.set('key', key);
      if (stream) targetUrl.searchParams.set('alt', 'sse');
      const target = targetUrl.toString();

      const headers = new Headers({ 'content-type': 'application/json' });
      const upstream = await fetch(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(gemBody),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        let msg = errText;
        try { msg = JSON.parse(errText).error?.message || errText; } catch {}
        return new Response(
          JSON.stringify({ error: { message: msg, type: 'upstream_error', code: upstream.status } }),
          { status: upstream.status, headers: jsonHeaders() }
        );
      }

      if (!stream) {
        const gem = await upstream.json();
        return new Response(JSON.stringify(geminiToOpenAI(gem, model)), { status: 200, headers: jsonHeaders() });
      }

      // 流式：Gemini SSE -> OpenAI SSE
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = '';
      let sentRole = false;
      const readable = new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk(model, { role: 'assistant', content: '' }))}\n\n`)
          );
          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const payload = t.slice(5).trim();
              if (!payload) continue;
              try {
                const gem = JSON.parse(payload);
                const cand = (gem.candidates && gem.candidates[0]) || {};
                const parts = (cand.content && cand.content.parts) || [];
                const text = parts.map((p) => p.text || '').join('');
                if (text) {
                  const c = chunk(model, { content: text });
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
                }
                if (cand.finishReason) {
                  const finishMap = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter' };
                  const c = chunk(model, {}, finishMap[cand.finishReason] || 'stop');
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
                }
              } catch {}
            }
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(readable, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      });
    }

    // ============ Gemini 原生协议：透明转发 ============
    let targetHost = GL_HOST;
    if (path.includes('v1internal') || path.includes('loadCodeAssist')) targetHost = CLOUDCODE_HOST;

    const targetUrl = new URL(path + url.search, `https://${targetHost}`);
    if (key && !url.searchParams.has('key')) {
      targetUrl.searchParams.set('key', key);
    }

    const forwardHeaders = new Headers();
    for (const [k, v] of request.headers.entries()) {
      const lk = k.toLowerCase();
      if (!lk.startsWith('x-vercel-') && lk !== 'host' && lk !== 'x-real-ip' && lk !== 'x-forwarded-for' && lk !== 'authorization' && lk !== 'x-goog-api-key') {
        forwardHeaders.set(k, v);
      }
    }
    if (path.includes('v1internal') && key) forwardHeaders.set('authorization', `Bearer ${key}`);

    const fetchInit = { method: request.method, headers: forwardHeaders, redirect: 'follow' };
    if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
      fetchInit.body = request.body;
      fetchInit.duplex = 'half';
    }

    const upstreamResponse = await fetch(targetUrl.toString(), fetchInit);
    const outHeaders = new Headers(upstreamResponse.headers);
    outHeaders.set('access-control-allow-origin', '*');
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: outHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: err.message || String(err) } }), {
      status: 502,
      headers: jsonHeaders(),
    });
  }
}
