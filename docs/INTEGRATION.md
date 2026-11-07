# 集成指南：把四阶段流程接进你自己的机器人

本文只讲**思路与数据流向**，不含任何具体平台的接入代码、协议配置或第三方实现细节。
目标是让你能在任意机器人框架里复用本仓库的四个模块：

- `PromptBuilder`（静态段 / 增量 / 记忆更新）
- `DynamicBudget`（动态块预算）
- `MemoryParser`（`<mem>` 标记拦截）
- `MemoryWriter` + `UsageLedger`（落盘与成本）

---

## 1. 数据流总览

```
                  ┌─────────────────────────────┐
  收到平台消息 ──▶ │ ① 会话是否已 bootstrap？      │
                  └──────────┬──────────────────┘
                             │ 否：静态段（人设+记忆快照+当天流水）
                             │ 是：只拼本轮增量
                             ▼
                  ┌─────────────────────────────┐
                  │ ② 追加历史（只增不改）        │
                  │    当前轮图片作为多模态内容    │
                  │    历史图片降级为占位          │
                  └──────────┬──────────────────┘
                             ▼
                  ┌─────────────────────────────┐
                  │ ③ 动态块（情绪/时段/话题）    │
                  │    ≤ prompt 的 5%，放最末尾   │
                  └──────────┬──────────────────┘
                             ▼
                       调用模型生成回复
                             ▼
                  ┌─────────────────────────────┐
                  │ ④ 拦截 <mem> 标记            │
                  │    剥离 → 正文发用户          │
                  │    条目 → pending 队列        │
                  └─────────────────────────────┘
```

关键原则：**前缀只增不改**。任何对已发送内容的改写，都会让缓存前缀失效。

---

## 2. 四个阶段

### 阶段一：会话初始化（Bootstrap）

**触发条件**：某个会话第一次收到消息，或者会话被外部清理后重新开始。

**做什么**：

1. 用会话标识（私聊 ID / 群 ID）作为 key，查状态文件
2. 没有记录 → 生成静态段：
   - 人设
   - 长期记忆、中期记忆、关系表的快照
   - 当天流水（只取末尾一小段，避免开头被截断）
3. 静态段与本轮内容**合并成同一条消息**发送（不要分成两次请求，否则第一轮会多一次无意义回复）
4. 写入状态：`{ memoryHash, personaHash, bootstrappedAt }`

**注意**：

- 静态段是"会话级"的，不是"进程级"的。同一个进程里不同会话各投各的
- 静态段的字数要可控（几百字到一千字），记忆表要截断（只保留高分/近期活跃的人）
- 静态段里不要写秒级时间戳，要写就写日期

### 阶段二：消息追加

**做什么**：

- 每条新消息作为一条新的 user 消息追加，**不改动**之前的任何消息
- 当前轮带附件时：图片作为多模态内容块随消息发送；文本里只留一句"图片已随消息附上"
- 历史里的图片：不重复带图，在上下文描述里降级为"（发了图）"这类占位

**为什么**：

- 图片 token 不便宜，历史反复带图会让每一轮都在为同一张图付费
- 但当前轮必须带，否则模型看不到图，只能猜

**多模态降级链**：

```
原生图片块（首选） → 路径 + 读图提示（降级） → 纯文本占位（最后）
```

框架不支持图片块时用第二档；连文件都取不到时用第三档，并记录一次失败计数。

### 阶段三：动态块注入

**内容来源**（示例，可按需增减）：

| 来源 | 预算 | 说明 |
|---|---|---|
| 情绪 | ~30 token | 当前效价/唤醒的一句话描述 |
| 时段 | ~20 token | 早上/下午/深夜，影响语气 |
| 话题栈 | ~50 token | 当前在聊什么、未接的梗 |

**规则**：

1. 所有动态内容统一走预算管理器，登记 `(source, priority, cost)`
2. 总预算 ≤ prompt 的 5%，且有一个硬上限（如 120 token）
3. 超预算时按优先级从低到高丢弃，并记录丢弃项（用于调参）
4. 渲染结果放在**当前 user 消息的最末尾**，不要拼进静态段

**计算时机**：每次发消息前即时计算（惰性计算），不要用定时任务去"衰减"情绪——
定时任务会在会话空闲时白白消耗，也会导致同一时刻不同会话看到不同状态。

### 阶段四：记忆标记拦截

模型在回复末尾可能带结构化标记：

```
<mem section="长期" type="事实" importance="0.9">用户A 的生日是 3 月 5 日</mem>
```

**发送前必须做**：

1. 用 `MemoryParser` 全局匹配并剥离
2. 解析成功 → 追加到 `pending` 队列（一行一条 JSON，带 `ts` 和来源）
3. 解析失败 → 追加到 `pending.failed`，**不阻塞主流程**
4. 剥离后正文为空 → 不发空消息，记日志后跳过
5. 未闭合或写坏的标签也要剥掉——宁可丢，也不能让用户看到标记

**时间戳**：用"来信时间"，不是"解析时间"。两者差几秒，但决定了记忆的时序是否正确。

---

## 3. 状态管理

### 3.1 为什么需要 state 文件

state 存三个 hash 和时间戳，解决三个问题：

