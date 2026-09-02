// ============================================================
// Google API 三协议万能网关（Render Node 版）
// 支持：
//   1. OpenAI Chat Completions (/v1/chat/completions)
//   2. OpenAI Responses (/v1/responses)
//   3. Anthropic Messages (/v1/messages)
//   4. Gemini 原生协议透明转发 (/v1beta/...)
// 全部自动翻译成 Gemini generateContent / streamGenerateContent
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
  // Anthropic 用 x-api-key 头
  const ak = req.headers['x-api-key'];
  if (ak) return String(ak).trim();
  return url.searchParams.get('key') || '';
}

// ---------- 共用：把 messages 数组拆成 system 文本 + Gemini contents ----------
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
      // 兼容 multimodal 块：仅取文本部分
      text = m.content
        .map((c) => {
          if (typeof c === 'string') return c;
          if (c.type === 'text') return c.text || '';
          return '';
        })
        .join('\n');
    }
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  const out = { contents };
  if (systemTexts.length) out.systemInstruction = { parts: [{ text: systemTexts.join('\n') }] };
  return out;
}

const FINISH_MAP = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter' };
const STOP_MAP = { stop: 'STOP', length: 'MAX_TOKENS', content_filter: 'SAFETY' };

// ---------- OpenAI Chat Completions 响应 ----------
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
    choices: [
      { index: 0, message: { role: 'assistant', content: text }, finish_reason: FINISH_MAP[cand.finishReason] || 'stop' },
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

// ---------- OpenAI Responses 响应 ----------
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
    output: [
      {
        type: 'message',
        id: 'msg_' + Math.random().toString(36).slice(2),
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: u.promptTokenCount || 0,
      output_tokens: u.candidatesTokenCount || 0,
      total_tokens: u.totalTokenCount || 0,
    },
  };
}

function respChunk(model, respId, deltaText, eventType) {
  return {
    type: eventType || 'response.output_text.delta',
    item_id: 'msg_' + Math.random().toString(36).slice(2),
    output_index: 0,
    content_index: 0,
    delta: deltaText,
  };
}

// ---------- Anthropic Messages 响应 ----------
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

function anthropicChunk(model, text, isStop) {
  if (isStop) {
    return {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    };
  }
  return { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// 调用 Gemini（统一入口），返回 upstream Response
async function callGemini(model, gemBody, stream, key) {
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  const targetUrl = new URL(`https://${GL_HOST}/v1beta/models/${encodeURIComponent(model)}:${method}`);
  if (key) targetUrl.searchParams.set('key', key);
  if (stream) targetUrl.searchParams.set('alt', 'sse');
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-goog-api-key'] = key;
  return fetch(targetUrl.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(gemBody),
  });
}

async function upstreamError(upstream, res) {
  const errText = await upstream.text();
  let msg = errText;
  try { msg = JSON.parse(errText).error?.message || errText; } catch {}
  res.writeHead(upstream.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: msg, type: 'upstream_error', code: upstream.status } }));
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

  if (path === '/' || path === '') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#fff;text-align:center;padding:50px;">
