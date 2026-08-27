// X 洞察总结随机间隔触发器:30~90 分钟随机(30基准+随机数)
const MIN = 30 * 60 * 1000;
const MAX = 90 * 60 * 1000;
const now = Date.now();
let interval = trigger.state?.intervalMs;
if (!interval) interval = MIN + Math.random() * (MAX - MIN);
const last = trigger.state?.lastFireMs || 0;
if (last === 0 || now - last >= interval) {
  return json({ fire: true, message: `距上次 X 洞察总结 ${last === 0 ? '首次' : Math.round((now - last) / 60000) + ' 分钟'},随机间隔已到,执行收集+总结`, state: { lastFireMs: now, intervalMs: null } });
}
return json({ fire: false, state: { lastFireMs: last, intervalMs: interval } });
