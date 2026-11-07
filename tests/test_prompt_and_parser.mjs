import { DynamicBudget, estimateTokens } from '../lib/budget.js';
import { parseMem, cleanMemContent } from '../lib/memory-parser.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
};

console.log('budget: 优先级裁剪');
{
  const b = new DynamicBudget({ maxTokens: 8 });
  b.add('mood', '情绪：平静', { priority: 10 });
  b.add('topic', '在聊考试和作业', { priority: 90 });
  const out = b.render();
  ok('高优先级保留', out.includes('考试'));
  ok('低优先级被丢', !out.includes('情绪'));
  ok('丢弃有记录', b.stats().dropped.length === 1);
}
{
  const b = new DynamicBudget({ maxTokens: 60 });
  b.add('a', '一二三四五', { priority: 50 });
  const t1 = b.render();
  b.add('a', '一二三四五', { priority: 50 });
  ok('同输入同输出', t1 === b.render());
}

console.log('parser: 解析与剥离');
{
  const r = parseMem('回答正文\n\n<mem section="长期" importance="0.9">用户A喜欢喝奶茶</mem>');
  ok('正文剥离', r.body === '回答正文', JSON.stringify(r.body));
  ok('条目解析', r.entries[0]?.section === '长期' && r.entries[0]?.importance === 0.9);
}
{
  const r = parseMem('x\n\n<mem section="非法">丢弃我</mem>');
  ok('非法 section 丢弃', r.entries.length === 0 && r.failed.length === 1);
  ok('标记不漏给用户', !r.body.includes('<mem'));
}
ok('粘连的「我」被清洗', cleanMemContent('我userA：群友') === 'userA：群友');
ok('正常句子不误伤', cleanMemContent('我今天很开心：因为升级了') === '我今天很开心：因为升级了');

console.log('token 估算');
ok('中文按字计', estimateTokens('你好世界') === 4);
ok('空串为 0', estimateTokens('') === 0);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