<h1 style="color:#10b981;">⚡ Universal AI Gateway Active!</h1>
<p style="color:#94a3b8;">Chat Completions + Responses + Anthropic Messages + Gemini 原生 · 四协议 · US Oregon</p></body></html>`
    );
  }

  try {
    // ============ 模型列表（OpenAI 风格） ============
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

    // ============ 1. OpenAI Chat Completions ============
    if (path.endsWith('/chat/completions')) {
      const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
      const model = body.model || 'gemini-flash-latest';
      const gemBody = buildContents(body.messages);
      if (body.temperature != null) gemBody.generationConfig = { ...(gemBody.generationConfig || {}), temperature: body.temperature };
      if (body.max_tokens != null) gemBody.generationConfig = { ...(gemBody.generationConfig || {}), maxOutputTokens: body.max_tokens };
      const stream = !!body.stream;

      const upstream = await callGemini(model, gemBody, stream, key);
      setCors();
      if (!upstream.ok) return upstreamError(upstream, res);

      if (!stream) {
        const gem = await upstream.json();
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(geminiToOpenAI(gem, model)));
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(chunk(model, { role: 'assistant', content: '' }))}\n\n`);
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
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
            if (text) res.write(`data: ${JSON.stringify(chunk(model, { content: text }))}\n\n`);
            if (cand.finishReason) {
              res.write(`data: ${JSON.stringify(chunk(model, {}, FINISH_MAP[cand.finishReason] || 'stop'))}\n\n`);
            }
          } catch {}
        }
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ============ 2. OpenAI Responses ============
    if (path.endsWith('/responses')) {
      const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
      const model = body.model || 'gemini-flash-latest';
      // Responses 的 input 可以是字符串或 messages 数组
      let messages = body.messages;
      if (!messages) {
        messages = [];
        if (body.instructions) messages.push({ role: 'system', content: body.instructions });
        if (typeof body.input === 'string') messages.push({ role: 'user', content: body.input });
        else if (Array.isArray(body.input)) {
          for (const item of body.input) {
            if (item.type === 'message' || item.role) {
              let contentText = '';
              if (typeof item.content === 'string') contentText = item.content;
              else if (Array.isArray(item.content)) {
                contentText = item.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n');
              }
              messages.push({ role: item.role || 'user', content: contentText });
            }
          }
        }
      }
      const gemBody = buildContents(messages);
      const stream = !!body.stream;
      const upstream = await callGemini(model, gemBody, stream, key);
      setCors();
      if (!upstream.ok) return upstreamError(upstream, res);

      const respId = 'resp_' + Math.random().toString(36).slice(2);

      if (!stream) {
        const gem = await upstream.json();
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(geminiToResponses(gem, model, respId)));
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ type: 'response.created', response: { id: respId, status: 'in_progress', model } });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
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
            if (text) send(respChunk(model, respId, text));
            if (cand.finishReason) send({ type: 'response.completed', response: { id: respId, status: 'completed', model } });
          } catch {}
        }
      }
      return res.end();
    }

    // ============ 3. Anthropic Messages ============
    if (path.endsWith('/messages') || path === '/v1/messages') {
      const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
      const model = body.model || 'gemini-flash-latest';
      const messages = (body.messages || []).map((m) => ({ role: m.role, content: m.content }));
      const gemBody = buildContents(messages);
      if (body.system) {
        const sys = typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
        gemBody.systemInstruction = { parts: [{ text: sys }] };
      }
      if (body.max_tokens != null) gemBody.generationConfig = { ...(gemBody.generationConfig || {}), maxOutputTokens: body.max_tokens };
      if (body.temperature != null) gemBody.generationConfig = { ...(gemBody.generationConfig || {}), temperature: body.temperature };
      const stream = !!body.stream;

      const upstream = await callGemini(model, gemBody, stream, key);
      setCors();
      if (!upstream.ok) return upstreamError(upstream, res);

      if (!stream) {
        const gem = await upstream.json();
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(geminiToAnthropic(gem, model)));
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_' + Math.random().toString(36).slice(2), type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
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
            if (text) res.write(`data: ${JSON.stringify(anthropicChunk(model, text, false))}\n\n`);
            if (cand.finishReason) {
              res.write(`data: ${JSON.stringify(anthropicChunk(model, '', true))}\n\n`);
              res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
              res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            }
          } catch {}
        }
      }
      return res.end();
    }

    // ============ 4. Gemini 原生透明转发 ============
    let targetHost = GL_HOST;
    if (path.includes('v1internal') || path.includes('loadCodeAssist')) targetHost = CLOUDCODE_HOST;

    const targetUrl = new URL(path + url.search, `https://${targetHost}`);
    if (key && !url.searchParams.has('key')) targetUrl.searchParams.set('key', key);

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (['host', 'authorization', 'x-goog-api-key', 'x-api-key', 'connection', 'content-length'].includes(lk)) continue;
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
  console.log(`Universal AI Gateway (4-protocol) listening on port ${PORT}`);
});
