#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 gpt-image-cli 某个批次的产出直接写进 GPT Image Playground 客户端库。

和 sync_to_playground.py 的区别：它按历史文件「搬家」，本脚本按**批次结果**
写入，保留真实提示词、尺寸、耗时，并支持按图片 sha256 去重（重复跑同批次不会重复入库）。

用法:
  python tools/push_to_client.py --batch batches/jdb-20261019 [--dry-run] [--json]
                                 [--app-data DIR] [--skip-thumb] [--no-backup]
"""
import argparse
import json
import os
import random
import shutil
import sqlite3
import string
import sys
from datetime import datetime, timezone
from pathlib import Path

MIME_BY_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
DEFAULT_PROFILE_ID = "gpt_image_playground-default-openai"
DEFAULT_PROFILE_NAME = "默认"


def default_app_data() -> Path:
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData/Local")
    return Path(local) / "GPT Image Playground" / "data"


def new_task_id(n: int = 13) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(n))


def image_size(p: Path):
    try:
        from PIL import Image

        with Image.open(p) as im:
            return im.size
    except Exception:
        return (None, None)


def make_thumb(src: Path, dst: Path, quality: int = 82) -> bool:
    try:
        from PIL import Image

        dst.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
            im.save(dst, "WEBP", quality=quality, method=4)
        return True
    except Exception as e:
        print(f"[warn] 缩略图生成失败 {src.name}: {e}", file=sys.stderr)
        return False


def backup_db(data_dir: Path) -> Path:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = data_dir / "backup-pre-cli-push" / ts
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("data.db", "data.db-wal", "data.db-shm"):
        f = data_dir / name
        if f.exists():
            shutil.copy2(f, dest / name)
    return dest


def load_results(batch_dir: Path):
    path = batch_dir / "results.jsonl"
    if not path.exists():
        return []
    items = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("status") != "ok" or not r.get("sha256") or not r.get("rel"):
            continue
        f = batch_dir / r["rel"]
        if f.exists():
            items.append((r, f))
    return items


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", required=True)
    ap.add_argument("--app-data", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--skip-thumb", action="store_true")
    ap.add_argument("--no-backup", action="store_true")
    args = ap.parse_args()

    batch_dir = Path(args.batch).resolve()
    data_dir = Path(args.app_data) if args.app_data else default_app_data()
    db_path = data_dir / "data.db"

    def fail(msg: str) -> int:
        print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False) if args.json else f"✘ {msg}")
        return 1

    if not batch_dir.exists():
        return fail(f"批次目录不存在：{batch_dir}")
    if not db_path.exists():
        return fail(f"找不到客户端数据库：{db_path}（请确认客户端已安装并启动过一次）")

    items = load_results(batch_dir)
    if not items:
        out = {"ok": True, "imported": 0, "note": "批次里没有成功的图片"}
        print(json.dumps(out, ensure_ascii=False) if args.json else "没有可写入的图片")
        return 0

    if args.dry_run:
        out = {
            "ok": True,
            "dryRun": True,
            "appData": str(data_dir),
            "tasks": len(items),
            "sample": [{"seq": r.get("seq"), "title": r.get("main_title"), "file": r["rel"]} for r, _ in items[:5]],
        }
        print(json.dumps(out, ensure_ascii=False, indent=2) if args.json else
              f"[dry-run] 目标库 {db_path}\n待写入 {len(items)} 个任务")
        return 0

    # 先只读查一遍已入库的 sha：没有新图就直接退出，避免无意义的备份
    ro = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        known_before = {row[0] for row in ro.execute("select id from images")}
    finally:
        ro.close()
    pending = [(r, f) for r, f in items if r["sha256"] not in known_before]
    if not pending:
        out = {"ok": True, "imported": 0, "skipped": len(items), "note": "这些图片都已经在客户端库里了"}
        print(json.dumps(out, ensure_ascii=False) if args.json else f"没有新图片（{len(items)} 张都已入库）")
        return 0

    backup = None if args.no_backup else backup_db(data_dir)
    con = sqlite3.connect(str(db_path), timeout=20)
    cur = con.cursor()
    cur.execute("PRAGMA busy_timeout=20000")
    cur.execute("PRAGMA journal_mode=WAL")

    profile_id, profile_name = DEFAULT_PROFILE_ID, DEFAULT_PROFILE_NAME
    try:
        row = cur.execute("select data from tasks order by updated_at desc limit 1").fetchone()
        if row:
            d = json.loads(row[0])
            profile_id = d.get("apiProfileId") or profile_id
            profile_name = d.get("apiProfileName") or profile_name
    except Exception:
        pass

    # 已入库的图片 sha，用来去重
    known_images = {row[0] for row in cur.execute("select id from images")}

    images_dir = data_dir / "images"
    thumbs_dir = data_dir / "thumbnails"
    imported_tasks, imported_files, skipped = 0, 0, 0

    for r, src in pending:
        digest = r["sha256"]
        if digest in known_images:
            skipped += 1
            continue

        ext = src.suffix.lower() if src.suffix.lower() in MIME_BY_EXT else ".png"
        mime = MIME_BY_EXT[ext]
        w, h = image_size(src)
        created_at = int(src.stat().st_mtime * 1000) - int(r.get("elapsed") or 0)

        rel_img = f"images/{digest[:2]}/{digest}{ext}"
        rel_thumb = f"thumbnails/{digest[:2]}/{digest}.webp"
        dst_img = data_dir / rel_img
        dst_img.parent.mkdir(parents=True, exist_ok=True)
        if dst_img.resolve() != src.resolve():
            shutil.copy2(src, dst_img)

        if not args.skip_thumb:
            dst_thumb = data_dir / rel_thumb
            if not dst_thumb.exists():
                make_thumb(dst_img, dst_thumb)

        cur.execute(
            "insert or ignore into images(id,mime,file,bytes,width,height,source,created_at) values(?,?,?,?,?,?,?,?)",
            (digest, mime, rel_img, src.stat().st_size, w, h, "generated", created_at),
        )
        if not args.skip_thumb:
            cur.execute(
                "insert or ignore into thumbnails(id,mime,file,width,height,version) values(?,?,?,?,?,?)",
                (digest, "image/webp", rel_thumb, w, h, 2),
            )

        size = r.get("size") or "auto"
        model = r.get("model") or "gpt-image-2"
        task_id = new_task_id()
        payload = {
            "id": task_id,
            "prompt": r.get("prompt", ""),
            "params": {
                "size": size,
                "quality": r.get("quality") or "high",
                "output_format": "png",
                "output_compression": None,
                "moderation": "auto",
                "n": 1,
                "transparent_output": False,
            },
            "apiProvider": "openai",
            "apiProfileId": profile_id,
            "apiProfileName": profile_name,
            "apiMode": "images",
            "apiModel": model,
            "inputImageIds": [],
            "maskTargetImageId": None,
            "maskImageId": None,
            "outputImages": [digest],
            "status": "done",
            "error": None,
            "createdAt": created_at,
            "finishedAt": created_at + int(r.get("elapsed") or 0),
            "elapsed": int(r.get("elapsed") or 0),
            "rawImageUrls": [],
            "actualParams": {"size": size, "n": 1},
            "actualParamsByImage": {digest: {"size": size}},
            "revisedPromptByImage": {digest: r.get("prompt", "")},
            "falRecoverable": False,
            "customRecoverable": False,
        }
        cur.execute(
            "insert or ignore into tasks(id,data,updated_at) values(?,?,?)",
            (task_id, json.dumps(payload, ensure_ascii=False), created_at + int(r.get("elapsed") or 0)),
        )
        known_images.add(digest)
        imported_tasks += 1
        imported_files += 1

    con.commit()
    con.close()

    result = {
        "ok": True,
        "appData": str(data_dir),
        "backup": str(backup) if backup else None,
        "importedTasks": imported_tasks,
        "importedFiles": imported_files,
        "skipped": skipped,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"✔ 写入 {imported_tasks} 个任务 / {imported_files} 张图（已存在跳过 {skipped}）")
        print(f"  目标库：{db_path}")
        if backup:
            print(f"  备份：{backup}")
        print("  提示：客户端开着的话，切一下页面或重启就能看到。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
