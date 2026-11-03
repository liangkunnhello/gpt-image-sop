"""
在高并发下对比「每次新建客户端（无池）」与「复用客户端（有池）」的差异。

为什么要在高并发测：
低并发（30~60）时单次握手只有 45ms 左右，省不省看不出差别。
但实测经本地代理时，握手耗时会随并发线性上升（120 条时握手中位 5.9 秒），
这时候「每条都重新握手」的代价就被放大成几十秒。

对应 src-tauri/src/http.rs 的改动：
- 改前：`Client::builder().build()` 每个请求一次 = 每次重新握手；
- 改后：`Clients` 缓存客户端 = 连接留在池里复用。

只打 /models，不产生任何出图费用。
"""

import asyncio
import json
import os
import sqlite3
import time
from collections import Counter

import aiohttp

DB = r"C:/Users/admin/AppData/Local/GPT Image SOP/data/data.db"
PROXY = "http://127.0.0.1:7897"


def load():
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    raw = conn.execute(
        "select value from kv where key='gpt-image-playground'"
    ).fetchone()[0]
    conn.close()
    s = json.loads(raw)["state"]["settings"]
    return s["baseUrl"].rstrip("/") + "/models", s["apiKey"]


async def no_pool(url, key, n, timeout):
    """
    模拟改前：每条请求一个独立 Session（= 独立 reqwest::Client），
    连接不可能被复用，每条都要完整握手。
    """
    async def one():
        async with aiohttp.ClientSession(timeout=timeout) as sess:
            async with sess.get(url, headers={"Authorization": f"Bearer {key}"}) as r:
                await r.read()
                return r.status

    return await asyncio.gather(*(one() for _ in range(n)), return_exceptions=True)


async def with_pool(url, key, n, timeout):
    """
    模拟改后：一个 Session 共享连接池。先串行预热一条连接，
    之后 n 条并发请求里，除第一批外都能命中池里的连接。
    """
    conn = aiohttp.TCPConnector(
        limit=0, limit_per_host=64, keepalive_timeout=90, force_close=False
    )
    async with aiohttp.ClientSession(timeout=timeout, connector=conn) as sess:
        # 预热：最多建 64 条连接，后续请求直接复用，不再握手
        warm = await asyncio.gather(
            *(sess.get(url, headers={"Authorization": f"Bearer {key}"}) for _ in range(min(64, n))),
            return_exceptions=True,
        )
        for w in warm:
            if not isinstance(w, Exception):
                await w.read()

        async def one():
            async with sess.get(url, headers={"Authorization": f"Bearer {key}"}) as r:
                await r.read()
                return r.status

        return await asyncio.gather(*(one() for _ in range(n)), return_exceptions=True)


async def measure(label, fn, url, key, n):
    timeout = aiohttp.ClientTimeout(total=120)
    t0 = time.perf_counter()
    results = await fn(url, key, n, timeout)
    total = (time.perf_counter() - t0) * 1000
    ok = sum(1 for r in results if isinstance(r, int) and r == 200)
    errs = Counter(type(r).__name__ for r in results if isinstance(r, Exception))
    reason = ", ".join(f"{k}×{v}" for k, v in errs.most_common()) or "-"
    print(
        f"{label:>16} | {n:>4} 条 -> 成功 {ok:>4}/{n} | 总耗时 {total:>7.0f}ms | "
        f"单条均摊 {total / n:>6.0f}ms | {reason}"
    )
    return total, ok


async def main():
    os.environ["HTTP_PROXY"] = PROXY
    os.environ["HTTPS_PROXY"] = PROXY
    url, key = load()
    print(f"目标：{url}\n代理：{PROXY}\n")
    header = f"{'方式':>16} | {'并发':>4}      | {'结果':>16} | {'总耗时':>11} | {'单条均摊':>11} | 异常"
    print(header)
    print("-" * len(header))

    for n in (60, 120, 170):
        t1, ok1 = await measure("改前·每次新建", no_pool, url, key, n)
        await asyncio.sleep(6)
        t2, ok2 = await measure("改后·连接复用", with_pool, url, key, n)
        if ok1 and ok2:
            print(f"{'':>16}   → 复用后总耗时为改前的 {t2 / t1:.0%}（成功数 {ok1} vs {ok2}）")
        print()
        await asyncio.sleep(8)


if __name__ == "__main__":
    asyncio.run(main())
