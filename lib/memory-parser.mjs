/**
 * memory-parser：从模型回复里剥出 <mem> 标记（T2 抽取通道）
 *
 * 约定：
 *   <mem section="长期" type="事实" importance="0.7">内容</mem>
 *   - 多条可跨行；正文与标记之间空一行
 *   - 解析失败不阻塞主流程，记 pending.failed.jsonl
 *   - 发给用户前必须剥干净，标记绝不能漏到用户侧
 */

export const SECTIONS = ['中期', '长期', '这些人'];
export const DEFAULT_SECTION = '中期';
export const DEFAULT_TYPE = '事实';
export const DEFAULT_IMPORTANCE = 0.5;

const MEM_RE = /<mem(?:\s+([^>]*?))?>([\s\S]*?)<\/mem>/g;
const STRAY_TAG = /<\/?mem\b[^>]*>/g;

/**
 * 清洗记忆条目正文（P1.4）：
 *   1. 合并连续空白、去首尾
 *   2. 去掉列表符号
 *   3. 去掉摘要生成时粘在开头的「我」——「我userA：群友…」→「userA：群友…」
 *      只对 ASCII 名字/数字生效，避免误伤「我今天很开心：…」这种正常句子
 *   4. 冒号前多余空格压掉
 */
export function cleanMemContent(raw) {
  let s = String(raw ?? '').replace(/[\t\u3000 ]+/g, ' ').trim();
  s = s.replace(/^[-*·]\s*/, '');
  s = s.replace(/^我(?=[A-Za-z0-9_.-]{1,24}[：:])/, '');
  s = s.replace(/^([^\s：:]{1,24})\s+[：:]/, '$1：');
  return s.trim();
}

/** 本地时区的 ISO 时间（+08:00），不用 UTC，方便人看。 */
export function formatTs(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(raw))) attrs[m[1].toLowerCase()] = m[2].trim();
  return attrs;
}

/**
 * @param {string} text 模型输出
 * @param {{ts?: string, source?: string}} [meta]
 * @returns {{body: string, entries: Array, failed: Array}}
 */
export function parseMem(text, meta = {}) {
  const src = String(text ?? '');
  const ts = meta.ts ?? formatTs();
  const source = meta.source ?? '';
  const entries = [];
  const failed = [];
  const body = src.replace(MEM_RE, (_all, rawAttrs, rawContent) => {
    const attrs = parseAttrs(rawAttrs ?? '');
    const section = (attrs.section ?? DEFAULT_SECTION).trim() || DEFAULT_SECTION;
    const content = cleanMemContent(rawContent);
    if (!SECTIONS.includes(section)) {
      failed.push({ reason: `invalid-section:${section}`, raw: _all.slice(0, 200), ts, source });
      return '';
    }
    if (!content) {
      failed.push({ reason: 'empty-content', raw: _all.slice(0, 200), ts, source });
      return '';
    }
    let importance = DEFAULT_IMPORTANCE;
    if (attrs.importance !== undefined) {
      const n = Number(attrs.importance);
      if (!Number.isFinite(n)) {
        failed.push({ reason: `invalid-importance:${attrs.importance}`, raw: _all.slice(0, 200), ts, source });
        return '';
      }
      importance = Math.min(1, Math.max(0, n));
    }
    entries.push({
      section,
      type: (attrs.type ?? DEFAULT_TYPE).trim() || DEFAULT_TYPE,
      importance,
      content,
      ts,
      source,
    });
    return '';
  });

  // 没闭合 / 属性写坏的残片：宁可丢，也不能漏给用户
  let clean = body;
  if (/<mem\b/.test(clean)) {
    const leftovers = clean.match(/<mem\b[^>]*>/g) ?? [];
    for (const raw of leftovers) failed.push({ reason: 'unclosed-or-broken', raw: raw.slice(0, 200), ts, source });
    clean = clean.replace(STRAY_TAG, '');
  }

  clean = clean
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { body: clean, entries, failed };
}
