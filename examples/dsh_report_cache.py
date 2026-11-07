#!/usr/bin/env python3
"""T16 缓存归因报告：把 miss 拆成「新消息 / 运行时上下文 / 前缀异常」。

用法：
    python3 report_cache.py                 # 看最近一个会话
    python3 report_cache.py <session.v4.jsonl.zstd>

判据：
    每轮第一步的 inputTokens(miss) ≈ 新 user 消息 + runtime context（+64 token 粒度对齐）。
    明显大于这个数 → 前缀被改写（静态段/历史被动了），标 PREFIX-BREAK。
"""
import glob
import json
import os
import re
import subprocess
import sys

DSH_HOME = os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh-bot"))
PATTERN = os.path.join(DSH_HOME, "sessions", "*", "*/session.v4.jsonl.zstd")


def tokens(text: str) -> int:
    cjk = len(re.findall(r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]", text or ""))
    other = len(text or "") - cjk
    return cjk + (other + 3) // 4


def load(path: str):
    raw = subprocess.run(["zstd", "-dc", path], capture_output=True).stdout.decode("utf-8", "ignore")
    return [json.loads(l) for l in raw.splitlines() if l.strip()]


def load_metrics():
    path = os.path.join(DSH_HOME, "qq-moony", "prompt-v2-metrics.jsonl")
    rows = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    rows.sort(key=lambda r: r.get("ts", 0))
    return rows


def session_path_for(sid):
    if not sid:
        return None
    hits = [p for p in glob.glob(PATTERN) if os.path.basename(os.path.dirname(p)) == sid]
    return max(hits, key=os.path.getmtime) if hits else None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        # 优先看 V2 埋点属于哪个会话，别被 V1 会话文件抢走
        ms = load_metrics()
        path = session_path_for(ms[-1].get("session")) if ms else None
        if not path:
            files = [p for p in glob.glob(PATTERN) if os.path.getsize(p) > 0]
            if not files:
                print("没有会话文件")
                return 1
            path = max(files, key=os.path.getmtime)
    rows = load(path)
    sid = os.path.basename(os.path.dirname(path))
    print(f"会话: {path}")

    sys_hashes = []
    for r in rows:
        if r.get("type") == "system/message":
            t = r["data"]["message"]["content"][0]["text"]
            sys_hashes.append((r["data"]["turn"], len(t), hash(t)))
    if sys_hashes:
        uniq = len({h for _, _, h in sys_hashes})
        print(f"system 消息: {len(sys_hashes)} 条, 不同版本 {uniq} 个 → {'稳定' if uniq == 1 else '不稳定！'}")

    turn = 0
    new_msgs = []
    printed = 0
    for r in rows:
        t = r.get("type")
        if t == "turn/start":
            turn = r["data"]["turn"]
            new_msgs = []
        elif t == "user/message":
            txt = r["data"]["content"][0]["text"]
            new_msgs.append(txt)
        elif t == "assistant/message":
            u = r["data"].get("usage") or {}
            miss = u.get("inputTokens", 0) or 0
            hit = u.get("cacheReadTokens", 0) or 0
            if miss + hit <= 0:
                continue
            if r["data"].get("step") != 1:
                continue  # 只看每轮第一步，后续 step 是工具续跑
            ctx = next((m for m in new_msgs if m.startswith("Current runtime context")), "")
            body = [m for m in new_msgs if not m.startswith("Current runtime context")]
            body_tok = sum(tokens(m) for m in body)
            ctx_tok = tokens(ctx)
            expect = body_tok + ctx_tok
            flag = ""
            if miss > expect * 1.5 + 150:
                flag = "  << PREFIX-BREAK"
            rate = hit / (miss + hit)
            print(
                f"turn {turn:>3}  miss={miss:>5}  hit={hit:>6}  rate={rate*100:5.1f}%"
                f"  body={body_tok:>4}  ctx={ctx_tok:>4}  expect≈{expect:>5}{flag}"
            )
            printed += 1

    if printed == 0:
        print("没有可分析的请求（可能还没跑过回合）")
    else:
        print_metrics(sid)
    group_report(rows)
    return 0


def group_report(session_rows):
    """按群/私聊拆分：命中率、miss、body、上下文 token、动态占比、PREFIX-BREAK。"""
    metrics = load_metrics()
    if not metrics:
        return

    replies = []
    for r in session_rows:
        if r.get("type") != "assistant/message":
            continue
        d = r.get("data") or {}
        if d.get("step") != 1:
            continue
        ts = r.get("time")
        if not isinstance(ts, (int, float)):
            continue
        u = d.get("usage") or {}
        replies.append((ts, u.get("inputTokens", 0) or 0, u.get("cacheReadTokens", 0) or 0))
    replies.sort()

    buckets = {}
    for i, m in enumerate(metrics):
        lo = m.get("ts", 0) - 500
        hi = metrics[i + 1]["ts"] if i + 1 < len(metrics) else lo + 600000
        hit_rows = [x for x in replies if lo <= x[0] < hi]
        if not hit_rows:
            continue
        miss = sum(x[1] for x in hit_rows)
        hit = sum(x[2] for x in hit_rows)
        key = f"群 {m.get('group')}" if m.get("kind") == "group" else "私聊"
        b = buckets.setdefault(key, {"n": 0, "miss": 0, "hit": 0, "body": 0, "ctx": 0, "dyn": 0, "break": 0})
        b["n"] += 1
        b["miss"] += miss
        b["hit"] += hit
        b["body"] += m.get("bodyTokens", 0)
        b["ctx"] += m.get("ctxTokens", 0)
        b["dyn"] += ((m.get("dynamic") or {}).get("registeredTokens", 0))
        if miss > m.get("bodyTokens", 0) * 1.5 + 250:
            b["break"] += 1

    if not buckets:
        return
    print()
    print("按会话拆分（V2 埋点 + 会话 usage）：")
    print(f"{'范围':16s}{'轮数':>4s}{'命中率':>8s}{'miss均':>7s}{'band均':>7s}{'上下均':>7s}{'动态%':>7s}{'BREAK':>6s}")
    for key in sorted(buckets):
        b = buckets[key]
        tot = b["miss"] + b["hit"]
        rate = b["hit"] / tot * 100 if tot else 0
        denom = b["body"] + b["dyn"]
        dynp = b["dyn"] / denom * 100 if denom else 0
        print(
            f"{key:16s}{b['n']:>4d}{rate:>7.1f}%{b['miss']/b['n']:>7.0f}{b['body']/b['n']:>7.0f}"
            f"{b['ctx']/b['n']:>7.0f}{dynp:>6.1f}%{b['break']:>6d}"
        )


def print_metrics(sid: str):
    """汇总 V2 埋点：body 均值、bootstrap 次数、动态块占比。"""
    path = os.path.join(DSH_HOME, "qq-moony", "prompt-v2-metrics.jsonl")
    if not os.path.exists(path):
        return
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("session") == sid:
                rows.append(r)
    if not rows:
        return
    body = [r.get("bodyTokens", 0) for r in rows]
    dyn = [((r.get("dynamic") or {}).get("registeredTokens", 0)) for r in rows]
    boot = sum(1 for r in rows if r.get("bootstrap"))
    upd = sum(1 for r in rows if r.get("记忆更新"))
    total_dyn = sum(dyn)
    total_msg = sum(body) + total_dyn
    ratio = (total_dyn / total_msg * 100) if total_msg else 0
    print()
    print(f"V2 埋点: {len(rows)} 轮, bootstrap {boot} 次, 记忆更新 {upd} 次")
    print(f"body token: 均值 {sum(body)/len(body):.0f}, 最小 {min(body)}, 最大 {max(body)}")
    print(f"动态块 token: 合计 {total_dyn}, 占本轮消息 {ratio:.1f}%（上限 5%，当前未接情绪/作息）")


if __name__ == "__main__":
    sys.exit(main())
