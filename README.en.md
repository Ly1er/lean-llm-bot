# Cut LLM Chatbot Costs by 90% with Prefix Caching

[中文](README.md) | English

> Same model, same bot. Only the way the prompt is organized changed, and the cost per turn
> dropped from **¥0.0321 to ¥0.0024** (-92.5%).
> We did not shrink the model — we stopped re-sending what never changes.

**Built with DeepSeek Harness; developed with assistance from DeepSeek V4.1 Flash.**

> Unofficial project. Not affiliated with, endorsed by, or partnered with DeepSeek or Tencent.

---

## 1. Real numbers

Window: V1 = Nov 1–2 (naive layout), V2 = Nov 7–8 (three-stage).
Both use `deepseek-flash` (V4.1 Flash, build 1017), priced from the platform billing export
(cache hit ¥0.02/M, cache miss ¥1/M, output ¥4/M). Turn counts are almost identical (161 vs 163),
so the two columns compare the same workload.

| | V1 (naive) | V2 (three-stage) | Change |
|---|---|---|---|
| Turns | 161 | 163 | +1.2% |
| Requests | 540 | 369 | -31.7% |
| Total tokens | 14,083,169 | 6,196,913 | -56.0% |
| Tokens per turn | 87,473 | 38,018 | -56.5% |
| **Uncached tokens per turn** | **17,672** | **1,029** | **-94.2%** |
| Cache hit rate | 79.0% | 97.3% | +18.3pp |
| Total cost | ¥5.1726 | ¥0.3906 | -92.4% |
| **Cost per turn** | **¥0.0321** | **¥0.0024** | **-92.5%** |
| Cost per request | ¥0.00958 | ¥0.00106 | -89.0% |

Cost per turn drops **92.5%**, and almost all of it comes from uncached input: 17,672 → 1,029.
Total tokens per turn fall only 56.5% — the win is not a smaller context, it is making the context cacheable.

In steady state (excluding bootstrap and image turns) each turn carries ~260 uncached tokens:
186 for the turn body, 0–63 for 64-token alignment, ~30 for runtime context.
Per-day and per-turn detail: [`docs/COMPARISON.md`](docs/COMPARISON.md).

## 2. Why the naive version is expensive

The old version stuffed three things into **every** user message: persona (400+ chars),
the last 1000 chars of the memory file, and the last 8 group messages. Each turn therefore
carried 1600+ fresh characters — content that can never be cached.

Prefix caching only matches a byte-identical prefix from the start. New content always sits
at the end, so nothing is saved. Attribution confirmed it: miss tokens ≈ new message length +
runtime context, i.e. no prefix breakage — just too much new content per turn.

## 3. Three-stage prompt

```
┌─────────────────────────────────────┐
│ ① Static: persona + memory snapshot  │  sent once per session, byte-identical afterwards
├─────────────────────────────────────┤
│ ② History: append-only               │  never rewritten
├─────────────────────────────────────┤
│ ③ Dynamic block: this turn (≤5%)     │  changes each turn, but sits at the very end
└─────────────────────────────────────┘
```

Rules:

- The static block is the first message of a session and is sent **once**
- Memory changes are appended as an update message; history is never rewritten
- Everything volatile (mood, time-of-day, topic stack) goes through a budget manager capped at ~5%
- Change detection hashes only stable content — never the daily-growing log

## 4. Layout

```
├── demo.js               # zero-config demo: static-once + dynamic block + simulated hit rate
├── lib/
│   ├── budget.js         # dynamic-block budget: register / priority / drop / metrics
│   ├── prompt-builder.js # three-stage assembly, memory snapshot, append-only check
│   ├── memory-parser.mjs # <mem> marker parsing, stripping, content cleanup
│   ├── memory-writer.mjs # segmented writes, dedupe, backup, atomic write, pending queue
│   ├── usage_ledger.py   # daily token/cost settlement
│   └── cost_guard.py     # daily budget guard (ledger + incremental, no double counting)
├── tests/                # 21 unit tests, no network
├── examples/             # minimal prompt example + cache attribution report (DSH adapter)
├── docs/                 # interfaces, adapter guide, integration guide
├── cleanup.sh            # pre-publish secret scan (supports --fix)
└── README.md / README.en.md
```

## 5. Quick start (no API key)

```bash
node demo.js     # or: npm run demo
npm test         # Node >= 22
```

`demo.js` prints:

1. The full static block, and the fact that it is sent only once
2. Per-turn body size (20–30 tokens) across six turns
3. A simulated cache ledger: 94–97% hit rate from turn 2, plus V1 vs V2 cost
4. Budget behaviour: with a 12-token budget, the low-priority mood block is dropped

## 6. Memory write path

The model may end a reply with:

```
<mem section="long_term" type="fact" importance="0.9">User A's birthday is March 5</mem>
```

- Parsed and stripped on the sender side — **users never see the marker**
- Accepted entries are appended to `memory/pending.jsonl`
- A nightly job merges pending into `MEMORY.md`: dedupe, overwrite by user ID, backup, atomic write
- During the day `MEMORY.md` is never touched

## 7. Cost ledger and guard

- `usage_ledger.py --write` settles usage per day into `usage_daily.jsonl` (one line per day, idempotent)
- `cost_guard.py` computes today = settled cost from the ledger + sessions after `settled_until`
- `settled_until` prevents double counting: if a ledger was written mid-day, only the delta is added

## 8. Pitfalls

1. Never put volatile content in the system/static block — it re-sends the prefix every turn
2. Second-level timestamps in the static block break the prefix; use a date, or move it to the dynamic block
3. Restart after editing the static block — the old code is still loaded in the process
4. Do not include the daily-growing log in change detection
5. When clearing sessions, clear the bootstrap state too — otherwise the new session is never bootstrapped
6. Text arriving before its image causes a "where's the picture?" reply — merge within a short window
7. Never "tidy up" already-sent history; append updates instead

## 9. Contributing & Roadmap

Issues and PRs are welcome. Before submitting:

```bash
npm test && ./cleanup.sh
```

Roadmap: native multimodal images, emotion half-life decay, SQLite + FTS5 memory,
per-group static variants, adapters for other session formats.

## 10. License & disclaimer

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Core ideas come from the practice of **dsh (DeepSeek Harness)** and **qq-moony**; thanks to the authors.
This repository contains only platform-agnostic prompt/memory/cost modules — no account integration code.

- Not affiliated with, endorsed by, or partnered with DeepSeek or Tencent.
- If you connect this to a third-party platform, you are responsible for complying with its terms and local law.
- Provided "as is", without warranty of any kind.
