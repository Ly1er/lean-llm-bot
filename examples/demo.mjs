/**
 * 最小可跑示例：造一份 MEMORY.md，看三段式拼出来长什么样。
 *   node examples/demo.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PromptBuilder } from '../lib/prompt-builder.js';

const cwd = './data';
mkdirSync(join(cwd, 'memory'), { recursive: true });
writeFileSync(
  join(cwd, 'memory', 'MEMORY.md'),
  `# 机器人记忆

## 中期（近 72 小时）

- 用户A 最近在准备考试

## 长期（核心）

- 用户A 喜欢喝奶茶

## 这些人（好感度）

- 123456789 用户A：+3 — 第一次见面
`,
);
writeFileSync(join(cwd, 'memory', `${new Date().toLocaleDateString('sv-SE')}.md`), '- 10:00 [私聊]用户A：今天好累\n');

const b = new PromptBuilder({
  cwd,
  persona: '你是运行在聊天软件里的助手，说话短，不解释自己在做什么。',
  memMarkers: true,
  maxDynamicTokens: 60,
});

const boot = b.bootstrapMessage();
const turn = b.turnMessage({
  header: '【来信】用户A 在 12:00 说：今天好累',
  dynamic: [{ source: 'mood', text: '情绪：平静' }],
});

console.log('=== 静态段（只投一次）===\n' + boot);
console.log(`\n静态段 ${boot.length} 字\n`);
console.log('=== 每轮增量 ===\n' + turn);
console.log(`\n本轮 ${turn.length} 字`);
