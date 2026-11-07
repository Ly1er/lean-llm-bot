#!/usr/bin/env python3
"""每日成本看门狗：账本（已结算）+ 会话增量（未结算）→ 当日花费。

设计要点：
  - 结算过的部分存在 usage_daily.jsonl，会话被清理也不会丢
  - settled_until 划出边界，同一天的用量不会被算两遍
  - 超线动作可插拔：设置 PAUSE_CMD 才会执行（默认只告警）

环境变量：
  USAGE_DATA_DIR       数据目录（默认 ./data）
  USAGE_LEDGER         账本路径（默认 <data>/memory/usage_daily.jsonl）
  USAGE_SESSIONS_DIR   会话目录（默认 <data>/sessions）
  DAILY_LIMIT          每日上限（元，默认 2.7）
  PAUSE_CMD            超线后执行的命令，例如 "systemctl --user stop my-bot"

退出码：0 正常，3 超线
"""

import os
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from usage_ledger import LEDGER, PRICE_CACHE, PRICE_IN, PRICE_OUT, load_ledger, read_session, session_files

LIMIT = float(os.environ.get("DAILY_LIMIT", "2.7"))
PAUSE_CMD = os.environ.get("PAUSE_CMD", "").strip()


def today_cost():
    """今日累计 = 账本今日已结算 + 边界之后的会话增量。"""
    today = date.today().isoformat()
    row = load_ledger(LEDGER).get(today) or {}
    settled_cost = float((row.get("total") or {}).get("cost_est", 0) or 0)
    cut = int(row.get("settled_until", 0) or 0)

    cache = miss = out = 0
    for f in session_files():
        for r in read_session(f):
            if r.get("type") != "assistant/message":
                continue
            ts = r.get("time")
            if not isinstance(ts, (int, float)) or ts <= cut:
                continue
            if datetime.fromtimestamp(ts / 1000).date().isoformat() != today:
                continue
            u = (r.get("data") or {}).get("usage") or {}
            cache += u.get("cacheReadTokens", 0) or 0
            miss += u.get("inputTokens", 0) or 0
            out += u.get("outputTokens", 0) or 0

    live = cache * PRICE_CACHE + miss * PRICE_IN + out * PRICE_OUT
    return settled_cost + live, {
        "cache": cache,
        "input": miss,
        "output": out,
        "settled": settled_cost,
        "live": live,
    }


def main():
    cost, used = today_cost()
    print(
        f"今日估算 {cost:.4f} 元 / 上限 {LIMIT:.2f} 元"
        f"（缓存 {used['cache']:,}｜新输入 {used['input']:,}｜输出 {used['output']:,}"
        f"｜已结算 {used['settled']:.4f} + 增量 {used['live']:.4f}）"
    )
    if cost < LIMIT:
        return 0

    print(f"已超过每日上限 {LIMIT} 元", file=sys.stderr)
    if not PAUSE_CMD:
        print("未设置 PAUSE_CMD，只告警不执行动作", file=sys.stderr)
        return 3
    try:
        subprocess.run(PAUSE_CMD, shell=True, check=False, timeout=60)
        print(f"已执行 PAUSE_CMD：{PAUSE_CMD}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"PAUSE_CMD 执行失败：{exc}", file=sys.stderr)
    return 3


if __name__ == "__main__":
    sys.exit(main())
