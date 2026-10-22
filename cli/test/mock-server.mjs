// 本地 mock OpenAI 兼容服务，用于离线联调 CLI（不产生真实费用）
// 用法：node test/mock-server.mjs [port]
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 18080);
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const readBody = (req) =>
  new Promise((res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks)));
  });

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const ct = req.headers['content-type'] || '';
  console.log(`[mock] ${req.method} ${req.url}  ct=${ct.split(';')[0]}  bytes=${body.length}`);

  const send = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.url.endsWith('/images/generations')) {
    const n = (() => {
      try {
        return JSON.parse(body.toString()).n || 1;
      } catch {
        return 1;
      }
    })();
    return send({ created: Date.now(), data: Array.from({ length: n }, () => ({ b64_json: PNG_1X1 })) });
  }

  if (req.url.endsWith('/images/edits')) {
    if (!ct.includes('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'edits 必须用 multipart/form-data' } }));
    }
    return send({ created: Date.now(), data: [{ b64_json: PNG_1X1 }] });
  }

  if (req.url.endsWith('/responses')) {
    return send({
      id: 'resp_mock',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'mock ok' }] },
        { type: 'image_generation_call', id: 'ig_1', result: PNG_1X1 },
      ],
    });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] listening http://127.0.0.1:${PORT}/v1`));
