"""把「GPT SOP Tracker」里的投放数据合并进主线库（GPT Image SOP）。

背景
----
投放跟踪原本是独立客户端：identifier、安装目录、数据目录都和主线不同，
所以它的素材台账 / 消耗流水存在 `%LOCALAPPDATA%\\GPT SOP Tracker\\data\\data.db`。
2.0.0 起并入主线，主线只读自己安装目录下的 `data\\data.db`，
老客户端那批数据需要搬一次过来（否则打开台账是空的）。

搬什么
------
- `track_assets` / `track_spend` / `track_imports` / `track_lineage` 四张表（INSERT OR REPLACE，幂等）；
- 老库独有的图片与缩略图（表行 + 磁盘文件）；
- 方向树（`kv.gpt-image-sop-store` 里的 directions，按 id 合并，保留主线自己的节点）。

不搬：`tasks`（实测老库 2960 条全部是主线任务的子集）、`settings`（沿用主线的接口配置）。

用法
----
    python cli/tools/merge_tracker_into_main.py          # 空跑，只报数
    python cli/tools/merge_tracker_into_main.py --write  # 真写（先自动备份主库）

**两个客户端都要先退出**：SQLite 写锁被占用时只会报 `database is locked`。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

LOCALAPPDATA = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData/Local')))
DEFAULT_TRACKER = LOCALAPPDATA / 'GPT SOP Tracker' / 'data' / 'data.db'
DEFAULT_MAIN = LOCALAPPDATA / 'GPT Image SOP' / 'data' / 'data.db'

TRACK_TABLES = ('track_assets', 'track_spend', 'track_imports', 'track_lineage')
# 方向树存在 zustand 的持久化 JSON 里，和别的设置混在同一个 value 里
STORE_KEY = 'gpt-image-sop-store'


def warn_if_running() -> None:
    """客户端还在跑的话，等下写库必然撞锁，先说清楚。"""
    try:
        # 别用 text=True：中文 Windows 的 tasklist 输出是 GBK，按 UTF-8 解会直接抛错
        out = subprocess.check_output(
            ['tasklist', '/FI', 'IMAGENAME eq gpt-image-playground.exe'],
            stderr=subprocess.DEVNULL,
        ).lower()
    except (OSError, subprocess.SubprocessError):
        return
    if b'gpt-image-playground.exe' in out:
        print('⚠️  检测到 gpt-image-playground.exe 还在运行。')
        print('   写库会被 SQLite 锁挡住（或者写进去被客户端覆盖），建议先退出两个客户端。')


def open_readonly(path: Path) -> sqlite3.Connection:
    # 走 URI 只读：既能读到 -wal 里尚未 checkpoint 的内容，也不会给库加写锁
    return sqlite3.connect(f'file:{path.as_posix()}?mode=ro', uri=True)


def columns(conn: sqlite3.Connection, table: str) -> list[str]:
    """可写列。生成列（hidden=2/3）不能出现在 INSERT 的列清单里。"""
    return [row[1] for row in conn.execute(f'PRAGMA table_xinfo({table})').fetchall() if row[6] == 0]


def table_sql(conn: sqlite3.Connection, table: str) -> list[str]:
    """建表语句 + 索引，用来在主库里补齐 track 表。"""
    rows = conn.execute(
        "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('table', 'index') AND sql IS NOT NULL",
        (table,),
    ).fetchall()
    return [row[0] for row in rows]


def ensure_tables(main: sqlite3.Connection, tracker: sqlite3.Connection, write: bool) -> list[str]:
    have = {row[0] for row in main.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    missing = [table for table in TRACK_TABLES if table not in have]
    if write:
        for table in missing:
            for sql in table_sql(tracker, table):
                main.execute(sql)
        if missing:
            main.commit()
    return missing


def copy_table(
    main: sqlite3.Connection,
    tracker: sqlite3.Connection,
    table: str,
    write: bool,
    main_dir: Path | None = None,
    tracker_dir: Path | None = None,
) -> tuple[int, int, int]:
    """补主库缺的行。返回 (源行数, 缺的行数, 复制的文件数)。

    `main_dir` / `tracker_dir` 给 images / thumbnails 用：行里的 `file` 是相对数据目录的路径
    （`images/ab/<hash>.jpg`），搬行的时候文件也得跟着搬，否则台账里的图是空框。
    """
    cols = columns(tracker, table)
    assert cols == columns(main, table), f'{table} 两边可写列不一致，先把两个客户端升到同一版本'
    id_at = cols.index('id')
    col_list = ', '.join(cols)
    placeholders = ', '.join('?' for _ in cols)

    total = tracker.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
    known = {row[0] for row in main.execute(f'SELECT id FROM {table}')}
    pending = [row for row in tracker.execute(f'SELECT {col_list} FROM {table}') if row[id_at] not in known]

    copied = 0
    if write and pending:
        main.executemany(f'INSERT OR REPLACE INTO {table} ({col_list}) VALUES ({placeholders})', pending)
        if main_dir and tracker_dir:
            file_at = cols.index('file')
            for row in pending:
                relative = row[file_at]
                src = tracker_dir / relative
                if not src.exists():
                    continue
                dst = main_dir / relative
                dst.parent.mkdir(parents=True, exist_ok=True)
                # 同一张图两边都有时别重复搬，大小一致就当作同一份
                if not dst.exists() or dst.stat().st_size != src.stat().st_size:
                    shutil.copy2(src, dst)
                    copied += 1
        main.commit()
    return total, len(pending), copied


def merge_directions(main: sqlite3.Connection, tracker: sqlite3.Connection, write: bool) -> tuple[int, int]:
    """方向树按 id 合并，主库已有的节点不动。返回 (主库节点数, 新增数)。"""
    main_row = main.execute('SELECT value FROM kv WHERE key = ?', (STORE_KEY,)).fetchone()
    trk_row = tracker.execute('SELECT value FROM kv WHERE key = ?', (STORE_KEY,)).fetchone()
    if not trk_row:
        return (0, 0)

    main_state = json.loads(main_row[0]) if main_row else {'state': {}, 'version': 0}
    trk_state = json.loads(trk_row[0])
    main_holder = main_state.get('state') or main_state
    trk_holder = trk_state.get('state') or trk_state

    main_dirs = main_holder.get('directions') or []
    known = {node.get('id') for node in main_dirs}
    extra = [node for node in (trk_holder.get('directions') or []) if node.get('id') not in known]

    if write and extra:
        main_holder['directions'] = main_dirs + extra
        main.execute(
            'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            (STORE_KEY, json.dumps(main_state, ensure_ascii=False)),
        )
        main.commit()
    return (len(main_dirs), len(extra))


def backup(path: Path) -> Path:
    """用 SQLite 的 backup API 备份（直接 copy 会漏掉 -wal 里还没合并的内容）。"""
    target = path.with_name(f'{path.name}.bak-merge-{time.strftime("%Y%m%d-%H%M%S")}')
    src = open_readonly(path)
    dst = sqlite3.connect(target)
    with dst:
        src.backup(dst)
    src.close()
    dst.close()
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description='把老跟踪客户端的投放数据合并进主线库')
    parser.add_argument('--tracker-db', default=str(DEFAULT_TRACKER), help='老跟踪库路径')
    parser.add_argument('--main-db', default=str(DEFAULT_MAIN), help='主线库路径')
    parser.add_argument('--write', action='store_true', help='真的写库（默认只统计）')
    args = parser.parse_args()

    tracker_path = Path(args.tracker_db)
    main_path = Path(args.main_db)
    for path in (tracker_path, main_path):
        if not path.exists():
            print(f'找不到数据库：{path}')
            return 1

    print(f'来源：{tracker_path}')
    print(f'目标：{main_path}')
    warn_if_running()

    if args.write:
        print(f'已备份主库 → {backup(main_path).name}')

    tracker = open_readonly(tracker_path)
    main = sqlite3.connect(main_path) if args.write else open_readonly(main_path)
    if args.write:
        main.execute('PRAGMA journal_mode=WAL')

    try:
        created = ensure_tables(main, tracker, args.write)
        if created:
            print(f'主库需要补齐的表：{", ".join(created)}')

        print('\n== 投放数据 ==')
        for table in TRACK_TABLES:
            if table not in {row[0] for row in main.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
                total = tracker.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                print(f'  {table}: 源 {total} 行，主库缺 {total} 行（表还没建）')
                continue
            total, missing, _ = copy_table(main, tracker, table, args.write)
            print(f'  {table}: 源 {total} 行，主库缺 {missing} 行')

        print('\n== 方向树 ==')
        main_count, extra = merge_directions(main, tracker, args.write)
        print(f'  主库 {main_count} 个节点，需补 {extra} 个')

        print('\n== 图片与缩略图 ==')
        for table in ('images', 'thumbnails'):
            total, added, files = copy_table(
                main, tracker, table, args.write, main_path.parent, tracker_path.parent,
            )
            print(f'  {table}: 源 {total} 行，主库缺 {added} 行，复制文件 {files} 个')

        if args.write:
            main.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            print('\n✅ 已写入。打开主线客户端点右上角「刷新」就能看到台账数据。')
        else:
            print('\n（空跑：加 --write 才会真的写库）')
    finally:
        main.close()
        tracker.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
