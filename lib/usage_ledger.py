#!/usr/bin/env python3
"""usage_daily.jsonl：把会话里的 token 用量按天结算落盘。

为什么要有它：cost_guard 原来直接从会话文件算钱，nightly 清会话后归零，
2.7 元/天的硬线等于没有。这里在清会话之前把当天（以及会话里残留的其他日期）
结算成一行 JSON，之后 cost_guard 读账本 + 未结算增量。

格式（一天一行，按日期升序）：
{"date":"2026-11-07",
 "sessions":{"qq-moony-v2":{"req":27,"new_in":11808,"cache_hit":198784,"out":1326,"hit_rate":0.944}},
 "total":{"req":37,"new_in":17804,"cache_hit":250496,"out":2178,"tokens":270478,"cost_est":0.078,"hit_rate":0.934},
 "settled_until":1700000000000,
 "written_at":"2026-11-07T17:40:00+08:00"}

用法：
    python3 usage_ledger.py --write    # 汇总会话里所有日期，幂等写账本（同日期覆盖）
    python3 usage_ledger.py --print    # 只看，不写
"""

import json
import os
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# 三个路径都可用环境变量覆盖，默认放在工作目录下的 data/
DATA_DIR = Path(os.environ.get("USAGE_DATA_DIR", "./data"))
SESS_DIR = Path(os.environ.get("USAGE_SESSIONS_DIR", DATA_DIR / "sessions"))
LEDGER = Path(os.environ.get("USAGE_LEDGER", DATA_DIR / "memory" / "usage_daily.jsonl"))

# 与 cost_guard 保持同一口径（偏高估，宁可早停）
PRICE_CACHE = 0.02 / 1_000_000   # 平台账单：input_cache_hit 2e-8 元/token
PRICE_IN = 1.0 / 1_000_000      # input_cache_miss 1e-6 元/token
PRICE_OUT = 4.0 / 1_000_000     # output 4e-6 元/token


def session_files():
    return sorted(SESS_DIR.glob("*/*/session.v4.jsonl.zstd"))


def read_session(path):
    try:
        raw = subprocess.run(
            ["zstd", "-dc", str(path)], capture_output=True, timeout=90
        ).stdout.decode("utf-8", "ignore")
    except (OSError, subprocess.SubprocessError):
        return []
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _bucket():
    return {"req": 0, "new_in": 0, "cache_hit": 0, "out": 0}


def _finish(b):
    tokens = b["new_in"] + b["cache_hit"] + b["out"]
    total_in = b["new_in"] + b["cache_hit"]
    b["tokens"] = tokens
    b["hit_rate"] = round(b["cache_hit"] / total_in, 4) if total_in else 0.0
    b["cost_est"] = round(
        b["cache_hit"] * PRICE_CACHE + b["new_in"] * PRICE_IN + b["out"] * PRICE_OUT, 6
    )
    return b


def collect():
    """按本地日期汇总所有会话。返回 {date: {"sessions": {...}, "total": {...}, "settled_until": ms}}"""
    days = defaultdict(lambda: {"sessions": defaultdict(_bucket), "settled_until": 0})
    for f in session_files():
        name = f.parent.name
        for r in read_session(f):
            if r.get("type") != "assistant/message":
                continue
            ts = r.get("time")
            if not isinstance(ts, (int, float)):
                continue
            day = datetime.fromtimestamp(ts / 1000).date().isoformat()
            u = (r.get("data") or {}).get("usage") or {}
            b = days[day]["sessions"][name]
            b["req"] += 1
            b["new_in"] += u.get("inputTokens", 0) or 0
            b["cache_hit"] += u.get("cacheReadTokens", 0) or 0
            b["out"] += u.get("outputTokens", 0) or 0
            days[day]["settled_until"] = max(days[day]["settled_until"], int(ts))

    result = {}
    for day, info in days.items():
        total = _bucket()
        sessions = {}
        for name, b in info["sessions"].items():
            _finish(b)
            sessions[name] = b
            for k in ("req", "new_in", "cache_hit", "out"):
                total[k] += b[k]
        result[day] = {
            "date": day,
            "sessions": sessions,
            "total": _finish(total),
            "settled_until": info["settled_until"],
        }
    return result


def load_ledger(path=LEDGER):
    rows = {}
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("date"):
            rows[r["date"]] = r
    return rows


def upsert(new_rows, path=LEDGER):
    """同日期覆盖，始终一天一行；原子写。"""
    rows = load_ledger(path)
    for day, r in new_rows.items():
        # 平台账单补录的行（source=platform）是权威数据，本地会话重算不能覆盖它
        if (rows.get(day) or {}).get("source") == "platform":
            continue
        r["written_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        rows[day] = r
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    text = "\n".join(json.dumps(rows[d], ensure_ascii=False) for d in sorted(rows)) + "\n"
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return rows


def main():
    rows = collect()
    if "--write" in sys.argv:
        merged = upsert(rows)
        print(f"已写入 {LEDGER}（{len(merged)} 天）")
        for d in sorted(merged):
            t = merged[d]["total"]
            print(f"  {d}  {t['req']:>4} 次  {t['tokens']:>10,} token  {t['cost_est']:>7.3f} 元  命中 {t['hit_rate']*100:.1f}%")
        return 0
    for d in sorted(rows):
        t = rows[d]["total"]
        print(f"{d}  {t['req']:>4} 次  {t['tokens']:>10,} token  {t['cost_est']:>7.3f} 元  命中 {t['hit_rate']*100:.1f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
