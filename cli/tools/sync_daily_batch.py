#!/usr/bin/env python3
"""每日一条龙：把「素材采集分类工具」当天的产出（报表 + 图片）自动接进投放跟踪。

## 背景

`瀚海源码完整版/素材采集分类工具` 是个 Electron 工具，内部有定时计划（采集 → 分类），
每天把产物按平台落到 NAS：

    有米云素材/
      内部系统/20261106/图片/报表/_图片_2026-11-05-..._素材报表明细.xlsx
      内部系统/20261106/图片/原始素材/*.jpg
      内部系统/20261106/图片/分类结果/<产品>/<方向>/<横竖版>/*.jpg
      妙思/20261106/{分类结果,原始素材,报表}          ← 只有内部系统带「素材报表明细」
      有米云/...、热云/...

本脚本按日期找到这些目录，串起两件事：

1. `import_track_reports.py`：报表 xlsx → `track_spend`（消耗流水）
2. `link_nas_assets.py`：分类结果里的图片 → `images` + `track_assets`，并绑定流水

两者都幂等，重复跑不会重复建数据。

## 用法

    python cli/tools/sync_daily_batch.py                # 空跑看会做什么
    python cli/tools/sync_daily_batch.py --write        # 真写入
    python cli/tools/sync_daily_batch.py --date 20261106 --write
    python cli/tools/sync_daily_batch.py --days 3 --write   # 补最近 3 天

定时：`--install-task` 会注册一个每天 **13:00** 跑一次的计划任务（Windows），
只处理「内部系统」这个带报表的渠道；`--days 2` 顺带补昨天的漏。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
IMPORT_TOOL = TOOLS_DIR / "import_track_reports.py"
LINK_TOOL = TOOLS_DIR / "link_nas_assets.py"

DEFAULT_ROOT = r"\\192.168.202.11\设计素材交付专用\创意部素材交付-优化取片\【主专辑-保险】\有米云素材"

# 平台目录名 → 会不会带「素材报表明细」（目前只有内部系统这个渠道的导出带消耗表）
PLATFORMS = ["内部系统", "妙思", "有米云", "热云"]

TASK_NAME = "GPT-SOP-每日报表与素材同步"

# 计划任务里 stdout 可能是无效句柄，排查用的「走到哪一步」必须直接写文件
TRACE_PATH = None  # type: Path | None


def note(message: str) -> None:
    if TRACE_PATH is None:
        return
    try:
        with TRACE_PATH.open("a", encoding="utf-8") as fh:
            fh.write(f"[{datetime.now():%H:%M:%S}] {message}\n")
    except OSError:
        pass


def data_dir() -> Path:
    # 合并进主线后数据目录是 GPT Image SOP（老路径只在没升级的机器上回退）
    sys.path.insert(0, str(TOOLS_DIR))
    from local_db import data_dir as local_data_dir
    return local_data_dir()


def state_path() -> Path:
    return data_dir() / "sync-state.json"


def load_state() -> dict:
    path = state_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def find_batch_dirs(root: Path, day: str, platforms: list[str] | None = None) -> list[tuple[str, Path]]:
    """找出这一天各平台的批次目录。

    内部系统多一层 `图片/`（`20261106/图片/报表`），其他平台直接挂在日期下
    （`20261106/报表`），所以两种都要认。
    `platforms` 只处理指定渠道（默认全部）。
    """
    out: list[tuple[str, Path]] = []
    for platform in (platforms or PLATFORMS):
        base = root / platform / day
        # 日期目录可能是 20261013 这种「数据日期 +1」，也可能带后缀
        if not base.is_dir():
            candidates = sorted(p for p in (root / platform).glob(f"{day}*") if p.is_dir()) if (root / platform).is_dir() else []
            if not candidates:
                continue
            base = candidates[0]
        if (base / "图片").is_dir():
            out.append((platform, base / "图片"))
        else:
            out.append((platform, base))
    return out


def signature(batch: Path) -> str:
    """批次指纹：报表和分类审计文件的「大小 + 修改时间」。

    不遍历图片目录：435 个文件在 SMB 上数一遍要一两秒，而这个检查是每 15 分钟跑一次的。
    采集/分类都是「先写完文件再写这两个索引」，所以它们变了就代表有新东西。
    """
    parts: list[str] = []
    for pattern in ("报表/*.xlsx", "报表/capture-items.json", "分类结果/_API分类审计.jsonl", "分类结果"):
        for path in sorted(batch.glob(pattern)):
            try:
                stat = path.stat()
            except OSError:
                continue
            # 目录的 mtime 只在增删子项时变，够用
            parts.append(f"{path.name}:{stat.st_size}:{int(stat.st_mtime)}")
            break
    return "|".join(parts)


def run_tool(script: Path, args: list[str], log) -> bool:
    command = [sys.executable, str(script), *args]
    log(f"  $ {' '.join(command[1:])}")
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        # 计划任务里没有控制台，子进程默认按 locale（cp936）输出，这里统一成 UTF-8，
        # 否则日志里的中文会变成乱码
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    for line in (result.stdout or "").splitlines():
        if line.strip():
            log(f"    {line}")
    if result.returncode != 0:
        for line in (result.stderr or "").splitlines():
            if line.strip():
                log(f"    [stderr] {line}")
        return False
    return True


def sync_batch(platform: str, batch: Path, day: str, write: bool, log) -> bool:
    reports = sorted((batch / "报表").glob("*.xlsx")) if (batch / "报表").is_dir() else []
    classified = batch / "分类结果"
    ok = True

    if reports:
        log(f"[{platform} {day}] 报表 {len(reports)} 个 → 导入流水")
        args = [str(p) for p in reports] + (["--write"] if write else [])
        ok = run_tool(IMPORT_TOOL, args, log) and ok
    else:
        log(f"[{platform} {day}] 没有报表（这个渠道只采素材），跳过流水导入")

    if classified.is_dir():
        log(f"[{platform} {day}] 分类结果 → 关联素材")
        args = [str(classified)] + (["--write"] if write else [])
        ok = run_tool(LINK_TOOL, args, log) and ok
    else:
        log(f"[{platform} {day}] 没有分类结果目录，跳过素材关联")
    return ok


def install_task() -> int:
    """注册 Windows 计划任务：每天 13:00 把当天（含昨天）的批次导进来。

    用 ScheduledTasks 模块而不是 schtasks.exe：后者在这台机器的安全策略里被拦，
    前者是 CIM 接口，普通用户就能给自己建任务。
    `StartWhenAvailable` 让「13:00 时机器没开」的任务开机后补跑一次。
    """
    script = Path(__file__).resolve()
    python = sys.executable
    argument = f'"{script}" --write --quiet --platform 内部系统 --days 2'
    shell_command = (
        "$ErrorActionPreference = 'Stop'; "
        f"$action = New-ScheduledTaskAction -Execute '{python}' -Argument '{argument}'; "
        "$trigger = New-ScheduledTaskTrigger -Daily -At 13:00; "
        "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries "
        "-DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3); "
        f"Register-ScheduledTask -TaskName '{TASK_NAME}' -Action $action -Trigger $trigger "
        "-Settings $settings -Description '每天 13:00 把 NAS 内部系统当天批次的报表与素材导入投放跟踪' -Force | Out-Null"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", shell_command],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        print(result.stdout.strip() or result.stderr.strip())
        return result.returncode
    print(f"已注册计划任务「{TASK_NAME}」：每天 13:00 同步「内部系统」当天批次（含昨天补漏）。")
    print(f"查看：Get-ScheduledTask -TaskName '{TASK_NAME}' | Get-ScheduledTaskInfo")
    print(f"删除：Unregister-ScheduledTask -TaskName '{TASK_NAME}' -Confirm:$false")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="每日自动导入报表与素材（配合素材采集分类工具的定时计划）")
    parser.add_argument("--root", default=DEFAULT_ROOT, help="有米云素材根目录")
    parser.add_argument("--date", help="只处理这一天（YYYYMMDD），默认今天和昨天")
    parser.add_argument("--days", type=int, default=2, help="往前看几天，默认 2（跨零点也能接上）")
    parser.add_argument("--write", action="store_true", help="真写入；不加只空跑")
    parser.add_argument("--force", action="store_true", help="忽略「已同步过」的标记")
    parser.add_argument("--quiet", action="store_true", help="没有新数据时不打印日志（给计划任务用）")
    parser.add_argument("--platform", action="append", choices=PLATFORMS,
                        help="只处理指定渠道（可写多次），默认全部；定时任务只跑「内部系统」")
    parser.add_argument("--install-task", action="store_true", help="注册/更新每天 13:00 的 Windows 计划任务后退出")
    args = parser.parse_args()

    if args.install_task:
        return install_task()

    root = Path(args.root)
    note(f"检查根目录 {root}")
    if not root.is_dir():
        print(f"根目录不可用：{root}（NAS 没连上？）")
        return 2
    note("根目录可访问")

    days: list[str] = []
    # 从钩子里传进来的 {batchDate} 可能是空串（老记录没有这个字段），
    # 这时退回「今天 + 昨天」，别当成「处理空日期」直接什么都不做。
    if args.date and args.date.strip():
        days = [args.date.strip()]
    else:
        today = datetime.now()
        days = [(today - timedelta(days=offset)).strftime("%Y%m%d") for offset in range(args.days)]

    log_path = data_dir() / "sync-logs" / f"sync-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log"
    lines: list[str] = []

    def log(message: str) -> None:
        try:
            print(message)
        except (OSError, ValueError):
            # 计划任务里没有控制台，stdout 可能是无效句柄；日志文件照写不误
            pass
        lines.append(message)

    state = load_state()
    changed = 0
    failed = 0

    for day in days:
        note(f"找 {day} 的批次")
        batches = find_batch_dirs(root, day, args.platform)
        note(f"{day} 命中 {len(batches)} 个批次")
        if not batches:
            continue
        for platform, batch in batches:
            sig = signature(batch)
            key = str(batch)
            done = state.get(key) or {}
            if not sig:
                continue
            if not args.force and done.get("sig") == sig and done.get("ok"):
                continue
            changed += 1
            log(f"\n=== {day} {platform} ===")
            ok = sync_batch(platform, batch, day, args.write, log)
            if ok and args.write:
                state[key] = {"sig": sig, "at": datetime.now().isoformat(timespec="seconds"), "ok": True}
                save_state(state)
            elif not ok:
                failed += 1

    if not changed:
        if not args.quiet:
            print("没有新数据（最近 %d 天都已同步过）" % len(days))
        return 0

    if lines:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text("\n".join(lines), encoding="utf-8")

    print()
    print(f"处理了 {changed} 个批次" + (f"，失败 {failed} 个" if failed else "") +
          ("" if args.write else "（空跑，没有写库；确认无误加 --write）"))
    return 1 if failed else 0


if __name__ == "__main__":
    """
    Windows 计划任务里没有控制台，`sys.stdout` 是个**无效句柄**（不是 None）：
    往里写会阻塞，表现出来就是「任务一直在运行中」，什么日志都没有。
    所以先用 GetConsoleWindow 判断有没有控制台，没有就把标准输出接到日志文件。
    """
    trace = data_dir() / "sync-logs" / "task-trace.log"
    trace.parent.mkdir(parents=True, exist_ok=True)
    TRACE_PATH = trace
    try:
        import ctypes

        headless = ctypes.windll.kernel32.GetConsoleWindow() == 0
    except Exception:
        headless = False
    if headless:
        stream = trace.open("a", encoding="utf-8", buffering=1)
        sys.stdout = stream
        sys.stderr = stream

    with trace.open("a", encoding="utf-8") as fh:
        fh.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] 启动 {' '.join(sys.argv[1:])}\n")
    code = main()
    with trace.open("a", encoding="utf-8") as fh:
        fh.write(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] 结束 code={code}\n")
    sys.exit(code)
