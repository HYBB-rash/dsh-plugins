const REPO = '/home/herman/openclaw-upstream';
const STATE_FILE = REPO + '/.last-brief-sha';
const run = async (cmd) => {
  const res = await tools.call('exec', { command: cmd });
  return String(res?.result?.details?.aggregated ?? res?.result?.details?.stdout ?? res?.result?.details ?? '').trim();
};
const head = await run(`cd ${REPO} && git pull --ff-only -q && git rev-parse HEAD`);
if (!head) return json({ fire: false });
const prev = await run(`cat ${STATE_FILE} 2>/dev/null || true`);
if (!prev) return json({ fire: false });
if (head === prev) return json({ fire: false });
const count = (await run(`cd ${REPO} && git rev-list --count ${prev}..${head}`)) || '?';
return json({ fire: true, message: `OpenClaw 上游代码库有新提交:${count} 个(${prev.slice(0, 7)}..${head.slice(0, 7)})。请生成功能更新+bug修复总结简报(见任务说明)` });
