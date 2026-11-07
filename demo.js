/**
 * 零配置 Demo：不需要 API Key，直接看三段式 prompt 和缓存账怎么算。
 *
 *   node demo.js
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PromptBuilder } from './lib/prompt-builder.js';
import { estimateTokens } from './lib/budget.js';

// ---------- 0. 造一份 mock 记忆 ----------
const cwd = './data';
mkdirSync(join(cwd, 'memory'), { recursive: true });
writeFileSync(
  join(cwd, 'memory', 'MEMORY.md'),
  `# 机器人记忆

## 中期（近 72 小时）

- 用户A 最近在准备考试
- 用户B 问过部署问题

## 长期（核心）

- 用户A 喜欢喝奶茶，不加糖
- 用户A 的昵称是小A

## 这些人（好感度）

- 123456789 用户A：+5 — 聊得来
- 987654321 用户B：+0 — 刚认识
`,
);
writeFileSync(
  join(cwd, 'memory', `${new Date().toLocaleDateString('sv-SE')}.md`),
  ['- 09:00 [私聊]用户A：早', '- 09:05 [私聊]用户A：今天有点困', '- 09:06 [群]用户B：部署卡住了'].join('\n') + '\n',
);

// 账单单价（元/token，按 DeepSeek 公开计费口径）：缓存命中 2e-8、未命中 1e-6、输出 4e-6
const P = { hit: 2e-8, miss: 1e-6, out: 4e-6 };
const cost = (hit, miss, out) => hit * P.hit + miss * P.miss + out * P.out;

// ---------- 1. 拼三段式 ----------
const b = new PromptBuilder({
  cwd,
  persona: '你是聊天软件里的助手。说话短，不点句号；别解释自己在做什么。',
  memMarkers: true,
  maxDynamicTokens: 120,
});

const bootstrap = b.bootstrapMessage({ diaryChars: 650 });
const staticTokens = estimateTokens(bootstrap);

const turns = [
  '今天好累',
  '帮我想个晚饭',
  '不想吃太油的',
  '那就随便吧',
  '你平时会困吗',
  '晚安',
];

console.log('=== ① 静态段：只在会话第一轮发一次 ===');
console.log(bootstrap);
console.log(`\n[静态段] ${bootstrap.length} 字 ≈ ${staticTokens} token\n`);

console.log('=== ② 每轮只发增量（含动态块） ===');
const bodies = [];
turns.forEach((text, i) => {
  const msg = b.turnMessage({
    header: `【来信】用户A 在 ${String((14 + i) % 24).padStart(2, '0')}:00 说：${text}`,
    dynamic: [
      { source: 'mood', text: i % 2 === 0 ? '情绪：有点累' : '', priority: 40 },
      { source: 'time', text: `作息：${i < 3 ? '下午' : '晚上'}`, priority: 30 },
    ].filter((x) => x.text),
    promptTokens: 8000,
  });
  const t = estimateTokens(msg);
  bodies.push(t);
  console.log(`  turn${i + 1}  body=${String(t).padStart(3)} token  「${msg.split('\n')[0].slice(0, 28)}…」`);
});

// ---------- 2. 模拟缓存命中 ----------
console.log('\n=== ③ 缓存账（模拟，按 DeepSeek 前缀缓存规则） ===');
console.log('假设：静态段之后历史只追加，每轮新增 body 就是未命中部分；其余全部命中上一轮前缀。\n');

let total = staticTokens + bodies[0];
let accV1 = cost(0, total, 20); // V1：每轮都把 1000 token 的人设+记忆重发
console.log(`turn1  前缀 miss=${total}  hit=0        命中率   0.0%`);
for (let i = 1; i < bodies.length; i += 1) {
  const miss = bodies[i];
  const hit = total;
  const rate = hit / (hit + miss);
  total += miss;
  accV1 += cost(0, 1000 + bodies[i], 20); // V1 假设每轮重发 1000 token
  console.log(
    `turn${i + 1}  前缀 miss=${String(miss).padStart(3)}  hit=${String(hit).padStart(5)}   ` +
      `命中率 ${(rate * 100).toFixed(1)}%`,
  );
}

const v2Hit = total - bodies[0] - bodies.slice(1).reduce((a, x) => a + x, 0);
const v2Cost = cost(v2Hit, staticTokens + bodies.slice(1).reduce((a, x) => a + x, 0), 20 * 6);
console.log(`\nV2 六轮成本 ≈ ${v2Cost.toFixed(5)} 元`);
console.log(`V1 同样六轮（每轮重发人设+记忆）≈ ${accV1.toFixed(5)} 元`);
console.log(`省下 ≈ ${(((accV1 - v2Cost) / accV1) * 100).toFixed(0)}%\n`);

console.log('=== ④ 动态块预算：超了会按优先级丢 ===');
const small = new PromptBuilder({ cwd, persona: 'x', maxDynamicTokens: 12 });
const t1 = small.turnMessage({
  header: '测试',
  dynamic: [
    { source: 'topic', text: '在聊晚饭吃什么', priority: 90 },
    { source: 'mood', text: '情绪：有点累', priority: 10 },
  ],
});
console.log(`预算 12 token 时输出：${JSON.stringify(t1.replace('测试\n\n', ''))}`);
console.log('（低优先级的「情绪」被丢弃，高优先级的「话题」保留）');
