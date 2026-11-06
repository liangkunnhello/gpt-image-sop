#!/usr/bin/env python3
"""把「素材报表明细」xlsx/csv 批量灌进跟踪版（GPT SOP Tracker）的 SQLite。

为什么需要它：软件里的批量导入要点界面，历史几十天的报表手工点容易漏；
这里一次把整个目录吃完，逻辑与 `src/lib/reportImport.ts` 对齐（同样的列识别、
同样的日期归一、同样的「平台素材ID + 日期」主键），导完软件点「刷新」即可看到。

用法：
    python cli/tools/import_track_reports.py C:/Documents/xlsx            # 先空跑看合计
    python cli/tools/import_track_reports.py C:/Documents/xlsx --write    # 真写入
    python cli/tools/import_track_reports.py a.xlsx b.xlsx --db 别的.db --write

注意：
- 默认库是 %LOCALAPPDATA%\\GPT SOP Tracker\\data\\data.db；软件开着也能写（WAL），
  但写完要在软件里点「刷新」才会重新读。
- 幂等：主键是「平台素材ID__日期」，同一天重复导会覆盖而不是叠加。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------- 解析 xlsx

ROW_RE = re.compile(r"<row\b[^>]*>([\s\S]*?)</row>")
# 非贪婪 + `/>` 优先分支：报表里有大量 `<c r="I5" t="inlineStr" />`（`/` 前带空格），
# 贪婪写法会把紧随其后的单元格整格吞掉（消耗变 0）。这个坑在 TS 侧踩过一次，别改。
CELL_RE = re.compile(r"<c\b([^>]*?)(/>|>([\s\S]*?)</c>)")
SI_RE = re.compile(r"<si\b[^>]*>([\s\S]*?)</si>")
T_RE = re.compile(r"<t\b[^>]*>([\s\S]*?)</t>")
V_RE = re.compile(r"<v>([\s\S]*?)</v>")
REF_RE = re.compile(r'\br="([A-Z]+)\d+"')
TYPE_RE = re.compile(r'\bt="([^"]+)"')


def decode_xml(text: str) -> str:
    text = text.replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("&quot;", '"').replace("&apos;", "'")
    text = re.sub(r"&#x([0-9a-fA-F]+);", lambda m: chr(int(m.group(1), 16)), text)
    text = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), text)
    return text.replace("&amp;", "&")


def column_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref.upper())
    if not letters:
        return -1
    n = 0
    for ch in letters.group(0):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def parse_sheet_xml(xml: str, shared: list[str]) -> list[list[str]]:
    rows: list[list[str]] = []
    for row_match in ROW_RE.finditer(xml):
        cells: list[str] = []
        for cell in CELL_RE.finditer(row_match.group(1)):
            attrs = cell.group(1) or ""
            body = cell.group(3) or ""
            ref = REF_RE.search(attrs)
            kind = TYPE_RE.search(attrs)
            index = column_index(ref.group(1)) if ref else len(cells)
            if index < 0:
                continue
            value = ""
            if kind and kind.group(1) == "s":
                raw = V_RE.search(body)
                if raw and raw.group(1).isdigit():
                    idx = int(raw.group(1))
                    value = shared[idx] if idx < len(shared) else ""
            elif kind and kind.group(1) == "inlineStr":
                value = decode_xml("".join(t.group(1) for t in T_RE.finditer(body)))
            else:
                raw = V_RE.search(body)
                value = decode_xml(raw.group(1)) if raw else ""
            # JS 里 cells[index] = v 会自动扩容，Python 不会：必须补齐到 index+1
            while len(cells) <= index:
                cells.append("")
            cells[index] = value.strip()
        if any(cell != "" for cell in cells):
            rows.append(cells)
    return rows


def parse_xlsx(path: Path) -> tuple[list[str], list[list[str]]]:
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            shared_xml = zf.read("xl/sharedStrings.xml").decode("utf-8", "ignore")
            for si in SI_RE.finditer(shared_xml):
                shared.append(decode_xml("".join(t.group(1) for t in T_RE.finditer(si.group(1)))))
        entry = next((n for n in names if n == "xl/worksheets/sheet1.xml"), None)
        if entry is None:
            raise SystemExit(f"{path.name}：找不到工作表")
        rows = parse_sheet_xml(zf.read(entry).decode("utf-8", "ignore"), shared)
    if not rows:
        raise SystemExit(f"{path.name}：工作表是空的")
    return rows[0], rows[1:]


def parse_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    text = path.read_text(encoding="utf-8-sig")
    rows: list[list[str]] = []
    row, cell, quoted = [], "", False
    i = 0
    while i < len(text):
        ch = text[i]
        if quoted:
            if ch == '"':
                if i + 1 < len(text) and text[i + 1] == '"':
                    cell += '"'
                    i += 1
                else:
                    quoted = False
            else:
                cell += ch
            i += 1
            continue
        if ch == '"':
            quoted = True
        elif ch == ",":
            row.append(cell.strip())
            cell = ""
        elif ch == "\n":
            row.append(cell.strip())
            rows.append(row)
            row, cell = [], ""
        elif ch != "\r":
            cell += ch
        i += 1
    if cell or row:
        row.append(cell.strip())
        rows.append(row)
    rows = [r for r in rows if any(v != "" for v in r)]
    if not rows:
        raise SystemExit(f"{path.name}：文件是空的")
    return rows[0], rows[1:]


# ---------------------------------------------------------------- 列识别

HEADER_HINTS = [
    ("assetKey", ["图片名称", "素材名称", "创意名称", "文件名称"]),
    ("platformId", ["=id", "素材id", "素材编号", "创意id", "图片id"]),
    ("date", ["日期", "投放日期", "统计日期", "数据日期"]),
    ("spend", ["消耗", "花费", "消费"]),
    ("productName", ["产品名称", "产品"]),
    ("designer", ["设计", "设计师"]),
    ("optimizer", ["优化师", "优化"]),
    ("abnormal", ["异常"]),
    ("previewUrl", ["预览地址", "预览链接", "素材链接", "图片链接"]),
    ("media", ["媒体", "渠道"]),
]
FIELDS = ["date", "spend", "platformId", "assetKey", "media", "productName",
          "designer", "optimizer", "abnormal", "previewUrl"]


def detect_mapping(headers: list[str]) -> dict[str, int]:
    normalized = [re.sub(r"\s+", "", h).lower() for h in headers]
    mapping = {f: -1 for f in FIELDS}
    used: set[int] = set()
    for field_name, hints in HEADER_HINTS:
        for hint in hints:
            exact = hint.startswith("=")
            needle = (hint[1:] if exact else hint).lower()
            for i, head in enumerate(normalized):
                if i in used:
                    continue
                if (head == needle) if exact else (needle in head):
                    mapping[field_name] = i
                    used.add(i)
                    break
            if mapping[field_name] >= 0:
                break
    return mapping


# ---------------------------------------------------------------- 值归一

def to_number(value: str) -> float:
    cleaned = re.sub(r"[,\s¥$€]", "", value or "")
    if not cleaned:
        return 0.0
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def normalize_date(value: str) -> str:
    text = (value or "").strip()
    if not text:
        return ""
    dashed = re.match(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", text)
    if dashed:
        y, m, d = dashed.groups()
        return f"{y}-{int(m):02d}-{int(d):02d}"
    compact = re.match(r"^(\d{4})(\d{2})(\d{2})$", text)
    if compact:
        return f"{compact.group(1)}-{compact.group(2)}-{compact.group(3)}"
    if re.match(r"^\d+(\.\d+)?$", text):
        serial = float(text)
        if 20000 < serial < 80000:
            dt = time.gmtime(round((serial - 25569) * 86400))
            return time.strftime("%Y-%m-%d", dt)
    return ""


def normalize_asset_name(value: str) -> str:
    text = (value or "").strip()
    text = re.sub(r"\.(png|jpe?g|webp)$", "", text, flags=re.I)
    return re.sub(r"\s+", "", text).lower()


# ---------------------------------------------------------------- 主流程

@dataclass
class FileOutcome:
    name: str
    rows: int = 0
    records: int = 0
    total_spend: float = 0.0
    matched: int = 0
    unmatched: int = 0
    skipped: int = 0
    error: str = ""
    dates: list[str] = field(default_factory=list)


def build_name_index(conn: sqlite3.Connection) -> dict[str, str]:
    index: dict[str, str] = {}
    for (data,) in conn.execute("SELECT data FROM tasks"):
        try:
            task = json.loads(data)
        except json.JSONDecodeError:
            continue
        names = task.get("deliveredFileNames") or {}
        if not names:
            continue
        folder = (task.get("deliverFolder") or "").strip()
        for image_id, file_name in names.items():
            if not file_name:
                continue
            plain = normalize_asset_name(file_name)
            if plain and plain not in index:
                index[plain] = image_id
            if folder:
                combo = normalize_asset_name(f"{folder}/{file_name}")
                if combo and combo not in index:
                    index[combo] = image_id
    return index


def load_assets(conn: sqlite3.Connection) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for asset_id, data in conn.execute("SELECT id, data FROM track_assets"):
        try:
            out[asset_id] = json.loads(data)
        except json.JSONDecodeError:
            continue
    return out


def import_file(path: Path, name_index: dict[str, str], mapping_base: dict[str, int],
                base_headers: list[str], import_id: str) -> tuple[list[dict], FileOutcome]:
    headers, rows = parse_csv(path) if path.suffix.lower() == ".csv" else parse_xlsx(path)
    outcome = FileOutcome(name=path.name, rows=len(rows))
    # 表头文字对齐：列顺序可能变，索引不能直接复用
    mapping = dict(mapping_base)
    normalized = [re.sub(r"\s+", "", h).lower() for h in headers]
    missing = []
    for fname, base_index in mapping_base.items():
        if base_index < 0:
            continue
        want = re.sub(r"\s+", "", base_headers[base_index] or "").lower()
        hit = normalized.index(want) if want in normalized else -1
        mapping[fname] = hit
        if hit < 0 and fname in ("date", "spend", "platformId", "assetKey"):
            missing.append(base_headers[base_index] or fname)
    if missing:
        outcome.error = "表头缺少「" + "、".join(missing) + "」，已跳过"
        return [], outcome

    def cell(row: list[str], index: int) -> str:
        return (row[index] if 0 <= index < len(row) else "") or ""

    merged: dict[str, dict] = {}
    for row in rows:
        date = normalize_date(cell(row, mapping["date"]))
        platform_id = cell(row, mapping["platformId"]).strip()
        asset_name = cell(row, mapping["assetKey"]).strip()
        spend = to_number(cell(row, mapping["spend"]))
        if not date:
            outcome.skipped += 1
            continue
        key = platform_id or f"name:{asset_name}"
        if key == "name:":
            outcome.skipped += 1
            continue
        outcome.total_spend += spend
        rid = f"{key}__{date}"
        existing = merged.get(rid)
        if existing:
            existing["spend"] = round(existing["spend"] + spend, 2)
            continue
        asset_id = name_index.get(normalize_asset_name(asset_name)) if asset_name else None
        if asset_id:
            outcome.matched += 1
        else:
            outcome.unmatched += 1
        record = {"id": rid, "platformId": key}
        if asset_id:
            record["assetId"] = asset_id
        if asset_name:
            record["assetName"] = asset_name
        record.update({"date": date, "spend": round(spend, 2)})
        for fname in ("media", "productName", "designer", "optimizer"):
            value = cell(row, mapping[fname])
            if value:
                record[fname] = value
        abnormal = cell(row, mapping["abnormal"])
        if abnormal in ("1", "是"):
            record["abnormal"] = True
        preview = cell(row, mapping["previewUrl"])
        if preview:
            record["previewUrl"] = preview
        record["importId"] = import_id
        merged[rid] = record

    outcome.records = len(merged)
    outcome.total_spend = round(outcome.total_spend, 2)
    return list(merged.values()), outcome


def main() -> int:
    parser = argparse.ArgumentParser(description="批量导入素材报表到跟踪版数据库")
    parser.add_argument("paths", nargs="+", help="xlsx/csv 文件或目录")
    parser.add_argument("--db", help="数据库路径，默认跟踪版的 data.db")
    parser.add_argument("--write", action="store_true", help="真写入（不加只空跑看合计）")
    args = parser.parse_args()

    db_path = Path(args.db) if args.db else Path(
        os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local"))
    ) / "GPT SOP Tracker" / "data" / "data.db"
    if not db_path.exists():
        print(f"找不到数据库：{db_path}")
        return 2

    files: list[Path] = []
    for raw in args.paths:
        p = Path(raw)
        if p.is_dir():
            files.extend(sorted(x for x in p.iterdir() if x.suffix.lower() in (".xlsx", ".csv")))
        elif p.exists():
            files.append(p)
        else:
            print(f"跳过不存在的路径：{p}")
    files.sort(key=lambda x: x.name)
    if not files:
        print("没有可导入的文件")
        return 2

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    name_index = build_name_index(conn)
    assets = load_assets(conn)
    print(f"库：{db_path}\n文件：{len(files)} 个，交付文件名索引：{len(name_index)} 条，台账素材：{len(assets)} 个\n")

    # 列映射按第一个文件确认（与界面一致）
    first_headers, _ = (parse_csv(files[0]) if files[0].suffix.lower() == ".csv" else parse_xlsx(files[0]))
    base_mapping = detect_mapping(first_headers)
    if base_mapping["date"] < 0 or base_mapping["spend"] < 0:
        print(f"第一个文件识别不出「日期」「消耗」列，表头是：{first_headers}")
        return 2
    print("列映射：" + "，".join(
        f"{f}->{first_headers[i] if 0 <= i < len(first_headers) else '（不用）'}"
        for f, i in base_mapping.items()))
    print()

    base_id = f"imp-{int(time.time() * 1000):x}"
    outcomes: list[FileOutcome] = []
    touched: dict[str, dict] = {}
    total_records = total_spend = 0.0
    total_records = 0
    started = time.time()

    for i, path in enumerate(files):
        try:
            records, outcome = import_file(path, name_index, base_mapping, first_headers,
                                           f"{base_id}-{i + 1:03d}")
        except SystemExit as exc:
            print(f"[{i + 1}/{len(files)}] {exc}")
            continue
        except Exception as exc:  # noqa: BLE001 单个文件坏了不该中断整批
            print(f"[{i + 1}/{len(files)}] {path.name} 解析失败：{exc}")
            continue
        outcomes.append(outcome)
        if outcome.error:
            print(f"[{i + 1}/{len(files)}] {outcome.name}：{outcome.error}")
            continue

        if args.write and records:
            conn.executemany(
                "INSERT INTO track_spend (id, data, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
                [(r["id"], json.dumps(r, ensure_ascii=False), int(time.time() * 1000)) for r in records],
            )
            for r in records:
                asset_id = r.get("assetId")
                if not asset_id or asset_id not in assets:
                    continue
                asset = touched.get(asset_id) or dict(assets[asset_id])
                ids = list(asset.get("platformIds") or [])
                if r["platformId"] not in ids:
                    ids.append(r["platformId"])
                last = asset.get("lastSpendDate")
                asset["platformIds"] = ids
                asset["lastSpendDate"] = r["date"] if not last or r["date"] > last else last
                if not asset.get("firstSeenAt"):
                    asset["firstSeenAt"] = int(time.time() * 1000)
                touched[asset_id] = asset
            conn.commit()
            conn.execute(
                "INSERT INTO track_imports (id, data, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
                (f"{base_id}-{i + 1:03d}", json.dumps({
                    "id": f"{base_id}-{i + 1:03d}",
                    "fileName": outcome.name,
                    "importedAt": int(time.time() * 1000),
                    "rowCount": outcome.rows,
                    "totalSpend": outcome.total_spend,
                    "matchedCount": outcome.matched,
                    "unmatchedCount": outcome.unmatched,
                }, ensure_ascii=False), int(time.time() * 1000)),
            )
            conn.commit()

        total_records += outcome.records
        total_spend += outcome.total_spend
        print(f"[{i + 1}/{len(files)}] {outcome.name}：{outcome.rows} 行 -> {outcome.records} 条，"
              f"¥{outcome.total_spend:,.2f}，匹配 {outcome.matched} / 未匹配 {outcome.unmatched}"
              + (f"，跳过 {outcome.skipped}" if outcome.skipped else ""))

    if args.write and touched:
        conn.executemany(
            "INSERT INTO track_assets (id, data, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
            [(aid, json.dumps(a, ensure_ascii=False), int(time.time() * 1000)) for aid, a in touched.items()],
        )
        conn.commit()

    print()
    print(f"文件 {len(outcomes)} 个，流水 {total_records} 条，合计 ¥{total_spend:,.2f}，"
          f"耗时 {time.time() - started:.1f}s")
    if args.write:
        print(f"已写入：{db_path}（回软件点「刷新」）")
    else:
        print("这是空跑，没有写库。确认数字对得上再加 --write。")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
