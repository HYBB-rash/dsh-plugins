// 信息流监控:跑脚本拿新增 JSON,有新增才 fire
const res = await tools.call('exec', { command: 'cd /home/herman/.openclaw/workspace && python3 scripts/info_monitor.py --json > data/info_feed_latest.json 2>/dev/null; cat data/info_feed_latest.json' });
const out = String(res?.result?.details?.aggregated ?? res?.result?.details?.stdout ?? '').trim();
let data = null;
try { data = JSON.parse(out); } catch (e) {}
if (!data) return json({ fire: false });
const items = data.items || [];
if (items.length === 0) {
  if (data.reddit_blocked) return json({ fire: true, message: '信息流:Reddit 被限流(429),其余源无新增——需要用户手动解开' });
  return json({ fire: false });
}
return json({ fire: true, message: `信息流有 ${items.length} 条新增,请翻译标题并投递(数据在 info_feed_latest.json)` });
