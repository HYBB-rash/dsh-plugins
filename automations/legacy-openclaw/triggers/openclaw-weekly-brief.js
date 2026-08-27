const REPO = '/home/herman/openclaw-upstream';
const run = async (cmd) => {
  const res = await tools.call('exec', { command: cmd });
  return String(res?.result?.details?.aggregated ?? res?.result?.details?.stdout ?? res?.result?.details ?? '').trim();
};
await run(`cd ${REPO} && git pull --ff-only -q`);
const count = (await run(`cd ${REPO} && git log --oneline --no-merges --since='7 days ago' | wc -l`)) || '0';
if (!count || count === '0') return json({ fire: false });
return json({ fire: true, message: `本周(近7天)OpenClaw 上游有 ${count} 个提交。请生成周报(见任务说明)` });
