"""
接口连接层并发探测：阶梯爬坡地对 /v1/models 发并发请求，看多少开始被拒。

为什么只打 /models：
- 它不产生出图费用，也不扣额度；
- 昨天那批 488 条里，33~45 秒之间一次性没掉 151 条，报的全是
  「TLS 握手失败」「连接被服务器重置 (10054)」——这类错误发生在**建连接阶段**，
  和出图任务本身无关。所以只要测连接层就够了。

测的是：网关/中转站同时能接纳多少个连接。
测不出：上游 gpt-image-2 的 RPM 限流、出图任务排队，那些必须真发出图请求。

用法：
  python concurrency_probe.py
  python concurrency_probe.py --levels 5,10,20,40,80,120,200
"""

import argparse
import asyncio
import json
import sqlite3
import ssl
import time
from collections import Counter

import aiohttp

DB = r"C:/Users/admin/AppData/Local/GPT Image SOP/data/data.db"
DEFAULT_LEVELS = [5, 10, 20, 40, 80, 120, 200]


def load_config():
    """从客户端数据库读地址和密钥（只读打开，不动用户数据）"""
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    raw = conn.execute(
        "select value from kv where key='gpt-image-playground'"
    ).fetchone()[0]
    conn.close()
    settings = json.loads(raw)["state"]["settings"]
    return settings["baseUrl"].rstrip("/"), settings["apiKey"]


def classify(err):
    """把异常压成少数几类，方便统计时一眼看出是握手失败还是被限流"""
    text = f"{type(err).__name__}: {err}"
    low = text.lower()
    if isinstance(err, asyncio.TimeoutError):
        return "超时"
    if "ssl" in low or "certificate" in low or "handshake" in low:
        return "TLS 握手失败"
    if "cannot connect" in low or "connector" in low or "clientconnect" in low:
        return "连接被拒绝/重置"
    if "server disconnected" in low or "closed" in low:
        return "连接被服务器断开"
    return text[:60]


async def one_request(session, url, key):
    """单条轻量请求：只取响应头，不读 body 大小"""
    t0 = time.perf_counter()
    try:
        async with session.get(
            url,
            headers={"Authorization": f"Bearer {key}"},
        ) as resp:
            status = resp.status
            await resp.read()
            return {
                "ok": status == 200,
                "status": status,
                "ms": (time.perf_counter() - t0) * 1000,
                "err": None if status == 200 else f"HTTP {status}",
            }
    except Exception as err:  # noqa: BLE001 - 探测脚本要记录所有异常类型
        return {
            "ok": False,
            "status": None,
            "ms": (time.perf_counter() - t0) * 1000,
            "err": classify(err),
        }


async def probe_level(url, key, concurrency, timeout_s):
    """
    一次性把 concurrency 条请求全部并发发出（不设连接数上限），
    这样测到的才是「同时能接纳多少」，而不是被本地连接池限住。
    """
    timeout = aiohttp.ClientTimeout(total=timeout_s)
    conn = aiohttp.TCPConnector(limit=0, force_close=True)
    t0 = time.perf_counter()
    async with aiohttp.ClientSession(timeout=timeout, connector=conn) as sess:
        results = await asyncio.gather(
            *(one_request(sess, url, key) for _ in range(concurrency))
        )
    return results, (time.perf_counter() - t0) * 1000


def pct(values, p):
    if not values:
        return 0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(len(ordered) * p))
    return ordered[idx]


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--levels", default=",".join(str(n) for n in DEFAULT_LEVELS))
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--gap", type=float, default=3, help="每级之间的冷却秒数")
    args = parser.parse_args()
    levels = [int(x) for x in args.levels.split(",") if x.strip()]

    base, key = load_config()
    url = f"{base}/models"
    print(f"目标：{url}")
    print(f"策略：阶梯爬坡，每级一次性全部并发发出，级间隔 {args.gap}s\n")

    header = f"{'并发':>5} | {'成功':>5} | {'失败':>5} | {'成功率':>7} | {'总耗时':>8} | {'单条中位':>8} | {'单条最慢':>8} | 失败原因"
    print(header)
    print("-" * len(header))

    verdict = None
    for n in levels:
        results, total_ms = await probe_level(url, key, n, args.timeout)
        ok = sum(1 for r in results if r["ok"])
        fail = n - ok
        errs = Counter(r["err"] for r in results if not r["ok"])
        median = pct([r["ms"] for r in results], 0.5)
        slow = max(r["ms"] for r in results)
        reason = ", ".join(f"{k}×{v}" for k, v in errs.most_common()) or "-"
        print(
            f"{n:>5} | {ok:>5} | {fail:>5} | {ok / n:>6.0%} | "
            f"{total_ms:>7.0f}ms | {median:>6.0f}ms | {slow:>6.0f}ms | {reason}"
        )

        # 第一级开始大面积失败就停：再往上加只会加重对方的限流
        if verdict is None and fail > 0:
            verdict = (n, ok, fail, errs)
        if fail / n > 0.5:
            print("\n失败率超过 50%，停止爬坡（继续加压只会让服务器更长时间无法恢复）")
            break
        await asyncio.sleep(args.gap)

    print()
    if verdict is None:
        print(f"结论：到 {levels[-1]} 并发都没出现失败，上限高于 {levels[-1]}。")
    else:
        n, ok, fail, errs = verdict
        print(f"结论：{n} 并发时首次出现失败（成功 {ok} / 失败 {fail}）。")
        print(f"      失败类型：{dict(errs)}")
        print(f"      可用的安全并发建议取该值的 50~70%，即约 {int(n * 0.5)}~{int(n * 0.7)}。")


if __name__ == "__main__":
    asyncio.run(main())
