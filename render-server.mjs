// ============================================================
// Google API 万能网关（Render Node 版）
// 与 Vercel 版逻辑一致：双协议支持
//   1. Gemini 原生协议透明转发
//   2. OpenAI /v1/chat/completions 自动翻译
//   3. OpenAI /v1/models 自动翻译
// ============================================================
import http from 'node:http';

const GL_HOST = 'generativelanguage.googleapis.com';
const CLOUDCODE_HOST = 'cloudcode-pa.googleapis.com';
const PORT = process.env.PORT || 80;

function extractKey(req, url) {
  const auth = req.headers['authorization'];
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const goog = req.headers['x-goog-api-key'];
  if (goog) return String(goog).trim();
  return url.searchParams.get('key') || '';
}

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
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content: text }, finish_reason: finishMap[cand.finishReason] || 'stop' },
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

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = extractKey(req, url);
  const path = url.pathname;

  const setCors = () => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', '*');
  };

  if (req.method === 'OPTIONS') {
    setCors();
    res.writeHead(204);
    return res.end();
  }

  // 根路径状态页
  if (path === '/' || path === '') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#fff;text-align:center;padding:50px;">
<h1 style="color:#10b981;">⚡ Universal AI Gateway Active!</h1>
<p style="color:#94a3b8;">OpenAI + Gemini 双协议 · US Oregon Data Center</p></body></html>`
    );
  }

  try {
    // ============ OpenAI: /v1/models ============
    if (path === '/v1/models' || path === '/models') {
      const upstream = await fetch(`https://${GL_HOST}/v1beta/models?pageSize=100&key=${encodeURIComponent(key)}`);
      const data = await upstream.json();
      setCors();
      if (!upstream.ok) {
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(data));
      }
      const list = (data.models || []).map((m) => ({
        id: (m.name || '').replace(/^models\//, ''),
        object: 'model',
        created: 0,
        owned_by: 'google',
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: list }));
    }

    // ============ OpenAI: /v1/chat/completions ============
    if (path.endsWith('/chat/completions')) {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf-8') || '{}');
      const model = body.model || 'gemini-flash-latest';
      const gemBody = openAIToGemini(body);
      const stream = !!body.stream;
      const method = stream ? 'streamGenerateContent' : 'generateContent';
      const targetUrl = new URL(`https://${GL_HOST}/v1beta/models/${encodeURIComponent(model)}:${method}`);
      targetUrl.searchParams.set('key', key);
      if (stream) targetUrl.searchParams.set('alt', 'sse');
      const target = targetUrl.toString();

      const upstream = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(gemBody),
      });

      setCors();
      if (!upstream.ok) {
        const errText = await upstream.text();
        let msg = errText;
        try { msg = JSON.parse(errText).error?.message || errText; } catch {}
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: msg, type: 'upstream_error', code: upstream.status } }));
      }

      if (!stream) {
        const gem = await upstream.json();
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(geminiToOpenAI(gem, model)));
      }

      // 流式转换
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(chunk(model, { role: 'assistant', content: '' }))}\n\n`);

      const decoder = new TextDecoder();
      let buffer = '';
      const reader = upstream.body.getReader();
      const sendChunk = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
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
            if (text) sendChunk(chunk(model, { content: text }));
            if (cand.finishReason) {
              const finishMap = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter' };
              sendChunk(chunk(model, {}, finishMap[cand.finishReason] || 'stop'));
            }
          } catch {}
        }
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ============ Gemini 原生：透明转发 ============
    let targetHost = GL_HOST;
    if (path.includes('v1internal') || path.includes('loadCodeAssist')) targetHost = CLOUDCODE_HOST;

    const targetUrl = new URL(path + url.search, `https://${targetHost}`);
    if (key && !url.searchParams.has('key')) targetUrl.searchParams.set('key', key);

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (['host', 'authorization', 'x-goog-api-key', 'connection', 'content-length'].includes(lk)) continue;
      headers[k] = v;
    }
    if (path.includes('v1internal') && key) headers['authorization'] = `Bearer ${key}`;

    const init = { method: req.method, headers, redirect: 'follow' };
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      init.body = await readBody(req);
    }

    const upstream = await fetch(targetUrl.toString(), init);
    setCors();
    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      if (!['transfer-encoding', 'content-encoding', 'connection'].includes(k.toLowerCase())) outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);

    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    return res.end();
  } catch (err) {
    setCors();
    res.writeHead(502, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: err.message || String(err) } }));
  }
});

server.listen(PORT, () => {
  console.log(`Universal AI Gateway listening on port ${PORT}`);
});
