const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  jobId: "403b4423-b702-4faf-9687-1dd862bb3816",
  packagePath: "/home/herman/.openclaw/workspace/data/x_insight_package.json",
  shownPath: "/home/herman/.openclaw/workspace/data/x_shown.json",
  scriptPath: "/home/herman/.openclaw/workspace/scripts/x_insight_pipeline.py",
};

function resolveConfig(pluginConfig) {
  return { ...DEFAULTS, ...(pluginConfig || {}) };
}

function receiptStatus(event) {
  return event.deliveryStatus === "delivered" || event.delivered === true
    ? "delivered"
    : "not-delivered";
}

module.exports = {
  id: "x-delivery-receipt",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    api.on("cron_changed", async (event) => {
      if (event.action !== "finished" || event.jobId !== config.jobId) {
        return;
      }
      const status = receiptStatus(event);
      const args = [
        config.scriptPath,
        "confirm-prepared",
        "--package", config.packagePath,
        "--shown", config.shownPath,
        "--cron-job-id", config.jobId,
        "--status", status,
      ];
      try {
        const { stdout } = await execFileAsync("/usr/bin/python3", args, {
          timeout: 15000,
          maxBuffer: 64 * 1024,
        });
        api.logger?.info?.(`x delivery receipt ${status}: ${String(stdout).trim()}`);
      } catch (error) {
        api.logger?.error?.(`x delivery receipt reconciliation failed: ${String(error)}`);
      }
    });
  },
};

module.exports.resolveConfig = resolveConfig;
module.exports.receiptStatus = receiptStatus;
