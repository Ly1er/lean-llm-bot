# 接自己的 IM：最小适配层

本仓库不包含任何平台的接入代码。你只需要写一个「事件 → 拼 Prompt → 调模型 → 发回去」的循环，
把下面四个钩子接到你的 SDK 上即可。

```js
import { PromptBuilder } from '../lib/prompt-builder.js';
import { parseMem } from '../lib/memory-parser.mjs';

const builder = new PromptBuilder({
  cwd: './data',            // memory/MEMORY.md 所在目录
  persona: '你是……',
  memMarkers: true,
  maxDynamicTokens: 120,
});

// 每个会话（私聊 / 群）各自一份状态：是否已投过静态段
const bootstrapped = new Set();

export async function onMessage(evt, { callModel, send }) {
  const key = evt.chatId;

  // ① 会话首轮：静态段 + 本轮内容；之后只投增量
  const header = `【来信】${evt.senderName}（${evt.senderId}）在 ${evt.time} 说：${evt.text}`;
  let content = builder.turnMessage({ header, groupContext: evt.groupContext ?? '' });
  if (!bootstrapped.has(key)) {
    content = builder.bootstrapMessage({ diaryChars: 650 }) + '\n\n' + content;
    bootstrapped.add(key);
  }

  // ② 调模型（支持多模态就把图片作为 image 内容块一起传）
  const reply = await callModel({ text: content, images: evt.imageBlocks ?? [] });

  // ③ 剥离记忆标记：绝不能发给用户
  const { body, entries, failed } = parseMem(reply.text, { ts: evt.time, source: key });
  for (const e of entries) appendPending('./data/memory/pending.jsonl', e);   // 自己实现：追加一行 JSON
  for (const f of failed) appendPending('./data/memory/pending.failed.jsonl', f);

  if (body) await send({ to: evt.chatId, text: body });
  return { body, entries };
}
```

## 需要你补的四个点

| # | 位置 | 说明 |
|---|---|---|
| 1 | `onMessage` 的入口 | 订阅你所用 SDK 的消息事件，填好 `chatId / senderId / text / time` |
| 2 | `callModel` | 调任意支持前缀缓存的模型；把 `content` 作为 user 消息，图片作为 image 块 |
| 3 | `send` | 调 SDK 把 `body` 发回去；**务必用剥离后的 body** |
| 4 | 定时任务 | 每天低峰期跑一次 `flush_pending.mjs` + `usage_ledger.py --write` |

## 三个容易做错的点

1. **群上下文别重复进静态段**：`groupContext` 是每轮都变的内容，走 `turnMessage` 的入参，
   不要拼进 `persona` 或记忆文件。
2. **静态段只在会话创建时投一次**：判断依据是「这个会话有没有投过」，不是「模型记不记得」。
   会话被清理后要同步清掉这个标记，否则新会话不会 bootstrap。
3. **历史只追加**：任何时候都不要改写已发送的消息；要更新记忆就调 `builder.memoryUpdateMessage()` 追加一条。

## 用现成的 IM 插件时

如果你用的是第三方 IM 插件（例如把模型接进某个聊天平台的现成桥），
通常只需要在它的「发送前」钩子里做两件事：

- 把平台事件转成上面的 `evt`，用本仓库的 `PromptBuilder` 生成 content
- 把模型输出过一遍 `parseMem`，剥离标记后再交给平台发送

不需要改插件本身的协议层，也不需要改动平台的任何客户端。
