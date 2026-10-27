/**
 * Vite 插件：把本地后端（批次生图 / 质检 / 重复度 / 图库）直接挂到 dev server 上，
 * 这样只跑 `npm run dev` 一个进程、只开 5173 一个端口，前端用同源的 /api 调用，不用再单独起 7799。
 */
/** 需要转给后端的路径前缀 */
const SIDECAR_PREFIXES = ['/api/', '/img', '/clientimg'];

function isSidecarPath(pathname) {
  return SIDECAR_PREFIXES.some((prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix));
}

export default function sidecarPlugin() {
  return {
    name: 'gpt-image-sidecar',
    async configureServer(server) {
      // 后端代码都走动态 import：静态 import 会被 esbuild 打进 vite.config 的 bundle，
      // 而 cli 下的脚本带 shebang、依赖 python 和 sqlite，不适合被打包
      const [{ inspect, readJsonBody, sendJson }, sidecar] = await Promise.all([
        import(new URL('./inspect.mjs', import.meta.url).href),
        import(new URL('../cli/app/server.mjs', import.meta.url).href),
      ]);
      const api = sidecar.default;

      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0];

        // 合成后的检查接口：一次返回质检 + 重复度，走自己的实现
        if (pathname === '/api/inspect' && req.method === 'POST') {
          readJsonBody(req)
            .then(async (body) => {
              const result = await inspect(body?.items, {
                expect: body?.expect,
                limit: body?.limit,
                qc: body?.qc,
                sim: body?.sim,
              });
              sendJson(res, 200, result);
            })
            .catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
          return;
        }

        // 远程图片代理：灵境的 logo 放在腾讯云 COS 上，那个桶没配 CORS，
        // 浏览器直连必被拦。dev 里由 node 侧转发一次，网页版也能把 logo 存成 dataURL。
        // 只放行图片响应，避免变成任何人都能用的开放代理
        if (pathname === '/__imgproxy' && req.method === 'GET') {
          const target = new URL(req.url || '', 'http://localhost').searchParams.get('url') || '';
          if (!/^https?:\/\//i.test(target)) {
            res.statusCode = 400;
            res.end('bad url');
            return;
          }
          fetch(target)
            .then(async (upstream) => {
              const type = upstream.headers.get('content-type') || '';
              if (!upstream.ok || !type.startsWith('image/')) {
                res.statusCode = upstream.ok ? 415 : upstream.status;
                res.end('not an image');
                return;
              }
              res.setHeader('Content-Type', type);
              res.setHeader('Cache-Control', 'no-store');
              res.end(Buffer.from(await upstream.arrayBuffer()));
            })
            .catch(() => {
              res.statusCode = 502;
              res.end('upstream failed');
            });
          return;
        }

        if (isSidecarPath(pathname)) {
          api.emit('request', req, res);
          return;
        }

        next();
      });

      // eslint-disable-next-line no-console
      console.log('  本地后端已挂在 dev server 上（/api、/img、/clientimg），不再需要单独启动 7799');
    },
  };
}
