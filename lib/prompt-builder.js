/**
 * T2 三段式 PromptBuilder
 *
 * 现实约束：dsh 的 system prompt 由 dsh-system-prompt 生成，插件改不了；
 * 插件只能通过 sessionController.prompt 往会话里追加 user 消息。所以三段式
 * 在这套栈里落成：
 *
 *   ① 静态段：会话首条 user 消息（人设 + 记忆快照 + 群名单）——每个会话只发一次，
 *      之后永不重写，字节级固定，成为前缀的一部分被永久缓存。
 *   ② 历史段：之后所有消息只追加（append-only），内容不再改写。
 *   ③ 动态块：仅本轮消息尾部的一小块（≤5%），经 DynamicBudget 裁剪。
 *
 * 这样每轮新增的不可缓存 token 从 ~1100 降到 ~200，命中率才能上 95%。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { DynamicBudget, estimateTokens } from './budget.js';

const SHA = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

const MEM_MARKER_INSTRUCTION = [
  '## 记忆标记（只给系统看）',
  '回复正文结束后，如果本轮产生了值得长期记住的信息（人物事实、偏好、关系变化、重要事件），',
  '在正文后空一行，用 <mem section="长期" type="事实" importance="0.7">内容</mem> 输出，可多条。',
  'section 只能取 中期 / 长期 / 这些人；importance 取 0~1，按重要程度给：随口一句 0.3，记住的事实 0.7，身份/约定/禁区 0.9。',
  '例：<mem section="中期" type="事件" importance="0.3">今天聊到了考试</mem>',
  '例：<mem section="长期" type="事实" importance="0.9">用户A 的昵称是小A</mem>',
  '闲聊、寒暄、没有信息量的轮次不要输出标记。标记不会发给对方，别在正文里提它。',
].join('\n');

/** 把 MEMORY.md 切成 中期 / 长期 / 好感度 三段（按二级标题）。 */
export function splitMemory(md) {
  const out = { mid: '', long: '', relations: '' };
  const parts = String(md).split(/^## /m);
  for (const p of parts.slice(1)) {
    const [head, ...rest] = p.split('\n');
    const body = rest.join('\n').trim();
    if (/中期|近\s*72/.test(head)) out.mid = body;
    else if (/长期/.test(head)) out.long = body;
    else if (/这些人|好感|关系/.test(head)) out.relations = body;
  }
  return out;
}

/** 好感度只保留前 N 名，静态快照用；完整表留给 T3 的 DB。 */
function topRelations(text, n = 12) {
  const lines = text.split('\n').filter((l) => /^\s*-\s*\d+/.test(l));
  return lines
    .map((l) => {
      const m = l.match(/(-?\d+)\s*$/);
      return { line: l, score: m ? Number(m[1]) : 0 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.line)
    .join('\n');
}

export class PromptBuilder {
  /**
   * @param {object} opts
   * @param {string} opts.cwd 工作区（memory/ 所在目录）
   * @param {string} opts.persona 人设
   * @param {number} [opts.dynamicRatio] 动态块占 prompt 比例，默认 0.05
   * @param {number} [opts.maxDynamicTokens] 动态块硬上限：稳态 prompt ~8000 × 5% ≈ 400，
   *   实际硬顶取 120（情绪 30 + 作息 20 + 话题 50 + 余量 20），5% 只作天花板
   * @param {(msg: string, data?: object) => void} [opts.log]
   */
  constructor({ cwd, persona, memMarkers = true, dynamicRatio = 0.05, maxDynamicTokens = 120, log } = {}) {
    this.cwd = cwd;
    this.persona = String(persona ?? '').trim();
    this.memMarkers = memMarkers !== false;
    this.dynamicRatio = dynamicRatio;
    this.maxDynamicTokens = maxDynamicTokens;
    this.log = log ?? (() => {});
    this.budget = new DynamicBudget({
      maxTokens: maxDynamicTokens,
      onDrop: (info) => this.log('动态块裁剪', info),
    });
    this._static = null; // {text, hash, at}
    this._history = []; // hash 链，用于断言只追加
  }

  /** 读 MEMORY.md；缺失则空。 */
  readMemory() {
    const file = join(this.cwd, 'memory', 'MEMORY.md');
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  }

  /**
   * 当天流水：优先 memory/<今天>.md，没有就退到最近一篇。
   * 只取末尾 diaryChars 字（流水按时间追加，最新在末尾）。
   * @returns {{name: string, text: string}}
   */
  readDiary(diaryChars = 650) {
    const dir = join(this.cwd, 'memory');
    const today = new Date().toLocaleDateString('sv-SE');
    const names = existsSync(dir)
      ? readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort()
      : [];
    const name = names.includes(`${today}.md`) ? `${today}.md` : names[names.length - 1];
    if (!name) return { name: '', text: '' };
    try {
      const raw = readFileSync(join(dir, name), 'utf8').replace(/^\uFEFF/, '');
      const limit = Math.max(0, Number(diaryChars ?? 650));
      if (limit === 0) return { name: '', text: '' };
      const lines = raw.split('\n').filter((l) => l.trim());
      const picked = [];
      let used = 0;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const add = lines[i].length + 1;
        if (used + add > limit) break;
        picked.unshift(lines[i]);
        used += add;
      }
      // 截断时补省略号，避免看起来像完整开头
      const text = picked.length < lines.length ? `…\n${picked.join('\n')}` : picked.join('\n');
      return { name, text };
    } catch {
      return { name: '', text: '' };
    }
  }

  /**
   * 静态段：人设 + 记忆快照 + 当天流水（切会话时补上，避免白天失忆）。
   * 一天内字节级不变（只在会话冷启动或显式 refresh 时重算）。
   * @param {{groupWhitelist?: string[], diaryChars?: number}} [extra]
   */
  staticSection({ groupWhitelist = [], diaryChars = 650 } = {}) {
    const md = this.readMemory();
    const { mid, long, relations } = splitMemory(md);
    const diary = this.readDiary(diaryChars);
    const blocks = [];
    if (this.persona) blocks.push(this.persona);
    if (this.memMarkers) blocks.push(MEM_MARKER_INSTRUCTION);
    if (mid) blocks.push(`## 最近发生的事\n${mid}`);
    if (long) blocks.push(`## 我确定记得的\n${long}`);
    if (relations) blocks.push(`## 这些人（心里的感觉）\n${topRelations(relations)}`);
    const memoryText = blocks.join('\n\n').trim();
    if (diary.text) blocks.push(`## 今天早些时候\n${diary.text}`);
    const text = blocks.join('\n\n').trim();
    this._static = {
      text,
      hash: SHA(text),
      memoryHash: SHA(memoryText),
      diaryHash: SHA(diary.text),
      diary: diary.name,
      at: Date.now(),
    };
    return this._static;
  }

  /** 会话首条消息：静态段 + 固定说明。只在会话冷启动时投一次。 */
  bootstrapMessage({ groupWhitelist = [], diaryChars = 650 } = {}) {
    const st = this._static ?? this.staticSection({ groupWhitelist, diaryChars });
    const head = '（下面这些是你一直知道的事，之后不再重复。这些就是你记得的全部。）';
    return `${head}\n\n${st.text}`;
  }

  /**
   * 记忆变了：只追加一条更新，绝不改写历史。返回 null 表示记忆段没变。
   * 只比对 MEMORY.md 三段（不含当天流水），流水白天增长不应触发更新。
   */
  memoryUpdateMessage() {
    const md = this.readMemory();
    const { mid, long, relations } = splitMemory(md);
    const text = [mid && `## 最近发生的事\n${mid}`, long && `## 我确定记得的\n${long}`, relations && `## 这些人\n${topRelations(relations)}`]
      .filter(Boolean)
      .join('\n\n');
    const hash = SHA(text);
    if (hash === this._static?.memoryHash) return null;
    if (this._static) this._static.memoryHash = hash;
    return `（记忆更新，以这条为准）\n\n${text}`;
  }

  /**
   * 每轮消息：只放本轮新信息 + 动态块。
   * @param {object} p
   * @param {string} p.header 例如「【来信】…」这一行，含发送者与原文
   * @param {string} [p.groupContext] 群聊最近若干条（已格式化）
   * @param {Array<{source:string,text:string,priority?:number}>} [p.dynamic] 动态块条目
   * @param {number} [p.promptTokens] 预估当前 prompt 总 token，用于算 5% 预算
   */
  turnMessage({ header, groupContext = '', dynamic = [], promptTokens = 0 }) {
    if (promptTokens > 0) {
      this.budget.maxTokens = Math.min(
        this.maxDynamicTokens,
        Math.max(20, Math.floor(promptTokens * this.dynamicRatio)),
      );
    }
    this.budget.clear();
    for (const d of dynamic) this.budget.add(d.source, d.text, { priority: d.priority ?? 50 });
    const dyn = this.budget.render();
    const parts = [header.trim()];
    if (groupContext.trim()) parts.push(groupContext.trim());
    if (dyn) parts.push(dyn);
    return parts.join('\n\n');
  }

  /**
   * 历史只追加自检：相同 index 的内容 hash 必须不变。
   * 返回 false 表示有人改写了历史（缓存必炸），调用方应告警。
   */
  checkAppendOnly(messages) {
    const hashes = messages.map((m) => SHA(typeof m === 'string' ? m : JSON.stringify(m)));
    let ok = true;
    const min = Math.min(hashes.length, this._history.length);
    for (let i = 0; i < min; i += 1) {
      if (hashes[i] !== this._history[i]) {
        ok = false;
        this.log(`历史被改写：第 ${i} 条 hash 变了`);
        break;
      }
    }
    this._history = hashes;
    return ok;
  }

  stats() {
    return {
      staticHash: this._static?.hash ?? null,
      staticTokens: estimateTokens(this._static?.text ?? ''),
      staticChars: (this._static?.text ?? '').length,
      dynamic: this.budget.stats(),
    };
  }
}
