"""
代理链路探测：经由本地代理（默认 127.0.0.1:7897）建连接并保持，看多少开始握手失败。

为什么必须单独测这一层：
- 客户端 `proxyMode` 为空 -> 跟随系统代理（`src-tauri/src/proxy.rs` 的 Route::System）；
- 本机系统代理是 127.0.0.1:7897，且正在监听；
- 这次故障里 116 条「TLS 握手失败」+ 35 条「连接被重置」都发生在**建连接阶段**，
  而直连探测 120 并发 / 100 条保持连接全部通过 —— 差别就在中间那个代理。

Clash 类工具对同时建立的连接数、以及每条连接的握手时长都有限制，
超了会直接掐断，表现就是客户端看到的 TLS 握手失败 / 10054。

不发 HTTP 请求、不扣额度：只经代理做 CONNECT 隧道 + TLS 握手，然后保持。

用法：
  python proxy_probe.py --levels 20,50,100,200 --hold 20
  python proxy_probe.py --levels 10,20,30 --hold 45   # 模拟出图那种长时间占用
"""

import argparse
import asyncio
import json
import sqlite3
import ssl
import time
from collections import Counter
from urllib.parse import urlparse

DB = r"C:/Users/admin/AppData/Local/GPT Image SOP/data/data.db"


def load_target():
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    raw = conn.execute(
        "select value from kv where key='gpt-image-playground'"
    ).fetchone()[0]
    conn.close()
    parsed = urlparse(json.loads(raw)["state"]["settings"]["baseUrl"])
    return parsed.hostname, parsed.port or 443


def classify(err):
    text = f"{type(err).__name__}: {err}"
    low = text.lower()
    if isinstance(err, asyncio.TimeoutError):
        return "超时"
    if "ssl" in low or "certificate" in low or "handshake" in low:
        return "TLS 握手失败"
    if "reset" in low or "aborted" in low or "10054" in low:
        return "连接被重置"
    if "refused" in low:
        return "代理拒绝连接"
    if "connect" in low:
        return "CONNECT 隧道失败"
    return text[:50]


async def open_tunnel(proxy_host, proxy_port, host, port, ctx, hold_s):
    """
    完整复刻客户端的一次请求建链过程：
      1) 连本地代理
      2) 发 CONNECT host:port 让代理打隧道
      3) 在隧道上做 TLS 握手（客户端是 rustls，这里用系统 ssl）
      4) 握手成功后挂住 hold_s 秒（模拟出图请求占着连接）
    """
    t0 = time.perf_counter()
    writer = None
    try:
        reader, writer = await asyncio.open_connection(proxy_host, proxy_port)
        writer.write(
            f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode()
        )
        await writer.drain()
        # 读代理返回的 CONNECT 响应头（以空行结束）
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=20)
            if not line:
                raise ConnectionError("代理在 CONNECT 阶段关闭了连接")
            if line in (b"\r\n", b"\n"):
                break
        connect_ms = (time.perf_counter() - t0) * 1000

        # 把已建立的明文连接升级成 TLS（等价于客户端在隧道上握手）
        loop = asyncio.get_running_loop()
        transport = writer.transport
        new_transport = await loop.start_tls(
            transport, transport.get_protocol(), ctx, server_hostname=host
        )
        writer._transport = new_transport  # noqa: SLF001 - 探测脚本，仅为保持引用
        handshake_ms = (time.perf_counter() - t0) * 1000
        await asyncio.sleep(hold_s)
        return {"ok": True, "connect_ms": connect_ms, "handshake_ms": handshake_ms, "err": None}
    except Exception as err:  # noqa: BLE001 - 探测要记录所有异常
        return {
            "ok": False,
            "connect_ms": None,
            "handshake_ms": (time.perf_counter() - t0) * 1000,
            "err": classify(err),
        }
    finally:
        if writer is not None:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass


async def probe_level(proxy, host, port, ctx, n, hold_s):
    t0 = time.perf_counter()
    results = await asyncio.gather(
        *(open_tunnel(proxy[0], proxy[1], host, port, ctx, hold_s) for _ in range(n))
    )
    return results, (time.perf_counter() - t0) * 1000


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default="127.0.0.1:7897")
    parser.add_argument("--levels", default="20,50,100,200")
    parser.add_argument("--hold", type=float, default=20)
    parser.add_argument("--gap", type=float, default=5)
    args = parser.parse_args()
    levels = [int(x) for x in args.levels.split(",") if x.strip()]
    phost, pport = args.proxy.split(":")
    pport = int(pport)

    host, port = load_target()
    ctx = ssl.create_default_context()
    print(f"代理：{args.proxy}")
    print(f"目标：{host}:{port}（经代理 CONNECT + TLS，握手后保持 {args.hold}s，不发 HTTP）\n")

    header = (
        f"{'并发':>5} | {'隧道建成':>8} | {'失败':>5} | {'成功率':>7} | "
        f"{'CONNECT中位':>11} | {'握手中位':>9} | 失败原因"
    )
    print(header)
    print("-" * len(header))

    first_fail = None
    for n in levels:
        results, _total = await probe_level((phost, pport), host, port, ctx, n, args.hold)
        ok = sum(1 for r in results if r["ok"])
        fail = n - ok
        errs = Counter(r["err"] for r in results if not r["ok"])
        connects = sorted(r["connect_ms"] for r in results if r["ok"] and r["connect_ms"])
        hands = sorted(r["handshake_ms"] for r in results if r["ok"])
        c_med = connects[len(connects) // 2] if connects else 0
        h_med = hands[len(hands) // 2] if hands else 0
        reason = ", ".join(f"{k}×{v}" for k, v in errs.most_common()) or "-"
        print(
            f"{n:>5} | {ok:>8} | {fail:>5} | {ok / n:>6.0%} | "
            f"{c_med:>9.0f}ms | {h_med:>7.0f}ms | {reason}"
        )

        if first_fail is None and fail > 0:
            first_fail = (n, ok, fail, errs)
        if fail / n > 0.5:
            print("\n失败率超过 50%，停止加压")
            break
        await asyncio.sleep(args.gap)

    print()
    if first_fail is None:
        print(f"结论：经代理到 {levels[-1]} 条并发保持 {args.hold}s 全部建成，代理这一层没到上限。")
    else:
        n, ok, fail, errs = first_fail
        print(f"结论：经代理 {n} 条同时保持时开始失败（建成 {ok} / 失败 {fail}）。")
        print(f"      失败类型：{dict(errs)}")
        print(f"      单批上限建议取 50~70%：约 {int(n * 0.5)}~{int(n * 0.7)}。")


if __name__ == "__main__":
    asyncio.run(main())
