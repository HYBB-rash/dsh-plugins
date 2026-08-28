#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bzp_ble_monitor.py — 包租婆 BLE 电表低成本监控 (每 5 分钟 cron 运行)
========================================================================

目标
----
基于 bzp_ble_read_until_success.py (无限重试实时读表器) 构建低成本监控:

  * 正常状态 (最近有效实时读数 > 10 度): 每个自然小时至多汇报一次
    实时电表数字 (总度数/剩余电量/开关状态)。
  * 剩余电量 <= 10 度: 每 5 分钟输出明确充电提醒 (基于最近一次有效实时读数)。
  * 小时汇报读取失败: 保留该小时待汇报 (pending), 后续成功时补报。
  * 读数 > 10 度且非小时汇报时 stdout 为空 → no-agent cron 静默。
运行方式 (由 cron 每 5 分钟调用; 本脚本不做任何对外发送):
    python3 bzp_ble_monitor.py [--state-file ...] [--reader-script ...]

设计约束 (对应任务验收标准)
----------------------------
1. flock 串行化: 每次运行先对 --lock-file 加 flock (有界等待), 失败则静默
   退出, 避免并发占用 hci0 蓝牙适配器。
2. 有界实时读取: 每次运行至多调用一次读表器, 且同时受墙钟预算
   (--read-budget, 超时 killpg) 与读表器 --max-rounds 双重限制; 结果写入
   每次运行唯一的临时结果文件, 绝不复用旧结果; 只接受 source=="ble_live"
   的读数, 绝不把旧云端快照冒充实时值。
3. 小时汇报去重: state.last_report_hour 记录已汇报自然小时; 失败小时写入
   pending_hours, 成功时以"补报"消息一次性补报并清零。
4. 低电量提醒: 最近有效读数 <= --low-power-threshold (默认 10) 时, 距上次
   提醒 >= --reminder-interval (默认 300s) 即输出充电提醒; 低电量模式下每
   --refresh-interval (默认 1800s) 才做一次刷新读取 (低成本)。
5. stdout 契约: 仅在需要汇报/提醒时输出消息, 其余运行 stdout 为空。
6. 状态文件原子写入 (tmp + fsync + os.replace), 所有时间戳 Asia/Shanghai。
7. 认证文件: 本脚本**从不打开/读取** auth 文件, 只把 --auth-file 路径透传
   给读表器子进程; 日志/消息绝不包含认证内容。

