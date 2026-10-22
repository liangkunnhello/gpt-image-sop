#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 gpt-image-cli 的生成记录同步进 GPT Image Playground 桌面客户端。

只做 INSERT OR IGNORE，不 UPDATE / 不 DELETE。写入前自动备份 data.db(WAL/SHM)。
客户端若在运行，同步完成后需重启（或切页刷新）才能看到新记录。

用法:
  python tools/sync_to_playground.py [--dry-run] [--json] [--app-data DIR]
                                     [--history FILE] [--source DIR] [--limit N]
"""
import argparse
import hashlib
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


def parse_dt(s: str) -> int:
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def new_task_id(n: int = 13) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(n))


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 256), b""):
            h.update(chunk)
    return h.hexdigest()


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
    dest = data_dir / "backup-pre-cli-sync" / ts
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("data.db", "data.db-wal", "data.db-shm"):
        f = data_dir / name
        if f.exists():
            shutil.copy2(f, dest / name)
    return dest


def load_plan(history: Path, source: Path | None, limit: int | None):
    """返回 [{prompt, files, createdAt, elapsed, model, size, quality, mode}]"""
    items = []
    if history.exists():
        for line in history.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("status") != "ok" or not r.get("files"):
                continue
            files = [Path(f) for f in r["files"] if Path(f).exists()]
            if not files:
                continue
            items.append(
                {
                    "prompt": r.get("prompt", ""),
                    "files": files,
                    "createdAt": parse_dt(r.get("ts", "")),
                    "elapsed": int(r.get("elapsedMs") or 0),
                    "model": r.get("model") or "gpt-image-2",
                    "size": r.get("size") or "auto",
                    "quality": r.get("quality") or "high",
                    "mode": r.get("mode") or "gen",
                    "inputs": [Path(x) for x in (r.get("inputs") or []) if Path(x).exists()],
                }
            )

    if source:
        known = {str(f) for it in items for f in it["files"]}
        for p in sorted(source.glob("**/*")):
            if p.suffix.lower() not in MIME_BY_EXT or str(p) in known:
                continue
            items.append(
                {
                    "prompt": p.stem,
                    "files": [p],
                    "createdAt": int(p.stat().st_mtime * 1000),
                    "elapsed": 0,
                    "model": "gpt-image-2",
                    "size": "auto",
                    "quality": "unknown",
                    "mode": "gen",
                    "inputs": [],
                }
            )

    items.sort(key=lambda x: x["createdAt"])
    if limit:
        items = items[-limit:]
    return items


def existing_task_keys(cur) -> set:
    keys = set()
    for (data,) in cur.execute("select data from tasks"):
        try:
            d = json.loads(data)
            keys.add((d.get("prompt", ""), d.get("createdAt", 0)))
        except Exception:
            continue
    return keys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-data", default=None)
    ap.add_argument("--history", default=None)
    ap.add_argument("--source", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--skip-thumb", action="store_true")
    args = ap.parse_args()

    home = Path(os.environ.get("GPT_IMAGE_HOME") or (Path.home() / ".gpt-image-cli"))
    history = Path(args.history) if args.history else home / "history.jsonl"
    data_dir = Path(args.app_data) if args.app_data else default_app_data()
    db_path = data_dir / "data.db"

    if not db_path.exists():
        msg = f"找不到客户端数据库：{db_path}（请确认客户端已安装并至少启动过一次）"
        print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False) if args.json else f"✘ {msg}")
        return 1

    items = load_plan(history, Path(args.source) if args.source else None, args.limit)
    if not items:
        print(json.dumps({"ok": True, "imported": 0, "note": "没有可同步的记录"}, ensure_ascii=False) if args.json else "没有可同步的记录")
        return 0

    plan = []
    total_files = 0
    for it in items:
        plan.append(
            {
                "prompt": it["prompt"][:40],
                "createdAt": it["createdAt"],
                "files": [str(f) for f in it["files"]],
                "model": it["model"],
            }
        )
        total_files += len(it["files"])

    if args.dry_run:
        out = {"ok": True, "dryRun": True, "appData": str(data_dir), "tasks": len(items), "files": total_files, "plan": plan}
        print(json.dumps(out, ensure_ascii=False, indent=2) if args.json else
              f"[dry-run] 目标库 {db_path}\n待导入 {len(items)} 个任务 / {total_files} 张图\n" +
              "\n".join(f"  · {p['prompt']} ({len(p['files'])} 张)" for p in plan))
        return 0

    backup = backup_db(data_dir)
    con = sqlite3.connect(str(db_path), timeout=15)
    cur = con.cursor()
    cur.execute("PRAGMA busy_timeout=15000")
    cur.execute("PRAGMA journal_mode=WAL")

    # 取客户端现有配置档案信息，保证任务记录与客户端一致
    profile_id, profile_name = DEFAULT_PROFILE_ID, DEFAULT_PROFILE_NAME
    try:
        row = cur.execute("select data from tasks order by updated_at desc limit 1").fetchone()
        if row:
            d = json.loads(row[0])
            profile_id = d.get("apiProfileId") or profile_id
            profile_name = d.get("apiProfileName") or profile_name
    except Exception:
        pass

    seen = existing_task_keys(cur)
    images_dir = data_dir / "images"
    thumbs_dir = data_dir / "thumbnails"
    imported_tasks, imported_files, skipped = 0, 0, 0

    for it in items:
        key = (it["prompt"], it["createdAt"])
        if key in seen:
            skipped += 1
            continue

        out_ids = []
        for f in it["files"]:
            digest = sha256_file(f)
            ext = f.suffix.lower() if f.suffix.lower() in MIME_BY_EXT else ".png"
            mime = MIME_BY_EXT[ext]
            w, h = image_size(f)
            rel_img = f"images/{digest[:2]}/{digest}{ext}"
            rel_thumb = f"thumbnails/{digest[:2]}/{digest}.webp"

            dst_img = data_dir / rel_img
            if not dst_img.exists():
                dst_img.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dst_img)

            if not args.skip_thumb:
                dst_thumb = data_dir / rel_thumb
                if not dst_thumb.exists():
                    make_thumb(dst_img, dst_thumb)

            cur.execute(
                "insert or ignore into images(id,mime,file,bytes,width,height,source,created_at) values(?,?,?,?,?,?,?,?)",
                (digest, mime, rel_img, f.stat().st_size, w, h, "generated", it["createdAt"]),
            )
            if not args.skip_thumb:
                cur.execute(
                    "insert or ignore into thumbnails(id,mime,file,width,height,version) values(?,?,?,?,?,?)",
                    (digest, "image/webp", rel_thumb, w, h, 2),
                )
            out_ids.append(digest)
            imported_files += 1

        task_id = new_task_id()
        size = it["size"] or "auto"
        payload = {
            "id": task_id,
            "prompt": it["prompt"],
            "params": {
                "size": size,
                "quality": it["quality"],
                "output_format": "png",
                "output_compression": None,
                "moderation": "auto",
                "n": len(out_ids),
                "transparent_output": False,
            },
            "apiProvider": "openai",
            "apiProfileId": profile_id,
            "apiProfileName": profile_name,
            "apiMode": "images",
            "apiModel": it["model"],
            "inputImageIds": [],
            "maskTargetImageId": None,
            "maskImageId": None,
            "outputImages": out_ids,
            "status": "done",
            "error": None,
            "createdAt": it["createdAt"],
            "finishedAt": it["createdAt"] + max(it["elapsed"], 0),
            "elapsed": max(it["elapsed"], 0),
            "rawImageUrls": [],
            "actualParams": {"size": size, "n": len(out_ids)},
            "actualParamsByImage": {i: {"size": size} for i in out_ids},
            "revisedPromptByImage": {i: it["prompt"] for i in out_ids},
            "falRecoverable": False,
            "customRecoverable": False,
        }
        cur.execute(
            "insert or ignore into tasks(id,data,updated_at) values(?,?,?)",
            (task_id, json.dumps(payload, ensure_ascii=False), it["createdAt"] + max(it["elapsed"], 0)),
        )
        imported_tasks += 1
        seen.add(key)

    con.commit()
    con.close()

    result = {
        "ok": True,
        "appData": str(data_dir),
        "backup": str(backup),
        "importedTasks": imported_tasks,
        "importedFiles": imported_files,
        "skipped": skipped,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"✔ 导入 {imported_tasks} 个任务 / {imported_files} 张图（跳过已存在 {skipped} 个）")
        print(f"  目标库：{db_path}")
        print(f"  备份：{backup}")
        print("  提示：客户端若开着，重启后在历史/画廊里就能看到。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
