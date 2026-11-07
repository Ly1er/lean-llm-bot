/**
 * memory-writer：机器人记忆写入通道（阶段一，独立于线上插件）
 *
 * 目标：把「结构化条目」安全地写进 MEMORY.md，替代 agent 直接 read/edit/write。
 *  - 分段：中期 / 长期 / 这些人（好感度）
 *  - 去重：同段同内容只留一条；好感度按 QQ 号覆盖更新
 *  - 备份：写前留 .bak_时间戳，保留最近 10 份
 *  - 暂存：memory/pending.jsonl 追加一行，写入失败也能回放
 *  - 原子：先写 tmp 再 rename，半截写坏不会污染记忆
 *
 * 用法（API）：
 *   const w = new MemoryWriter({ memoryDir });
 *   w.write({ section: '长期', type: 'fact', content: '我怕黑', importance: 0.9 });
 *
 * 用法（CLI，调试用）：
 *   node memory-writer.mjs --section 长期 --content "我怕黑" --importance 0.9
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanMemContent } from './memory-parser.mjs';
import { fileURLToPath } from 'node:url';

const SECTION_ALIASES = {
  中期: 'mid',
  mid: 'mid',
  短期: 'mid',
  长期: 'long',
  long: 'long',
  这些人: 'relations',
  关系: 'relations',
  好感度: 'relations',
  好感: 'relations',
  relations: 'relations',
};

const HEADINGS = {
  mid: '## 中期（近 72 小时，由脚本每天自动整理，不要手改）',
  long: '## 长期（核心记忆，只在主人明确说"记住"或涉及身份、称呼、约定、禁区时才追加一行）',
  relations: '## 这些人（心里的感觉，只有自己知道，-100 到 +100）',
};

const 归一 = (s) =>
  String(s ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）()【】\[\]…—\-·]/g, '')
    .toLowerCase();

const 时间戳 = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export class MemoryWriter {
  /**
   * @param {object} opts
   * @param {string} opts.memoryDir memory/ 目录
   * @param {number} [opts.maxMid] 中期最多保留条数
   * @param {number} [opts.backupKeep] 备份保留份数
   * @param {(msg: string, data?: object) => void} [opts.log]
   */
  constructor({ memoryDir, maxMid = 40, backupKeep = 10, log } = {}) {
    if (!memoryDir) throw new Error('memoryDir is required');
    this.dir = memoryDir;
    this.file = join(memoryDir, 'MEMORY.md');
    this.pending = join(memoryDir, 'pending.jsonl');
    this.maxMid = maxMid;
    this.backupKeep = backupKeep;
    this.log = log ?? (() => {});
  }

  read() {
    if (!existsSync(this.file)) return '# 机器人记忆\n';
    return readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
  }

  /** 把文档拆成 preamble + 三个段（缺失的段给空数组），保留未知段原样。 */
  parse(md) {
    const lines = md.split('\n');
    const out = { preamble: [], mid: [], long: [], relations: [], others: [] };
    let cur = 'preamble';
    for (const line of lines) {
      const m = line.match(/^##\s+(.+)$/);
      if (m) {
        const head = m[1];
        if (/中期|近\s*72/.test(head)) cur = 'mid';
        else if (/长期/.test(head)) cur = 'long';
        else if (/这些人|好感|关系/.test(head)) cur = 'relations';
        else cur = 'others';
        out[cur].push(line);
        continue;
      }
      out[cur].push(line);
    }
    return out;
  }

  /** 段内条目（只认 "- " 开头的行）。 */
  items(sectionLines) {
    return sectionLines
      .filter((l) => /^\s*-\s+/.test(l))
      .map((l) => l.replace(/^\s*-\s+/, '').trimEnd());
  }

  backup() {
    if (!existsSync(this.file)) return null;
    const name = `MEMORY.md.bak_${时间戳()}`;
    const dest = join(this.dir, name);
    copyFileSync(this.file, dest);
    const baks = readdirSync(this.dir)
      .filter((n) => n.startsWith('MEMORY.md.bak_'))
      .sort();
    for (const old of baks.slice(0, Math.max(0, baks.length - this.backupKeep))) {
      try {
        unlinkSync(join(this.dir, old));
      } catch {
        /* 清旧备份失败不影响写入 */
      }
    }
    return dest;
  }

  /** 关系条目按 QQ 号识别，重复则覆盖。 */
  static relationKey(item) {
    const m = item.match(/^(?:-\s*)?(\d{5,})\b/);
    return m ? m[1] : null;
  }

  /**
   * 写一条结构化记忆。
   * @param {object} entry
   * @param {'中期'|'长期'|'这些人'} entry.section
   * @param {string} [entry.type] fact / event / relation
   * @param {string} entry.content 条目正文（关系条目写成 "QQ号 昵称：分数 — 备注"）
   * @param {number} [entry.importance] 0~1，中期裁剪用
   * @param {string} [entry.ts] ISO 时间
   * @returns {{ok: boolean, reason?: string, backup?: string}}
   */
  write(entry = {}) {
    const key = SECTION_ALIASES[String(entry.section ?? '').trim()];
    const content = cleanMemContent(entry.content);
    if (!key) return { ok: false, reason: `未知 section: ${entry.section}` };
    if (!content) return { ok: false, reason: 'content 为空' };

    const md = this.read();
    const doc = this.parse(md);
    const list = this.items(doc[key]);

    const dup =
      key === 'relations'
        ? (() => {
            const k = MemoryWriter.relationKey(content);
            return k ? list.some((x) => MemoryWriter.relationKey(x) === k) : false;
          })()
        : list.some((x) => 归一(x) === 归一(content));

    if (dup) {
      // 好感度：同一个人的分数/备注变了要更新，不是简单跳过
      if (key === 'relations') {
        const k = MemoryWriter.relationKey(content);
        const idx = list.findIndex((x) => MemoryWriter.relationKey(x) === k);
        if (idx >= 0 && list[idx] !== content) {
          list[idx] = content;
          return this.commit(doc, key, list, entry);
        }
        return { ok: false, reason: 'duplicate' };
      }
      return { ok: false, reason: 'duplicate' };
    }

    list.push(content);
    return this.commit(doc, key, list, entry);
  }

  commit(doc, key, list, entry) {
    let items = list;
    if (key === 'mid' && items.length > this.maxMid) items = items.slice(items.length - this.maxMid);
    // 段内非条目文字（比如 compress_memory 生成的中期摘要）必须原样保留，
    // 否则一合并 pending 就把摘要冲掉了。
    const 摘要行 = doc[key].filter((l) => !/^##\s/.test(l) && !/^\s*-\s+/.test(l) && l.trim());
    const sectionLines = [HEADINGS[key], '', ...摘要行, ...(摘要行.length ? [''] : []), ...items.map((x) => `- ${x}`), ''];
    doc[key] = sectionLines;

    const parts = [...doc.preamble];
    for (const k of ['mid', 'long', 'relations']) parts.push(...doc[k]);
    parts.push(...doc.others);
    const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

    const backup = this.backup();
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, this.file);

    try {
      appendFileSync(
        this.pending,
        `${JSON.stringify({ ...entry, section: entry.section, at: entry.ts ?? new Date().toISOString() })}\n`,
        'utf8',
      );
    } catch (e) {
      this.log(`pending 写入失败：${e?.message ?? e}`);
    }
    this.log(`写入 ${key}：${String(entry.content).slice(0, 30)}`);
    return { ok: true, backup };
  }
}

// CLI

const 直接运行 = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (直接运行) {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = get('dir') ?? process.env.MEMORY_DIR ?? './data/memory';
  const w = new MemoryWriter({ memoryDir: dir, log: console.log });
  console.log(w.write({ section: get('section') ?? '长期', content: get('content'), importance: Number(get('importance') ?? 0.5) }));
}