退出码: 恒为 0 (cron 依赖 stdout 判定是否投递); 参数错误由 argparse 以 2 退出。
"""
from __future__ import annotations

import argparse
import copy
import fcntl
import json
import logging
import math
import os
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from automation_paths import state_file

try:
    from zoneinfo import ZoneInfo
    _TZ = ZoneInfo("Asia/Shanghai")
except Exception:  # 无 tzdata 时回退固定 +08:00
    _TZ = timezone(timedelta(hours=8))

TZ_NAME = "Asia/Shanghai"
STATE_VERSION = 1
HOUR_KEY_FMT = "%Y-%m-%dT%H"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# 时间/时区 (验收 6)
# ---------------------------------------------------------------------------
def now_dt():
    return datetime.now(_TZ)


def parse_dt(s: str) -> datetime:
    s = s.strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M",
                "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            dt = datetime.strptime(s, fmt)
            break
        except ValueError:
            continue
    else:
        raise ValueError("无法解析时间: %s" % s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_TZ)
    return dt.astimezone(_TZ)


def _offset_str(dt: datetime) -> str:
    off = dt.utcoffset() or timedelta(0)
    total = int(off.total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    return "%s%02d:%02d" % (sign, total // 3600, (total % 3600) // 60)


def fmt_ts(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + _offset_str(dt)


def hour_key(dt: datetime) -> str:
    return dt.strftime(HOUR_KEY_FMT)


def fmt_num(value) -> str:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return str(value)
    if f == int(f) and abs(f) < 1e15:
        return str(int(f))
    return ("%.2f" % f).rstrip("0").rstrip(".")


# ---------------------------------------------------------------------------
# 状态文件
# ---------------------------------------------------------------------------
def new_state() -> dict:
    return {
        "version": STATE_VERSION,
        "tz": TZ_NAME,
        "updated_at": None,
        "updated_epoch": None,
        "last_success": None,
        "last_success_hour": None,
        "last_report_hour": None,
        "pending_hours": [],
        "last_reminder_at": None,
        "last_reminder_epoch": None,
        "last_read_attempt": None,
    }


def load_state(path: str) -> dict:
    if not path or not os.path.exists(path):
        return new_state()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or data.get("version") != STATE_VERSION:
            return new_state()
        pending = data.get("pending_hours") or []
        data["pending_hours"] = [h for h in pending if isinstance(h, str)]
        return data
    except (OSError, ValueError):
        return new_state()


def save_state(path: str, state: dict):
    """原子写入: tmp + fsync + os.replace。"""
    d = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    tmp = "%s.tmp.%d.%s" % (path, os.getpid(), uuid.uuid4().hex[:8])
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    os.chmod(path, 0o600)
    directory_fd = os.open(d, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


# ---------------------------------------------------------------------------
# 读数有效性: 只认 ble_live 实时值 (验收 2, 拒绝云端快照)
# ---------------------------------------------------------------------------
def validate_reading(reading: dict) -> bool:
    try:
        total = float(reading["total"])
        surplus = float(reading["surplus"])
        sw = reading.get("switchState", reading.get("switch_state"))
        if isinstance(sw, bool):
            sw = 1 if sw else 0
        sw = int(sw)
    except (TypeError, ValueError, KeyError, AttributeError):
        return False
    if sw not in (0, 1):
        return False
    if not (math.isfinite(total) and math.isfinite(surplus)):
        return False
    if total < 0:
        return False
    if str(reading.get("source", "")).lower() != "ble_live":
        return False
    return True


def _parse_result_file(path) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            result = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(result, dict) or result.get("status") != "success":
        return None
    reading = {
        "total": result.get("total"),
        "surplus": result.get("surplus"),
        "switch_state": result.get("switchState", result.get("switch_state")),
        "source": result.get("source", ""),
        "read_at": result.get("read_at"),
    }
    if not validate_reading(reading):
        return None
    return reading


# ---------------------------------------------------------------------------
# 有界读取: 子进程调读表器, 墙钟预算 + max-rounds 双重有界 (验收 2)
# ---------------------------------------------------------------------------
def _fresh_result_path(state_dir: str) -> str:
    d = os.path.join(state_dir, "runs")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "result-%s.json" % uuid.uuid4().hex)


def run_bounded_read(opts, log_file: str):
    """执行至多一次有界读表; 返回 (ok, reading|None, reason)。

    reading 规范化: {total, surplus, switch_state, source, read_at}。
    本函数只把 --auth-file 路径传给子进程, 绝不打开认证文件。
    """
    result_file = _fresh_result_path(os.path.dirname(os.path.abspath(opts.state_file)))
    cmd = [
        sys.executable, opts.reader_script,
        "--sn", opts.sn,
        "--mac", opts.mac,
        "--result-file", result_file,
        "--log-dir", os.path.join(os.path.dirname(os.path.abspath(opts.state_file)), "logs"),
        "--auth-file", opts.auth_file,
        "--max-rounds", str(opts.max_rounds),
    ]
    if opts.skip_dep_check:
        cmd.append("--skip-dep-check")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, start_new_session=True)
    try:
        _out, _err = proc.communicate(timeout=opts.read_budget)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (OSError, ProcessLookupError):
            try:
                proc.kill()
            except OSError:
                pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        return False, None, "timeout"
    if proc.returncode != 0:
        return False, None, "exit=%s" % proc.returncode
    reading = _parse_result_file(result_file)
    if reading is None:
        return False, None, "no_valid_result"
    return True, reading, "ok"


# ---------------------------------------------------------------------------
# 决策逻辑 (纯函数, 可单测)
# ---------------------------------------------------------------------------
def plan_run(state: dict, now: datetime, opts) -> tuple:
    """本次运行是否需要做一次有界实时读取。返回 (need, reason)。"""
    hour = hour_key(now)
    last = state.get("last_success")
    if last is None:
        return True, "first_read"
    surplus = last.get("surplus")
    low_power = surplus is not None and surplus <= opts.low_power_threshold
    report_due = (state.get("last_report_hour") != hour) or bool(state.get("pending_hours"))
    if low_power:
        if (int(now.timestamp()) - int(last.get("epoch", 0))) >= opts.refresh_interval:
            return True, "low_power_refresh"
        return False, "low_power_reminder_only"
    if report_due:
        if state.get("last_success_hour") != hour:
            return True, "hourly_report_read"
        return False, "fresh_this_hour"
    return False, "silent"


def reminder_text(last: dict, opts) -> str:
    if getattr(opts, "meter_kind", "electric") == "water":
        return ("⚠️ 低水量提醒: 剩余水量 %s m³ (实时读数 %s), 请尽快充值!"
                % (fmt_num(last.get("surplus")), last.get("read_at") or last.get("at")))
    return ("⚠️ 充电提醒: 剩余电量 %s 度 (实时读数 %s), 请尽快充电!"
            % (fmt_num(last.get("surplus")), last.get("read_at") or last.get("at")))


def hourly_text(last: dict, opts) -> str:
    switch = "开" if last.get("switch_state") == 1 else "关"
    if getattr(opts, "meter_kind", "electric") == "water":
        return ("📊 水表实时读数: 总用量 %s, 剩余 %s m³, 开关 %s (读取于 %s)"
                % (fmt_num(last.get("total")), fmt_num(last.get("surplus")), switch,
                   last.get("read_at") or last.get("at")))
    return ("📊 电表实时读数: 总度数 %s, 剩余 %s 度, 开关 %s (读取于 %s)"
            % (fmt_num(last.get("total")), fmt_num(last.get("surplus")), switch,
               last.get("read_at") or last.get("at")))


def backfill_text(last: dict, pending_hours: list, opts) -> str:
    hours = "、".join("%s %s:00" % (h[:10], h[11:]) for h in pending_hours)
    if getattr(opts, "meter_kind", "electric") == "water":
        return ("📊 补报: 以下小时实时读数获取失败 (%s), 最新有效读数 "
                "total=%s, surplus=%s m³ (读取于 %s)"
                % (hours, fmt_num(last.get("total")), fmt_num(last.get("surplus")),
                   last.get("read_at") or last.get("at")))
    return ("📊 补报: 以下小时实时读数获取失败 (%s), 最新有效读数 "
            "total=%s, surplus=%s (读取于 %s)"
            % (hours, fmt_num(last.get("total")), fmt_num(last.get("surplus")),
               last.get("read_at") or last.get("at")))


def apply_outcome(state: dict, now: datetime, opts, read_ok: bool,
                  reading: dict | None, attempted: bool = True,
                  failure_reason: str = "read_failed") -> tuple:
    """把一次运行结果合并进状态并决定输出。返回 (new_state, messages)。"""
    state = copy.deepcopy(state)
    hour = hour_key(now)
    now_epoch = int(now.timestamp())

    # --- 更新读数/失败记录 ---
    last = state.get("last_success")
    surplus_before = last.get("surplus") if last else None
    low_power_before = (surplus_before is not None
                        and surplus_before <= opts.low_power_threshold)
    report_due = (state.get("last_report_hour") != hour) or bool(state.get("pending_hours"))

    attempt = {"at": fmt_ts(now), "ok": bool(read_ok)} if attempted else None
    if attempted and read_ok:
        state["last_success"] = {
            "at": fmt_ts(now),
            "epoch": now_epoch,
            "total": reading["total"],
            "surplus": reading["surplus"],
            "switch_state": reading["switch_state"],
            "source": "ble_live",
            "read_at": reading.get("read_at") or fmt_ts(now),
        }
        state["last_success_hour"] = hour
        attempt["reason"] = "ok"
    elif attempted:
        attempt["reason"] = failure_reason
        # 小时汇报失败: 保留该小时待汇报 (低电量模式以提醒为主, 不累计 pending;
        # 尚无任何成功读数时也无从补报, 不记 pending)
        if (report_due and not low_power_before
                and state.get("last_success") is not None):
            pending = list(state.get("pending_hours") or [])
            if hour not in pending:
                pending.append(hour)
            state["pending_hours"] = pending[-opts.max_pending_hours:]
    if attempt is not None:
        state["last_read_attempt"] = attempt

    # --- 输出决策 ---
    last = state.get("last_success")
    if last is None:
        state["updated_at"] = fmt_ts(now)
        state["updated_epoch"] = now_epoch
        return state, []  # 尚无任何有效实时读数, 静默

    surplus = last["surplus"]
    low_power = surplus <= opts.low_power_threshold
    pending = list(state.get("pending_hours") or [])
    report_due = (state.get("last_report_hour") != hour) or bool(pending)

    messages = []
    if low_power:
        # 每 --reminder-interval 秒提醒一次充电 (用最近一次有效实时读数)
        last_rem = state.get("last_reminder_epoch")
        if last_rem is None or (now_epoch - last_rem) >= opts.reminder_interval:
            messages.append(reminder_text(last, opts))
            state["last_reminder_at"] = fmt_ts(now)
            state["last_reminder_epoch"] = now_epoch
    else:
        if report_due:
            # 仅当本小时已有成功读数 (本次成功或 fresh_this_hour) 才汇报;
            # 本次读取失败且本小时无成功 → 静默, 该小时已在 pending 中待补报
            if state.get("last_success_hour") == hour:
                if pending:
                    messages.append(backfill_text(last, pending, opts))
                    state["pending_hours"] = []
                else:
                    messages.append(hourly_text(last, opts))
                state["last_report_hour"] = hour

    state["updated_at"] = fmt_ts(now)
    state["updated_epoch"] = now_epoch
    return state, messages


# ---------------------------------------------------------------------------
# flock 串行化 (验收 1)
# ---------------------------------------------------------------------------
class FlockLock:
    def __init__(self, path: str):
        self.path = path
        self._fd = None

    def acquire(self, timeout: float = 5.0) -> bool:
        d = os.path.dirname(os.path.abspath(self.path)) or "."
        os.makedirs(d, exist_ok=True)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        deadline = time.time() + max(0.0, timeout)
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._fd = fd
                return True
            except OSError:
                if time.time() >= deadline:
                    os.close(fd)
                    return False
                time.sleep(0.1)

    def release(self):
        if self._fd is not None:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(self._fd)
            self._fd = None


# ---------------------------------------------------------------------------
# 输出通道: Telegram 平文本
# ---------------------------------------------------------------------------
def render_messages(messages: list, opts):
    for msg in messages:
        print(msg)


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
class Opts:
    pass


def default_opts(**kw) -> Opts:
    o = Opts()
    o.state_file = state_file("bzp_ble_monitor_state.json")
    o.lock_file = None  # 解析时默认 state_file + ".lock"
    o.reader_script = os.path.join(SCRIPT_DIR, "bzp_ble_read_until_success.py")
    o.auth_file = "~/.local/share/bzp-ble/auth.json"
    o.sn = "YM00236K2A68"
    o.mac = "23:06:20:00:2A:68"
    o.read_budget = 75.0
    o.max_rounds = 2
    o.refresh_interval = 1800
    o.reminder_interval = 300
    o.low_power_threshold = 10
    o.meter_kind = "electric"
    o.lock_timeout = 5.0
    o.max_pending_hours = 12
    o.force_read = False
    o.fail_on_read_error = False
    o.log_file = os.path.join(os.path.dirname(o.state_file), "bzp_ble_monitor.log")
    o.skip_dep_check = False
    o.verbose = False
    o.now = None
    for k, v in kw.items():
        setattr(o, k, v)
    if o.lock_file is None:
        o.lock_file = o.state_file + ".lock"
    return o


def parse_args(argv=None) -> Opts:
    p = argparse.ArgumentParser(
        description="包租婆 BLE 电表低成本监控 (cron 每 5 分钟; stdout 即投递内容)")
    p.add_argument("--state-file",
                   default=state_file("bzp_ble_monitor_state.json"),
                   help="状态文件 (原子写入, Asia/Shanghai)")
    p.add_argument("--lock-file", default=None,
                   help="flock 锁文件 (默认 <state-file>.lock)")
    p.add_argument("--reader-script",
                   default=os.path.join(SCRIPT_DIR, "bzp_ble_read_until_success.py"),
                   help="实时读表器脚本路径")
    p.add_argument("--auth-file", default="~/.local/share/bzp-ble/auth.json",
                   help="读表器登录态路径 (仅透传, 本脚本不读取)")
    p.add_argument("--sn", default="YM00236K2A68")
    p.add_argument("--mac", default="23:06:20:00:2A:68")
    p.add_argument("--read-budget", type=float, default=75.0,
                   help="读表器墙钟预算(秒), 超时强杀 (有界读取)")
    p.add_argument("--max-rounds", type=int, default=2,
                   help="传给读表器的最大轮数 (有界读取)")
    p.add_argument("--refresh-interval", type=int, default=1800,
                   help="低电量模式下刷新读取间隔(秒)")
    p.add_argument("--reminder-interval", type=int, default=300,
                   help="充电提醒最小间隔(秒)")
    p.add_argument("--low-power-threshold", type=float, default=10,
                   help="剩余量 <= 该值 进入低量提醒模式 (电表: 度, 水表: m³)")
    p.add_argument("--meter-kind", choices=["electric", "water"], default="electric",
                   help="表计类型: electric(电表, 单位度/充电提醒) / water(水表, 单位m³/低水量提醒)")
    p.add_argument("--lock-timeout", type=float, default=5.0,
                   help="等待 flock 的秒数, 超时静默跳过")
    p.add_argument("--max-pending-hours", type=int, default=12,
                   help="pending 小时数上限")
    p.add_argument("--force-read", action="store_true",
                   help="忽略自然调度节流并执行一次实时读表")
    p.add_argument("--fail-on-read-error", action="store_true",
                   help="执行过实时读表且失败时以非零退出 (供刷新 worker 使用)")
    p.add_argument("--log-file", default=None, help="监控日志文件")
    p.add_argument("--skip-dep-check", action="store_true",
                   help="透传给读表器, 跳过依赖检查 (仅测试)")
    p.add_argument("--verbose", action="store_true")
    p.add_argument("--now", default=None,
                   help="覆盖当前时间 (ISO, 测试/演练用)")
    ns = p.parse_args(argv)
    o = default_opts()
    for k, v in vars(ns).items():
        setattr(o, k, v)
    if o.lock_file is None:
        o.lock_file = o.state_file + ".lock"
    if o.log_file is None:
        o.log_file = os.path.join(os.path.dirname(os.path.abspath(o.state_file)),
                                  "bzp_ble_monitor.log")
    return o


def make_log(log_file: str, verbose: bool = False) -> logging.Logger:
    lg = logging.getLogger("bzp_ble_monitor")
    lg.setLevel(logging.DEBUG if verbose else logging.INFO)
    lg.propagate = False
    if not lg.handlers:
        d = os.path.dirname(os.path.abspath(log_file)) or "."
        os.makedirs(d, exist_ok=True)
        fh = logging.FileHandler(log_file, encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        lg.addHandler(fh)
    return lg


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
def main(argv=None) -> int:
    opts = parse_args(argv)
    log = make_log(opts.log_file, opts.verbose)
    now = parse_dt(opts.now) if opts.now else now_dt()

    lock = FlockLock(opts.lock_file)
    if not lock.acquire(timeout=opts.lock_timeout):
        log.info("锁 %s 被占用, 跳过本次运行 (hci0 防并发)", opts.lock_file)
        return 0
    try:
        state = load_state(opts.state_file)
        read_needed, reason = (True, "forced_read") if opts.force_read else plan_run(state, now, opts)
        log.info("run hour=%s read_needed=%s reason=%s",
                 hour_key(now), read_needed, reason)
        read_ok, reading = False, None
        if read_needed:
            read_ok, reading, why = run_bounded_read(opts, opts.log_file)
            log.info("read ok=%s reason=%s", read_ok, why)
        state, messages = apply_outcome(
            state, now, opts, read_ok, reading,
            attempted=read_needed,
            failure_reason=why if read_needed else "not_attempted",
        )
        save_state(opts.state_file, state)
        render_messages(messages, opts)
        for msg in messages:
            log.info("OUT %s", msg)
        return 1 if read_needed and not read_ok and opts.fail_on_read_error else 0
    finally:
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
