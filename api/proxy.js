// ============================================================
// Google API 三协议万能网关（Vercel Edge 版）
// 支持：
//   1. OpenAI Chat Completions (/v1/chat/completions)
//   2. OpenAI Responses (/v1/responses)
//   3. Anthropic Messages (/v1/messages)
//   4. Gemini 原生透明转发 (/v1beta/...)
// ============================================================
export const config = { runtime: 'edge' };

const GL_HOST = 'generativelanguage.googleapis.com';
const CLOUDCODE_HOST = 'cloudcode-pa.googleapis.com';

function extractKey(request, url) {
  const auth = request.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const goog = request.headers.get('x-goog-api-key');
  if (goog) return goog.trim();
  const ak = request.headers.get('x-api-key');
  if (ak) return ak.trim();
  return url.searchParams.get('key') || '';
}

function buildContents(messages) {
  const systemTexts = [];
  const contents = [];
  for (const m of messages || []) {
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
  return out;
}

const FINISH_MAP = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter' };

function geminiToOpenAI(gem, model) {
  const cand = (gem.candidates && gem.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.map((p) => p.text || '').join('');
  const u = gem.usageMetadata || {};
  return {
    id: 'chatcmpl-' + Math.random().toString(36).slice(2),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: FINISH_MAP[cand.finishReason] || 'stop' }],
    usage: { prompt_tokens: u.promptTokenCount || 0, completion_tokens: u.candidatesTokenCount || 0, total_tokens: u.totalTokenCount || 0 },
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

function geminiToResponses(gem, model, respId) {
  const cand = (gem.candidates && gem.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.map((p) => p.text || '').join('');
  const u = gem.usageMetadata || {};
  return {
    id: respId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [{ type: 'message', id: 'msg_' + Math.random().toString(36).slice(2), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: u.promptTokenCount || 0, output_tokens: u.candidatesTokenCount || 0, total_tokens: u.totalTokenCount || 0 },
  };
}

function geminiToAnthropic(gem, model) {
  const cand = (gem.candidates && gem.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.map((p) => p.text || '').join('');
  const u = gem.usageMetadata || {};
  return {
    id: 'msg_' + Math.random().toString(36).slice(2),
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: cand.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: u.promptTokenCount || 0, output_tokens: u.candidatesTokenCount || 0 },
  };
}

function jsonHeaders() {
  return new Headers({ 'content-type': 'application/json', 'access-control-allow-origin': '*' });
}

async function callGemini(model, gemBody, stream, key) {
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  const targetUrl = new URL(`https://${GL_HOST}/v1beta/models/${encodeURIComponent(model)}:${method}`);
  targetUrl.searchParams.set('key', key);
  if (stream) targetUrl.searchParams.set('alt', 'sse');
  return fetch(targetUrl.toString(), {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(gemBody),
  });
}

export default async function handler(request) {
  const url = new URL(request.url);
  const key = extractKey(request, url);
  const path = url.pathname;

  if (path === '/' || path === '') {
    return new Response(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#fff;text-align:center;padding:50px;">
<h1 style="color:#38bdf8;">⚡ Universal AI Gateway</h1>
<p style="color:#94a3b8;">Chat Completions + Responses + Anthropic Messages + Gemini</p></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
  }

  try {
    // /v1/models
    if (path === '/v1/models' || path === '/models') {
      const upstream = await fetch(`https://${GL_HOST}/v1beta/models?pageSize=100&key=${encodeURIComponent(key)}`);
      const data = await upstream.json();
      if (!upstream.ok) return new Response(JSON.stringify(data), { status: upstream.status, headers: jsonHeaders() });
      const list = (data.models || []).map((m) => ({ id: (m.name || '').replace(/^models\//, ''), object: 'model', created: 0, owned_by: 'google' }));
      return new Response(JSON.stringify({ object: 'list', data: list }), { status: 200, headers: jsonHeaders() });
    }

    // 1. Chat Completions
    if (path.endsWith('/chat/completions')) {
      const body = await request.json();
      const model = body.model || 'gemini-flash-latest';
      const gemBody = buildContents(body.messages);
      if (body.temperature != null) gemBody.generationConfig = { ...(gemBody.generationConfig || {}), temperature: body.temperature };
      if (body.max_tokens != null) gemBody.generationConfig = { ...(gemBody.generationConfig || {}), maxOutputTokens: body.max_tokens };
      const stream = !!body.stream;

      const upstream = await callGemini(model, gemBody, stream, key);
      if (!upstream.ok) {
        const errText = await upstream.text();
        return new Response(errText, { status: upstream.status, headers: jsonHeaders() });
      }
      if (!stream) {
        const gem = await upstream.json();
        return new Response(JSON.stringify(geminiToOpenAI(gem, model)), { status: 200, headers: jsonHeaders() });
      }
      // Stream
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffer = '';
      const readable = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(model, { role: 'assistant', content: '' }))}\n\n`));
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
                const text = (cand.content && cand.content.parts || []).map((p) => p.text || '').join('');
                if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(model, { content: text }))}\n\n`));
                if (cand.finishReason) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(model, {}, FINISH_MAP[cand.finishReason] || 'stop'))}\n\n`));
              } catch {}
            }
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(readable, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } });
    }

    // 2. Responses
    if (path.endsWith('/responses')) {
      const body = await request.json();
      const model = body.model || 'gemini-flash-latest';
      let messages = body.messages || [];
      if (!messages.length) {
        if (body.instructions) messages.push({ role: 'system', content: body.instructions });
        if (typeof body.input === 'string') messages.push({ role: 'user', content: body.input });
      }
      const gemBody = buildContents(messages);
      const stream = !!body.stream;
      const upstream = await callGemini(model, gemBody, stream, key);
      if (!upstream.ok) return new Response(await upstream.text(), { status: upstream.status, headers: jsonHeaders() });
      const respId = 'resp_' + Math.random().toString(36).slice(2);
      if (!stream) {
        const gem = await upstream.json();
        return new Response(JSON.stringify(geminiToResponses(gem, model, respId)), { status: 200, headers: jsonHeaders() });
      }
      // Responses stream simple fallback to non-stream JSON for Edge brevity
      const gem = await upstream.json();
      return new Response(JSON.stringify(geminiToResponses(gem, model, respId)), { status: 200, headers: jsonHeaders() });
    }

    // 3. Anthropic Messages
    if (path.endsWith('/messages') || path === '/v1/messages') {
      const body = await request.json();
      const model = body.model || 'gemini-flash-latest';
      const gemBody = buildContents(body.messages);
      if (body.system) gemBody.systemInstruction = { parts: [{ text: typeof body.system === 'string' ? body.system : JSON.stringify(body.system) }] };
      if (body.max_tokens != null) gemBody.generationConfig = { ...(gemBody.generationConfig || {}), maxOutputTokens: body.max_tokens };
      const stream = !!body.stream;
      const upstream = await callGemini(model, gemBody, stream, key);
      if (!upstream.ok) return new Response(await upstream.text(), { status: upstream.status, headers: jsonHeaders() });
      const gem = await upstream.json();
      return new Response(JSON.stringify(geminiToAnthropic(gem, model)), { status: 200, headers: jsonHeaders() });
    }

    // 4. Gemini 原生透明转发
    let targetHost = GL_HOST;
    if (path.includes('v1internal') || path.includes('loadCodeAssist')) targetHost = CLOUDCODE_HOST;
    const targetUrl = new URL(path + url.search, `https://${targetHost}`);
    if (key && !url.searchParams.has('key')) targetUrl.searchParams.set('key', key);
    const forwardHeaders = new Headers();
    for (const [k, v] of request.headers.entries()) {
      const lk = k.toLowerCase();
      if (!lk.startsWith('x-vercel-') && !['host', 'authorization', 'x-goog-api-key', 'x-api-key', 'connection'].includes(lk)) {
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
    return new Response(upstreamResponse.body, { status: upstreamResponse.status, statusText: upstreamResponse.statusText, headers: outHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: err.message || String(err) } }), { status: 502, headers: jsonHeaders() });
  }
}
