# 模块接口

所有模块都不依赖具体 IM 平台。路径参数都可以用环境变量或显式参数覆盖。

## budget.js

```js
import { DynamicBudget, estimateTokens } from './lib/budget.js';

const b = new DynamicBudget({ maxTokens: 120, onDrop: (info) => {} });
b.add('mood', '情绪：平静', { priority: 40, hard: false }); // 同 source 覆盖
b.remove('mood');
const text = b.render();       // 超预算按优先级丢弃，输出稳定
const stats = b.stats();       // { maxTextTokens, registered, registeredTokens, dropped }
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `maxTokens` | number | 动态块 token 上限 |
| `estimator` | `(text)=>number` | 自定义 token 估算，默认 CJK 1 字 1 token、其它 4 字符 1 token |
| `onDrop` | `(info)=>void` | 丢弃埋点 |

入口参数：`source`（唯一键）、`text`、`priority`（越大越先保留）、`hard`（永不丢弃）。

## prompt-builder.js

```js
const b = new PromptBuilder({
  cwd, persona, memMarkers = true, maxDynamicTokens = 120, log,
});

b.staticSection({ diaryChars = 650 })  // -> { text, hash, memoryHash, diaryHash, diary }
b.bootstrapMessage({ diaryChars })     // -> string（会话首条，一次性）
b.memoryUpdateMessage()                // -> string | null（记忆变了才返回）
b.turnMessage({ header, groupContext, dynamic, promptTokens })
b.checkAppendOnly(messages)            // -> boolean（历史被改写会返回 false）
b.stats()                              // -> { staticHash, staticTokens, dynamic }
```

约定：
- `memory/MEMORY.md` 需包含 `## 中期` / `## 长期` / `## 这些人` 三段（缺段自动跳过）
- `memory/YYYY-MM-DD.md` 是当天流水，只取末尾 `diaryChars` 字，**不参与**变更判定
- 静态段只在会话冷启动时投递；记忆变化时只追加更新消息

## memory-parser.mjs

```js
import { parseMem, cleanMemContent, formatTs } from './lib/memory-parser.mjs';

const { body, entries, failed } = parseMem(modelText, { ts, source });
```

- 标记格式：`<mem section="长期" type="事实" importance="0.9">内容</mem>`
- `section` 白名单：`中期` / `长期` / `这些人`；非法进 `failed`
- `importance` 缺省 0.5，非数字丢弃，越界截断到 0~1
- 未闭合/坏标签也会被剥离，绝不漏给用户
- `body` 是剥离后的正文（可能为空，调用方应跳过发送）

`entries[]` 字段：`{ section, type, importance, content, ts, source }`

## memory-writer.mjs

```js
const w = new MemoryWriter({ memoryDir, maxMid = 40, backupKeep = 10, log });
w.write({ section, type, content, importance, ts });
// -> { ok: true, backup } | { ok: false, reason: 'duplicate' | '未知 section: x' | 'content 为空' }
```

行为：
- 去重忽略标点/空白；`这些人` 段按开头的 QQ/用户 ID 覆盖更新
- 写前备份 `MEMORY.md.bak_时间戳`，保留最近 10 份
- tmp + rename 原子写；中期超过 `maxMid` 裁最旧
- 成功写入后追加 `pending.jsonl`（仅追加，方便回放）

CLI：

```bash
MEMORY_DIR=./data/memory node lib/memory-writer.mjs --section 长期 --content "用户A喜欢喝奶茶" --importance 0.8
```

## usage_ledger.py

```bash
USAGE_DATA_DIR=./data python3 lib/usage_ledger.py --write
USAGE_DATA_DIR=./data python3 lib/usage_ledger.py          # 只打印
```

读取 `USAGE_SESSIONS_DIR` 下的会话文件（默认 `*.jsonl.zstd`，用 `zstd -dc` 解压），
按本地日期汇总，写成 `usage_daily.jsonl`：

```json
{"date":"2026-11-07",
 "sessions":{"bot":{"req":38,"new_in":19020,"cache_hit":250496,"out":2186,"tokens":271702,"hit_rate":0.9295,"cost_est":0.032774}},
 "total":{"req":38,"new_in":19020,"cache_hit":250496,"out":2186,"tokens":271702,"hit_rate":0.9295,"cost_est":0.032774},
 "settled_until":1700000000000,
 "written_at":"2026-11-07T18:07:58+08:00"}
```

- 同日期覆盖，不会出现两行
- `settled_until` 是本批包含的最后一条请求时间戳，给看门狗算增量用
- 若某天已有 `"source":"platform"` 行（平台账单补录），本地重算不会覆盖

会话格式适配：`read_session()` / 事件字段 `type=assistant/message`、`time`、`data.usage.{inputTokens,cacheReadTokens,outputTokens}`。
其它框架只需改这两个函数。

## cost_guard.py

```bash
DAILY_LIMIT=2.7 PAUSE_CMD="systemctl --user stop my-bot" python3 lib/cost_guard.py
```

- 当日 = 账本今日 `cost_est` + `time > settled_until` 的会话增量
- 未超限返回 0；超限返回 3
- 未设置 `PAUSE_CMD` 时只告警，不执行任何动作

## examples/dsh_report_cache.py

按轮/按群拆命中率、miss、body、上下文 token、动态块占比、PREFIX-BREAK 次数。
仅适用于 DeepSeek Harness 的会话格式（`sessions/*/<sid>/session.v4.jsonl.zstd`），
`DSH_HOME` 可覆盖根目录。

## 环境变量一览（所有外部路径都可覆盖）

| 变量 | 默认 | 作用 |
|---|---|---|
| `USAGE_DATA_DIR` | `./data` | 数据根目录 |
| `USAGE_SESSIONS_DIR` | `<data>/sessions` | 会话文件目录（`*.jsonl.zstd`） |
| `USAGE_LEDGER` | `<data>/memory/usage_daily.jsonl` | 用量账本路径 |
| `MEMORY_DIR` | `./data/memory` | `MEMORY.md` / `pending.jsonl` 所在目录 |
| `DAILY_LIMIT` | `2.7` | 每日成本上限（元） |
| `PAUSE_CMD` | 空 | 超线后执行的命令；空则只告警 |
| `DSH_HOME` | `~/.dsh-bot` | `examples/dsh_report_cache.py` 的根目录 |

`prompt-builder.js` / `budget.js` / `memory-parser.mjs` / `memory-writer.mjs`
不读环境变量，全部通过构造参数或函数入参传入，方便嵌入任何框架。
Python 侧只依赖标准库；读取 `.zstd` 会话需要系统安装 `zstd` 命令。
