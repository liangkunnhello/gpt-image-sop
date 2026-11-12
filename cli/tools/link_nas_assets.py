#!/usr/bin/env python3
"""把 NAS「分类结果」里的外部成品接进投放跟踪台账。

## 为什么需要

报表里的素材如果认不到本地图，就只能在「待认领」里躺着：没有缩略图、台账看不到消耗，
也没法判断这张要不要继续投。设计部其实每天会把成品按产品/风格/尺寸放到 NAS 的
「分类结果」目录下，文件名的形态是：

    指标前缀 + 报表里的图片名称 + .jpg
    例：103.13-20261028-京东保-图标-诱导-大图-梁坤-359.jpg
        报表里对应：20261028-京东保-图标-诱导-大图-梁坤-359

所以「去掉开头连续的『数字-』段」就能反查到报表里的素材名，再顺着
`track_spend.data.assetName` 找到所有消耗流水。

## 存储口径：和本地生成的素材完全一致

- **图片本体**：`<数据目录>/images/<sha256 前 2 位>/<sha256>.<ext>`，
  并在 `images` 表写一行（id / mime / file / bytes / width / height / source='upload' /
  created_at）。缩略图、看大图、双击预览都走这套，不用另写读取逻辑。
- **台账**：`track_assets` 一行，**主键 id 就是图片哈希**（本地素材也是这样），
  `reportNames` 放报表里的名字，`platformIds` 放反查到的平台素材 ID，
  `note` 里记 NAS 的分类路径方便溯源。
- **流水**：把命中名称的 `track_spend.data.assetId` 指向这个哈希，
  有 `simulated` 标记的一并去掉（那是调试用的假关联）。

## 用法

    python cli/tools/link_nas_assets.py "\\\\192.168.202.11\\...\\分类结果"        # 空跑看统计
    python cli/tools/link_nas_assets.py "\\\\192.168...\\分类结果" --write        # 真写入

幂等：同一张图重复跑不会建两条（按 sha256 去重；同内容但 id 不同的旧图也会被认出来复用），只会补齐 platformIds / reportNames。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import struct
import sys
import time
from pathlib import Path

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")
MIME_BY_EXT = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
STORE_EXT = {".jpg": "jpg", ".jpeg": "jpg", ".png": "png", ".webp": "webp"}


# ---------------------------------------------------------------- 命名归一

def normalize_name(name: str) -> str:
    """文件名 / 报表名 → 比对用的键。

    两件事必须做，少一件匹配率就从 89% 掉到 60%：
    1. 扩展名要**反复剥**：NAS 上有 `xxx.jpg.jpg` 这种双后缀；
    2. 开头的「数字-」段要剥掉：那是投放指标前缀（消耗/曝光之类的快照），
       可能连续好几段（`143.11-125.18-1556.44-20260920-...`）。
    """
    text = (name or "").strip()
    while True:
        stripped = re.sub(r"\.(png|jpe?g|webp)$", "", text, flags=re.I)
        if stripped == text:
            break
        text = stripped
    text = re.sub(r"^(\d+(?:\.\d+)?-)+", "", text)
    return re.sub(r"\s+", "", text).lower()


# ---------------------------------------------------------------- 尺寸读取

def read_size(path: Path) -> tuple[int | None, int | None]:
    """从文件头读宽高。读不出来就留空（界面照样能显示，只是没尺寸）。"""
    try:
        with path.open("rb") as fh:
            head = fh.read(32)
            if head[:8] == b"\x89PNG\r\n\x1a\n" and len(head) >= 24:
                width, height = struct.unpack(">II", head[16:24])
                return width, height
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                fh.seek(0)
                data = fh.read(64 * 1024)
                # VP8X: 24 位宽高减一；VP8/VP8L 各有各的偏移，先按 VP8X 试
                if data[12:16] == b"VP8X":
                    width = int.from_bytes(data[24:27], "little") + 1
                    height = int.from_bytes(data[27:30], "little") + 1
                    return width, height
                return None, None
            if head[:2] == b"\xff\xd8":
                fh.seek(2)
                while True:
                    marker = fh.read(2)
                    if len(marker) < 2 or marker[0] != 0xFF:
                        return None, None
                    kind = marker[1]
                    if kind in (0xD8, 0x01) or 0xD0 <= kind <= 0xD7:
                        continue
                    length_bytes = fh.read(2)
                    if len(length_bytes) < 2:
                        return None, None
                    length = struct.unpack(">H", length_bytes)[0]
                    if 0xC0 <= kind <= 0xCF and kind not in (0xC4, 0xC8, 0xCC):
                        payload = fh.read(5)
                        if len(payload) < 5:
                            return None, None
                        height, width = struct.unpack(">HH", payload[1:5])
                        return width, height
                    fh.seek(max(0, length - 2), os.SEEK_CUR)
    except OSError:
        return None, None
    return None, None


# ---------------------------------------------------------------- 库存索引

def load_spend_index(conn: sqlite3.Connection) -> dict[str, set[str]]:
    """报表素材名（归一化）→ 平台素材 ID 集合。"""
    index: dict[str, set[str]] = {}
    rows = conn.execute(
        "select distinct json_extract(data,'$.assetName'), json_extract(data,'$.platformId') "
        "from track_spend where json_extract(data,'$.assetName') is not null"
    )
    for name, platform_id in rows:
        if not name or not platform_id:
            continue
        index.setdefault(normalize_name(name), set()).add(platform_id)
    return index


def load_asset_by_id(conn: sqlite3.Connection) -> dict[str, dict]:
    """台账按主键索引。

    必须按 id 也查一遍：NAS 里可能放着我们自己交付出去的图（字节完全相同、哈希就相同），
    这种情况直接新建会把本地那条「有 taskId 的」记录覆盖掉。
    """
    out: dict[str, dict] = {}
    for asset_id, data in conn.execute("select id, data from track_assets"):
        try:
            out[asset_id] = json.loads(data)
        except json.JSONDecodeError:
            continue
    return out


def load_asset_index(conn: sqlite3.Connection) -> dict[str, dict]:
    """台账已有的素材：报表名（归一化）→ 台账记录。用于避免重复建档。"""
    index: dict[str, dict] = {}
    for asset_id, data in conn.execute("select id, data from track_assets"):
        try:
            asset = json.loads(data)
        except json.JSONDecodeError:
            continue
        for name in asset.get("reportNames") or []:
            index.setdefault(normalize_name(name), asset)
    return index


# ---------------------------------------------------------------- 主流程

def main() -> int:
    parser = argparse.ArgumentParser(description="把 NAS 分类结果里的成品关联到投放台账")
    parser.add_argument("path", help="分类结果目录（会递归扫）")
    parser.add_argument("--db", help="跟踪版数据库，默认 %%LOCALAPPDATA%%\\GPT SOP Tracker\\data\\data.db")
    parser.add_argument("--data-dir", help="数据目录（images/ 的父目录），默认取数据库同级")
    parser.add_argument("--write", action="store_true", help="真写入（不加只空跑统计）")
    parser.add_argument("--limit", type=int, help="只处理前 N 个文件，调试用")
    args = parser.parse_args()

    root = Path(args.path)
    if not root.is_dir():
        print(f"目录不存在：{root}")
        return 2

    if args.db:
        db_path = Path(args.db)
    else:
        from local_db import default_db
        db_path = default_db()
    if not db_path.exists():
        print(f"找不到数据库：{db_path}")
        return 2
    data_dir = Path(args.data_dir) if args.data_dir else db_path.parent

    files: list[Path] = []
    for current, _, names in os.walk(root):
        for name in names:
            if name.lower().endswith(IMAGE_EXTS):
                files.append(Path(current) / name)
    files.sort()
    if args.limit:
        files = files[: args.limit]
    print(f"库：{db_path}\n图片目录：{root}\n找到 {len(files)} 个图片\n")

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    spend_index = load_spend_index(conn)
    asset_index = load_asset_index(conn)
    asset_by_id = load_asset_by_id(conn)
    print(f"报表素材名（去重）：{len(spend_index)}，台账已有素材名：{len(asset_index)}\n")

    now_ms = int(time.time() * 1000)
    stats = {
        "new_image": 0, "reused_image": 0, "new_asset": 0, "merged_asset": 0,
        "linked_spend": 0, "linked_amount": 0.0, "unmatched": 0, "failed": 0, "empty": 0,
    }
    unmatched: list[tuple[str, str]] = []
    touched_assets: dict[str, dict] = {}
    touched_platforms: dict[str, set[str]] = {}

    for index, path in enumerate(files, start=1):
        rel = path.relative_to(root)
        key = normalize_name(path.name)
        platforms = spend_index.get(key)
        existing = asset_index.get(key)
        if not platforms and not existing:
            stats["unmatched"] += 1
            unmatched.append((str(rel), path.name))
            continue
        try:
            size_on_disk = path.stat().st_size
            raw = path.read_bytes()
        except OSError as exc:
            stats["failed"] += 1
            print(f"  [读取失败] {rel}: {exc}")
            continue
        # NAS 上 `_待确认/API失败` 这类目录里放的是 0 字节占位文件（下载失败留下的）。
        # 不拦的话所有空文件都会哈希成同一个值（空内容的 sha256），
        # 几百个素材合并成一条记录，还把不相干的流水绑到一起。
        if size_on_disk == 0 or len(raw) == 0:
            stats["empty"] += 1
            continue
        if len(raw) != size_on_disk:
            stats["failed"] += 1
            print(f"  [读取不完整] {rel}: 期望 {size_on_disk} 字节，实际 {len(raw)}")
            continue
        digest = hashlib.sha256(raw).hexdigest()
        ext = STORE_EXT.get(path.suffix.lower(), "jpg")
        has_row = conn.execute("select 1 from images where id=?", (digest,)).fetchone()
        # 同内容但 id 不是内容哈希的旧图（生成图被后处理重写过），也要认出来复用
        same_content_id = None if has_row else find_same_content(conn, data_dir, digest, len(raw))
        if has_row or same_content_id:
            stats["reused_image"] += 1
            if same_content_id:
                stats["reused_same_content"] = stats.get("reused_same_content", 0) + 1
        else:
            stats["new_image"] += 1
            if args.write:
                bucket = data_dir / "images" / digest[:2]
                bucket.mkdir(parents=True, exist_ok=True)
                target = bucket / f"{digest}.{ext}"
                if not target.exists():
                    target.write_bytes(raw)
                width, height = read_size(path)
                conn.execute(
                    "insert or replace into images (id, mime, file, bytes, width, height, source, created_at) "
                    "values (?,?,?,?,?,?,?,?)",
                    (digest, MIME_BY_EXT.get(path.suffix.lower(), "image/jpeg"),
                     f"images/{digest[:2]}/{digest}.{ext}", len(raw), width, height, "upload", now_ms),
                )

        # 台账：已经有素材认这个名字就合并过去，否则用图片哈希新建（和本地素材同一套主键）
        asset_id = existing["id"] if existing else (same_content_id or digest)
        report_name = normalize_report_name(path.name)
        # 已有的台账记录（按报表名或按图片哈希）都复用，避免把本地素材的 taskId 覆盖掉
        base_asset = existing or asset_by_id.get(asset_id)
        asset = touched_assets.get(asset_id) or (dict(base_asset) if base_asset else {
            "id": asset_id,
            "platformIds": [],
            "reportNames": [],
            "createdAt": now_ms,
            "firstSeenAt": now_ms,
        })
        if report_name and report_name not in (asset.get("reportNames") or []):
            asset["reportNames"] = [*(asset.get("reportNames") or []), report_name]
        note = str(rel.parent).replace("\\", " / ")
        if note and note != "." and note not in (asset.get("note") or ""):
            asset["note"] = f"{asset['note']}；来源：{note}" if asset.get("note") else f"来源：{note}"
        # 结构化留一份分类路径：软件里按它把素材归到「产品/方向」
        # （`assetDirection.ts::matchDirectionByPath`）。只存 note 的话，
        # 方向树改名/拆分之后就没法重新对上了。
        if note and note != ".":
            asset["dirPath"] = [part.strip() for part in note.split("/") if part.strip()]
        touched_assets[asset_id] = asset
        if base_asset:
            stats["merged_asset"] += 1
        else:
            stats["new_asset"] += 1

        if platforms:
            merged = set(touched_platforms.get(asset_id) or [])
            merged |= platforms
            touched_platforms[asset_id] = merged
            ids = list(asset.get("platformIds") or [])
            for platform_id in platforms:
                if platform_id not in ids:
                    ids.append(platform_id)
            asset["platformIds"] = ids

        if index % 50 == 0 or index == len(files):
            print(f"  处理中 {index}/{len(files)}…")

    # 回填流水：把命中名称的流水绑到这个素材上。
    # 空跑也照算一遍（只读），这样加 --write 之前就能看到会绑多少条、多少钱。
    pending: list[tuple[str, int, str]] = []
    for asset_id, platforms in touched_platforms.items():
        placeholders = ",".join("?" * len(platforms))
        rows = conn.execute(
            f"select id, data from track_spend where spend_platform in ({placeholders})", tuple(platforms)
        ).fetchall()
        for spend_id, data in rows:
            try:
                record = json.loads(data)
            except json.JSONDecodeError:
                continue
            # 已经有主的流水不再改绑：同一个平台素材 ID 在不同日期可能挂着不同名字，
            # 谁先匹配到就归谁。否则每跑一次就在两个素材之间来回翻，数字也跟着抖。
            if record.get("assetId") and not record.get("simulated"):
                continue
            record["assetId"] = asset_id
            record.pop("simulated", None)
            pending.append((json.dumps(record, ensure_ascii=False), now_ms, spend_id))
            stats["linked_spend"] += 1
            stats["linked_amount"] += float(record.get("spend") or 0)
    if args.write and pending:
        conn.executemany("update track_spend set data=?, updated_at=? where id=?", pending)
        conn.commit()

    if args.write and touched_assets:
        conn.executemany(
            "insert into track_assets (id, data, updated_at) values (?,?,?) "
            "on conflict(id) do update set data=excluded.data, updated_at=excluded.updated_at",
            [(aid, json.dumps(asset, ensure_ascii=False), now_ms) for aid, asset in touched_assets.items()],
        )
        conn.commit()

    print()
    print(f"图片：新增 {stats['new_image']}，已存在 {stats['reused_image']}"
          + (f"（其中同内容不同 id 复用 {stats['reused_same_content']}）" if stats.get("reused_same_content") else ""))
    print(f"台账：新建 {stats['new_asset']}，合并到已有素材 {stats['merged_asset']}")
    print(f"流水：绑定 {stats['linked_spend']} 条，合计 ¥{stats['linked_amount']:,.2f}")
    print(f"名称对不上：{stats['unmatched']}，空文件跳过：{stats['empty']}，读取失败：{stats['failed']}")
    if unmatched:
        out = Path("./.nas-unmatched.csv")
        out.write_text(
            "相对路径,文件名\n" + "\n".join(f'"{rel}","{name}"' for rel, name in unmatched),
            encoding="utf-8-sig",
        )
        print(f"对不上的清单写到：{out}（前 5 条：）")
        for rel, name in unmatched[:5]:
            print(f"   {rel}")
    print()
    print("已写入，回软件点右上角「刷新」。" if args.write else "这是空跑，没有写库。确认数字对得上再加 --write。")
    conn.close()
    return 0


def find_same_content(conn, data_dir: Path, digest: str, size: int) -> str | None:
    """找「内容一样、但 id 不是内容哈希」的已有图片，返回它的 id。

    生成图入库后，后处理会按模板尺寸重写文件而 id 不变，于是 id 与文件内容不再对应。
    直接按 id=digest 查会漏掉这类图，导致同一张成品图被建成两条素材、消耗被拆开。
    候选只取同样字节数的行（内容相同必然同长度），再逐条算 sha256 比对。
    """
    for image_id, rel in conn.execute("select id, file from images where bytes=?", (size,)).fetchall():
        try:
            raw = (data_dir / rel).read_bytes()
        except OSError:
            continue
        if hashlib.sha256(raw).hexdigest() == digest:
            return image_id
    return None


def normalize_report_name(file_name: str) -> str:
    """NAS 文件名 → 报表里的图片名称（只剥掉开头的指标前缀和扩展名，保留原样大小写）。"""
    text = file_name
    while True:
        stripped = re.sub(r"\.(png|jpe?g|webp)$", "", text, flags=re.I)
        if stripped == text:
            break
        text = stripped
    return re.sub(r"^(\d+(?:\.\d+)?-)+", "", text)


if __name__ == "__main__":
    sys.exit(main())
