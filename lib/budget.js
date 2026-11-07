/**
 * T0 动态块预算管理器（纯函数 + 单类，无依赖）
 *
 * 约束：prompt 里所有"每轮可能变化"的内容必须经这里登记，按优先级渲染，
 * 总预算 ≤ prompt 的 5%。超预算时按优先级从低到高丢弃，并留痕。
 *
 * 用法：
 *   const b = new DynamicBudget({ maxTokens: 40 });
 *   b.add('mood', '有点犯困', { priority: 30 });
 *   b.add('topic', '在聊作业', { priority: 50 });
 *   b.render();       // '在聊作业'（mood 被预算挤掉并记录）
 */

/** 粗估 token：CJK 按 1 字 1 token，其余按 4 字符 1 token。偏差 ±10%，够用。 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

export class DynamicBudget {
  /**
   * @param {object} opts
   * @param {number} opts.maxTokens 硬上限（动态块总 token）
   * @param {(text: string) => number} [opts.estimator]
   * @param {(info: object) => void} [opts.onDrop] 丢弃回调（埋点用）
   */
  constructor({ maxTokens = 60, estimator = estimateTokens, onDrop } = {}) {
    this.maxTokens = maxTokens;
    this.estimator = estimator;
    this.onDrop = onDrop;
    /** @type {Map<string, {source:string, text:string, priority:number, cost:number, seq:number}>} */
    this.slots = new Map();
    this.seq = 0;
    this.lastDropped = [];
  }

  /** 按 prompt 总量自动定预算（5% 默认），用于初始化。 */
  static fromPromptTokens(promptTokens, ratio = 0.05, opts = {}) {
    return new DynamicBudget({ maxTokens: Math.max(20, Math.floor(promptTokens * ratio)), ...opts });
  }

  /**
   * 登记一块动态内容。同 source 覆盖（保留最新），保证不重复占预算。
   * @param {string} source 唯一来源名，如 mood / topic / sleep
   * @param {string} text 渲染文本，空串视为删除
   * @param {{priority?: number, hard?: boolean}} [opts] priority 越大越先保留；hard=true 永不丢弃（慎用）
   */
  add(source, text, { priority = 50, hard = false } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) {
      this.slots.delete(source);
      return this;
    }
    this.slots.set(source, {
      source,
      text: clean,
      priority,
      hard,
      cost: this.estimator(clean),
      seq: (this.seq += 1),
    });
    return this;
  }

  remove(source) {
    this.slots.delete(source);
    return this;
  }

  clear() {
    this.slots.clear();
    return this;
  }

  /** 当前登记项（未裁剪）。 */
  entries() {
    return [...this.slots.values()];
  }

  /**
   * 按优先级渲染，超出预算的丢弃。
   * 排序：priority 降序，同优先级按登记顺序（seq 升序），保证同输入同输出。
   */
  render({ separator = '\n' } = {}) {
    const ordered = this.entries().sort(
      (a, b) => (b.hard ? 1 : 0) - (a.hard ? 1 : 0) || b.priority - a.priority || a.seq - b.seq,
    );
    const kept = [];
    const dropped = [];
    let used = 0;
    for (const item of ordered) {
      const addCost = item.cost + (kept.length > 0 ? this.estimator(separator) : 0);
      if (!item.hard && used + addCost > this.maxTokens) {
        dropped.push({ ...item, reason: 'over-budget' });
        continue;
      }
      kept.push(item);
      used += addCost;
    }
    this.lastDropped = dropped;
    if (dropped.length > 0 && typeof this.onDrop === 'function') {
      this.onDrop({ dropped: dropped.map(({ source, cost, priority }) => ({ source, cost, priority })), used, max: this.maxTokens });
    }
    // 稳定输出顺序：按登记顺序，避免优先级抖动导致字节变化
    return kept.sort((a, b) => a.seq - b.seq).map((x) => x.text).join(separator);
  }

  stats() {
    const total = this.entries().reduce((n, x) => n + x.cost, 0);
    return {
      maxTextTokens: this.maxTokens,
      registered: this.slots.size,
      registeredTokens: total,
      dropped: this.lastDropped.map((x) => ({ source: x.source, cost: x.cost })),
    };
  }
}