| 字段 | 解决什么 |
|---|---|
| `memoryHash` | 记忆文件变了没有？变了就追加一条"记忆更新"，不用重建会话 |
| `personaHash` | 人设改了吗？改了追加一次"风格更新"，让新规则立刻生效 |
| `bootstrappedAt` | 这个会话投过静态段没有？没有就投，投过就只发增量 |

只存 hash 不存正文，是为了避免"状态里留着一份旧记忆"这种更难排查的问题。

### 3.2 清会话联动（最容易漏）

会话历史被清理时，**必须同时清理 state 中对应的 key**，否则：

- 新会话没有历史 → 但 state 说"已投过静态段"
- 于是第一轮不会带人设和记忆
- 机器人看起来"突然失忆"，而且日志里没有任何报错

推荐做法：把"清历史"和"清 state"写进同一个维护脚本，顺序固定，中间不要插人工步骤。

### 3.3 记忆落盘与成本

- 白天只写 `pending`（只追加），`MEMORY.md` 一天只动一次（低峰期合并）
- 合并时去重、关系表按用户 ID 覆盖、写前备份、原子写
- 用量账本按天结算；结算过的部分与未结算增量要划清边界，避免重复计费

---

## 4. 伪代码

```text
on_message(event):
    key = event.sessionId                  # 私聊或群，唯一
    state = load_state()                   # { key: {memoryHash, personaHash, bootstrappedAt} }
    builder = get_builder()                # 进程内复用

    # ---------- ① 静态段 ----------
    static = builder.static_section()      # { text, hash, memoryHash, personaHash }
    if key not in state:
        prefix = builder.bootstrap_message()
        state[key] = { memoryHash: static.memoryHash,
                       personaHash: static.personaHash,
                       bootstrappedAt: now() }
        save_state(state)
    else if state[key].memoryHash != static.memoryHash:
        prefix = builder.memory_update_message()      # 只追加，不改历史
        state[key].memoryHash = static.memoryHash
        save_state(state)
    else if state[key].personaHash != static.personaHash:
        prefix = builder.style_update_message()
        state[key].personaHash = static.personaHash
        save_state(state)
    else:
        prefix = ""

    # ---------- ② 增量 + ③ 动态块 ----------
    dynamic = [
        { source: "mood",  text: current_mood(),   priority: 40 },
        { source: "clock", text: time_of_day(),    priority: 30 },
        { source: "topic", text: topic_stack(),    priority: 50 },
    ]
    body = builder.turn_message(
        header = format_incoming(event),
        group_context = recent_messages(key),      # 群聊才需要
        dynamic = dynamic,
        prompt_tokens = estimated_total(),
    )
    content = prefix ? prefix + "\n\n" + body : body

    # ---------- 调模型 ----------
    reply = call_model(content, images = current_turn_images(event))

    # ---------- ④ 拦截标记 ----------
    parsed = parser.parse(reply.text, ts = event.time, source = key)
    for entry in parsed.entries: append_jsonl("memory/pending.jsonl", entry)
    for bad   in parsed.failed:  append_jsonl("memory/pending.failed.jsonl", bad)

    if parsed.body == "":                       # 只有标记没有正文
        log("marker-only reply, skipped")
        return

    send(event.chatId, parsed.body)             # 发的是剥离后的正文
```

---

## 5. 失败与降级

| 场景 | 处理 |
|---|---|
| 静态段生成失败（记忆文件损坏） | 用空记忆兜底，继续发消息，记录告警 |
| 模型不支持图片 | 降级为路径提示；再失败降级为纯文本占位 |
| 标记解析失败 | 丢弃条目、剥干净正文，不影响发送 |
| 记忆合并失败 | `MEMORY.md` 不动、`pending` 保留，下次重试 |
| 预算管理器裁剪过多 | 记录丢弃项；如果连续多轮全被丢，说明预算或优先级设置有问题 |

---

## 6. 观测：怎么判断缓存有没有被破坏

不需要复杂埋点，每轮记录四个数就能归因：

| 指标 | 含义 | 异常表现 |
|---|---|---|
| `bodyTokens` | 本轮新增内容的 token | 突然变大 → 又有人往消息里塞静态内容 |
| `missTokens` | 本轮未命中 token | 明显大于 `bodyTokens` → 前缀被改写 |
| `hitTokens` | 命中 token | 应逐轮单调增长 |
| `staticHash` | 静态段指纹 | 一天内变化多次 → 有动态内容混进了静态段 |

判定规则：

- `miss ≤ body × 1.5 + 200`：正常（含 64 token 对齐和运行时上下文）
- `miss` 远超此值：检查是否改写了历史、是否把动态内容拼进静态段
- `staticHash` 一天变多次：检查变更检测是否误把流水/时间戳算进去

---

## 7. 接入检查清单

- [ ] 静态段只在会话首轮出现，之后的消息里不再包含人设和记忆
- [ ] 历史只追加，从来没有"编辑已发送消息"的逻辑
- [ ] 记忆变化走"追加更新"，不是重建会话
- [ ] 动态内容全部经预算管理器，总量 ≤5%
- [ ] 发送前一定剥离标记，用户侧永远看不到 `<mem>`
- [ ] 清会话时同步清 state
- [ ] 图片只在当前轮携带，历史降级为占位
- [ ] 有 `miss / body / staticHash` 三个观测值
