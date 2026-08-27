// OpenClaw 上游代码库每日更新检测(cron trigger 脚本,JS 沙箱)
// 每天 08:30 评估:git pull 保持镜像最新;有新提交则 fire:true,唤醒 agentTurn 生成 AI 总结简报
// 基线:~/.last-brief-sha 文件(agent 成功生成简报后更新;payload 失败则文件不变,下次自愈重试)
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
return json({
  fire: true,
  message: `OpenClaw 上游代码库有新提交:${count} 个(${prev.slice(0, 7)}..${head.slice(0, 7)})。请生成功能更新+bug修复总结简报(见任务说明)`,
});
