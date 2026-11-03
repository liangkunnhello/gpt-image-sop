"""
连接占用探测：同时建立 N 条 TLS 连接并**保持不放**，看多久开始被拒。

为什么需要这个（而不是只测 /models 能打多少并发）：
/models 几百毫秒就结束，连接随即释放。而这次故障里的出图请求要挂 **7 分钟**
（数据库里成功的 203 条平均 421 秒）。488 个请求同时挂住 7 分钟，
和 488 个请求 0.3 秒就散场，对网关的压力完全是两回事。

再叠加客户端的一个真实行为：`src-tauri/src/http.rs` 每次请求都新建 reqwest::Client
（为了代理/取消立即生效），意味着**没有连接池复用** —— 488 个请求就是 488 次完整 TLS 握手。
所以这里模拟的正是「N 个连接同时握手，然后一起挂住」。

不发出图请求、不扣任何额度：只完成 TCP + TLS 握手，不发 HTTP 报文。

用法：
  python hold_probe.py --levels 20,50,100,200 --hold 30
"""

import argparse
import asyncio
import json
import socket
import sqlite3
import ssl
import time
from collections import Counter
from urllib.parse import urlparse

DB = r"C:/Users/admin/AppData/Local/GPT Image SOP/data/data.db"


def load_host():
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
        return "握手超时"
    if "ssl" in low or "certificate" in low or "handshake" in low:
        return "TLS 握手失败"
    if "reset" in low or "aborted" in low or "10054" in low:
        return "连接被重置"
    if "refused" in low:
        return "连接被拒绝"
    return text[:50]


async def open_and_hold(host, port, ctx, hold_s):
    """建一条 TCP+TLS 连接，握完手就挂着，到时间再关"""
    t0 = time.perf_counter()
    writer = None
    try:
        reader, writer = await asyncio.open_connection(
            host, port, ssl=ctx, server_hostname=host
        )
        handshake_ms = (time.perf_counter() - t0) * 1000
        await asyncio.sleep(hold_s)
        return {"ok": True, "ms": handshake_ms, "err": None}
    except Exception as err:  # noqa: BLE001 - 探测要记录所有异常
        return {"ok": False, "ms": (time.perf_counter() - t0) * 1000, "err": classify(err)}
    finally:
        if writer is not None:
            writer.close()


async def probe_level(host, port, ctx, n, hold_s):
    t0 = time.perf_counter()
    results = await asyncio.gather(
        *(open_and_hold(host, port, ctx, hold_s) for _ in range(n))
    )
    return results, (time.perf_counter() - t0) * 1000


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--levels", default="20,50,100,200")
    parser.add_argument("--hold", type=float, default=30, help="每级连接保持秒数")
    parser.add_argument("--gap", type=float, default=5)
    args = parser.parse_args()
    levels = [int(x) for x in args.levels.split(",") if x.strip()]

    host, port = load_host()
    ctx = ssl.create_default_context()
    print(f"目标：{host}:{port}（只做 TLS 握手并保持 {args.hold}s，不发 HTTP 请求）\n")

    header = f"{'并发':>5} | {'断开前建成':>8} | {'失败':>5} | {'成功率':>7} | {'握手中位':>9} | {'握手最慢':>9} | 失败原因"
    print(header)
    print("-" * len(header))

    first_fail = None
    for n in levels:
        results, total_ms = await probe_level(host, port, ctx, n, args.hold)
        ok = sum(1 for r in results if r["ok"])
        fail = n - ok
        errs = Counter(r["err"] for r in results if not r["ok"])
        handshakes = sorted(r["ms"] for r in results if r["ok"])
        median = handshakes[len(handshakes) // 2] if handshakes else 0
        slow = handshakes[-1] if handshakes else 0
        reason = ", ".join(f"{k}×{v}" for k, v in errs.most_common()) or "-"
        print(
            f"{n:>5} | {ok:>8} | {fail:>5} | {ok / n:>6.0%} | "
            f"{median:>7.0f}ms | {slow:>7.0f}ms | {reason}"
        )

        if first_fail is None and fail > 0:
            first_fail = (n, ok, fail, errs)
        if fail / n > 0.5:
            print("\n失败率超过 50%，停止加压")
            break
        await asyncio.sleep(args.gap)

    print()
    if first_fail is None:
        print(f"结论：{levels[-1]} 条连接同时保持 {args.hold}s 也没被断开，连接层上限高于 {levels[-1]}。")
        print("      出图失败的瓶颈不在「同时连多少条」，而在别处（见报告）。")
    else:
        n, ok, fail, errs = first_fail
        print(f"结论：{n} 条同时保持时开始出问题（建成 {ok} / 失败 {fail}）。")
        print(f"      失败类型：{dict(errs)}")
        print(f"      建议单批上限取 50~70%：约 {int(n * 0.5)}~{int(n * 0.7)}。")


if __name__ == "__main__":
    asyncio.run(main())
