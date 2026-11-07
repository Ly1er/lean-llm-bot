import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryWriter } from '../lib/memory-writer.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
};

const SAMPLE = `# 机器人记忆

## 中期（近 72 小时）

这是摘要段落，合并时不能被冲掉。

## 长期（核心）

- 用户A来过

## 这些人（好感度）

- 123456789 用户A：+3 — 第一次见面
`;

const dir = mkdtempSync(join(tmpdir(), 'mw-'));
writeFileSync(join(dir, 'MEMORY.md'), SAMPLE);
const w = new MemoryWriter({ memoryDir: dir });
const md = () => readFileSync(join(dir, 'MEMORY.md'), 'utf8');

console.log('memory-writer: 分段与去重');
ok('写入长期', w.write({ section: '长期', content: '用户A喜欢喝奶茶' }).ok);
ok('条目落盘', md().includes('- 用户A喜欢喝奶茶'));
ok('中期摘要保留', md().includes('这是摘要段落，合并时不能被冲掉。'));

const dup = w.write({ section: '长期', content: '用户A喜欢喝奶茶。' });
ok('标点差异判重', dup.ok === false && dup.reason === 'duplicate');

console.log('memory-writer: 好感度覆盖');
w.write({ section: '这些人', content: '123456789 用户A：+8 — 今天聊了很久' });
const rel = md().split('## 这些人')[1];
ok('同 QQ 只留一行', (rel.match(/123456789/g) ?? []).length === 1);
ok('分数被更新', rel.includes('+8 — 今天聊了很久'));

console.log('memory-writer: 备份与原子写');
ok('有备份', readdirSync(dir).some((n) => n.startsWith('MEMORY.md.bak_')));
ok('无残留 tmp', !existsSync(join(dir, 'MEMORY.md.tmp')));

console.log('memory-writer: 内容清洗');
w.write({ section: '中期', content: '我userB：群友' , importance: 0.3 });
ok('粘连「我」被去掉', md().includes('- userB：群友'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
