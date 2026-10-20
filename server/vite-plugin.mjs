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
