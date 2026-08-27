#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bzp_ble_read_until_success.py — 包租婆(iyunmu)电表 BLE 无限重试读表器
========================================================================

目标
----
对电表 SN=YM00236K2A68 (MAC=23:06:20:00:2A:68, dev_type=YM-M4-BE) 通过蓝牙
持续重试"完整读表事务"，直到获得**有效实时读数**：

    BLE连接 -> 云端 step:1 取写缓冲 -> BLE 写入 -> 等待通知 -> 云端 step:5 解析
    -> 校验 total/surplus/switchState -> 落盘结果并退出 0

停止条件
--------
* 仅当读到并解析出有效读数时正常结束 (exit 0)。
* SIGINT/SIGTERM 可人工安全停止 (exit 130)。
* 不可恢复的本机依赖错误 (缺 paho-mqtt / bleak / gatttool / openssl 等) 直接报错 (exit 2)。
* 普通连接失败/GATT超时/云端临时错误 一律视为可重试，绝不退出。

协议依据
--------
全部命令字节/响应解析均来自逆向资产 (小程序 wxb3c93e380e7e77df, 2026-08-07 提取)：
  * ble-api.js 的 ymBleMeterRead (bzp_main_code.js offset ~189559)：
        f(连接) -> ymNetSend({cmd:"meter_ble_read", step:1})
                  -> ymBleOnlySendBuf({buf: a.data.code})   // 云端生成的写缓冲
                  -> ymNetSend({cmd:"meter_ble_read", step:5, code: 响应字节})
                  -> {total, surplus, switchState}
  * net.js E() = remoteCommandV1 (POST https://mqtt.iyunmu.com/api/v1/remoteCommandV1,
    带 SDK 签名 + AES-CBC 交织加密, HTTP 200 后等 MQTT 事件 sn/cmd)。
  * ble.js z() 写特征 / q() 通知处理 / te() Android 连接:
        service  49535343-fe7d-4ae5-8fa9-9fafd205e455
        write    49535343-8841-43f4-a8d4-ecbe34729bb3
        notify   49535343-1e4d-4bd9-ba61-23c647249616
  详见同目录 PROTOCOL.md。本脚本**不发明任何协议字节**：写缓冲来自云端 step:1。

运行
----
    python3 bzp_ble_read_until_success.py \
        --sn YM00236K2A68 --mac 23:06:20:00:2A:68 \
        --log-dir ./logs --result-file ./logs/bzp_ble_read_result.json

依赖 (运行前检测, 缺失即清晰报错退出 2):
    python3 >= 3.8, openssl 可执行文件 (AES-CBC), paho-mqtt + websocket-client (云端MQTT),
    bleak (BLE, 推荐) 或 bluez gatttool (备用)。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import logging
import math
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from typing import Optional
from logging.handlers import RotatingFileHandler
from urllib.parse import urlparse

from automation_paths import state_dir

# ---------------------------------------------------------------------------
# 常量 (全部来自逆向资产, 见 PROTOCOL.md)
# ---------------------------------------------------------------------------
DEFAULT_SN = "YM00236K2A68"
DEFAULT_MAC = "23:06:20:00:2A:68"
SERVICE_UUID = "49535343-fe7d-4ae5-8fa9-9fafd205e455"
WRITE_UUID = "49535343-8841-43f4-a8d4-ecbe34729bb3"
NOTIFY_UUID = "49535343-1e4d-4bd9-ba61-23c647249616"
CFG_URL = "https://mqtt.iyunmu.com"
CMD_METER_READ = "meter_ble_read"

# SDK 账号 (与技能 bzp_sdk.py 同源; 输出/日志中需脱敏)
USER = "2zNLcQrcBem3mVa89N0IbgG8RpavhS7o"
PASSWD = "LTiAu4PSheb6wzhuBkbuQzBD8mNAPZVY"
_SECRET_REDACTED = "LTiAu4…PZVY"  # 日志/结果文件一律使用脱敏值

EXIT_OK = 0
EXIT_FATAL = 2
EXIT_INTERRUPTED = 130

_HEX_RE = re.compile(r"^[0-9a-fA-F]*$")
_NUM_RE = re.compile(r"^\d+$")


# ---------------------------------------------------------------------------
# 异常
# ---------------------------------------------------------------------------
class DependencyError(Exception):
    """本机依赖缺失/不可用 (不可恢复)。"""


class CloudError(Exception):
    """云端调用失败 (可重试)。"""

    def __init__(self, code=None, msg="", resp=None):
        super().__init__(msg)
        self.code = code
        self.msg = msg
        self.resp = resp


class BleError(Exception):
    """BLE 操作失败 (可重试)。"""


# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------
def redact(text: str) -> str:
    """日志脱敏: 隐藏 SDK 密钥原文。"""
    if not isinstance(text, str):
        text = str(text)
    return text.replace(PASSWD, _SECRET_REDACTED)


def make_logger(log_dir: str, verbose: bool = False) -> logging.Logger:
    os.makedirs(log_dir, exist_ok=True)
    log = logging.getLogger("bzp_ble")
    log.setLevel(logging.DEBUG if verbose else logging.INFO)
    log.propagate = False
    if not log.handlers:
        fmt = logging.Formatter("%(asctime)s %(levelname)s [%(threadName)s] %(message)s")
        fh = RotatingFileHandler(
            os.path.join(log_dir, "bzp_ble_read_until_success.log"),
            maxBytes=1_000_000, backupCount=2, encoding="utf-8")
        fh.setFormatter(fmt)
        log.addHandler(fh)
        ch = logging.StreamHandler(sys.stdout)
        ch.setFormatter(fmt)
        log.addHandler(ch)
    return log


# ---------------------------------------------------------------------------
# SDK 密码学 (复刻 net.js 的 B/H/D/k/L/P; 与技能 bzp_sdk.py 同算式, 独立实现)
# ---------------------------------------------------------------------------
def sha256_upper(s: str) -> str:
    return hashlib.sha256(s.upper().encode("utf-8")).hexdigest().upper()


def sign_hex(user: str, passwd: str, a: str, ts: int) -> str:
    """net.js B()/H(): sha256(passwd + hex(ts) + user + a[2:] + hex(ts)) upper。
    a = sn (remoteCommandV1) 或 norStr (yunmuInit)。"""
    i = a[2:]
    o = hex(ts)[2:]
    return sha256_upper(passwd + o + user + i + o)


def base64_of_hex(hexstr: str) -> str:
    """net.js k(): base64(hex字符串的ASCII)。"""
    return base64.b64encode(hexstr.encode("ascii")).decode("ascii")


def rand_str(n: int = 18) -> str:
    return "".join(random.choices(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", k=n))


def _hex_to_bytes(h: str) -> bytes:
    return bytes(int(h[i:i + 2], 16) for i in range(0, len(h), 2))


def _openssl_aes(decrypt: bool, key_hex: str, iv_hex: str, data: bytes) -> bytes:
    """openssl CLI 做 AES-256-CBC (无填充)。依赖检查保证 openssl 存在。"""
    mode = ["enc", "-d"] if decrypt else ["enc"]
    p = subprocess.run(
        ["openssl", *mode, "-aes-256-cbc",
         "-K", key_hex.upper(), "-iv", iv_hex.upper(), "-nopad"],
        input=data, capture_output=True, timeout=20)
    if p.returncode != 0:
        raise CloudError(code=-1, msg="AES 失败: %s" % redact(p.stderr.decode("utf-8", "replace")[:200]))
    return p.stdout


def aes_cbc_encrypt(key_hex: str, plaintext: bytes) -> str:
    """net.js L(): iv=16字节随机大写字母数字, AES-256-CBC, iv与密文交织 -> hex -> base64。"""
    key = _hex_to_bytes(key_hex)
    iv = "".join(random.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=16)).encode("ascii")
    pad = 16 - len(plaintext) % 16
    pt = plaintext + bytes([pad]) * pad
    ct = _openssl_aes(False, key_hex, iv.hex().upper(), pt)
    inter = bytearray()
    for i in range(len(ct)):
        if i < 16:
            inter.append(iv[i])
        inter.append(ct[i])
    return base64.b64encode(bytes(inter).hex().encode("ascii")).decode("ascii")


def aes_cbc_decrypt(key_hex: str, b64: str) -> str:
    """net.js P(): base64(hex) -> 反交织 -> AES-256-CBC 解密 -> 去 PKCS7 -> utf8。"""
    key = _hex_to_bytes(key_hex)
    raw = _hex_to_bytes(base64.b64decode(b64).decode("ascii"))
    iv, ct = bytearray(), bytearray()
    for i, b in enumerate(raw):
        if i % 2 == 0 and i // 2 < 16:
            iv.append(b)
        else:
            ct.append(b)
    out = _openssl_aes(True, key_hex, bytes(iv).hex().upper(), bytes(ct))
    if out and 1 <= out[-1] <= 16 and out[-1] <= len(out):
        pad = out[-1]
        if out[-pad:] == bytes([pad]) * pad:
            out = out[:-pad]
    return out.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# devCode (ble.js he()/pe()/T(), /tmp/bzp_plugin/_appservice.js)
# ---------------------------------------------------------------------------
def _aes_ecb_128(key: bytes, data: bytes, decrypt: bool) -> bytes:
    """openssl AES-128-ECB (无填充)。密钥 16 字节; data 必须为 16 的倍数。"""
    mode = ["enc", "-d"] if decrypt else ["enc"]
    p = subprocess.run(
        ["openssl", *mode, "-aes-128-ecb", "-K", key.hex().upper(), "-nopad"],
        input=data, capture_output=True, timeout=20)
    if p.returncode != 0:
        raise CloudError(code=-1, msg="AES-ECB 失败: %s"
                         % redact(p.stderr.decode("utf-8", "replace")[:200]))
    return p.stdout


def ym_ble_calc_dev_code(mac: str, platform: str = "ios", brand: str = "yunmu",
                         randbytes: Optional[bytes] = None) -> bytes:
    """复刻小程序 ble.js he()/pe()/T() 生成 26 字节 devCode。"""
    try:
        mac_bytes = bytes(int(b, 16) for b in mac.split(":"))
    except (ValueError, AttributeError):
        raise ValueError("MAC 格式错误: %s" % mac)
    if len(mac_bytes) != 6:
        raise ValueError("MAC 必须为 6 字节: %s" % mac)
    platform_bytes = platform.encode("utf-8")
    brand_bytes = brand.encode("utf-8")
    plain = (bytes([0, 0, len(platform_bytes)]) + platform_bytes
             + bytes([len(brand_bytes)]) + brand_bytes)
    padded = (bytes([len(plain) >> 8 & 255, len(plain) & 255]) + plain
              + bytes((-(len(plain) + 2)) % 16))
    if randbytes is None:
        randbytes = bytes(random.randrange(256) for _ in range(10))
    if len(randbytes) != 10:
        raise ValueError("randbytes 必须为 10 字节")
    key = mac_bytes + bytes(randbytes)
    cipher = _aes_ecb_128(key, padded, decrypt=False)
    out = bytearray()
    for i in range(10):
        out.append(cipher[i])
        out.append(randbytes[i])
    out.extend(cipher[10:])
    return bytes(out)


def ym_ble_decode_dev_code(mac: str, code) -> bytes:
    """devCode 逆运算，仅用于自检和测试。"""
    try:
        mac_bytes = bytes(int(b, 16) for b in mac.split(":"))
    except (ValueError, AttributeError):
        raise ValueError("MAC 格式错误: %s" % mac)
    code = bytes(code)
    rand = bytes(code[i] for i in range(1, 20, 2))
    cipher = bytes(code[i] for i in range(0, 20, 2)) + code[20:]
    key = mac_bytes + rand
    padded = _aes_ecb_128(key, cipher, decrypt=True)
    data_len = (padded[0] << 8) | padded[1]
    return padded[2:2 + data_len]


# ---------------------------------------------------------------------------
# 退避 (有界 + 抖动)
# ---------------------------------------------------------------------------
class Backoff:
    """指数退避, 上限封顶, ±20% 随机抖动。"""

    def __init__(self, base: float = 2.0, cap: float = 60.0, factor: float = 2.0):
        self.base = max(0.0, base)
        self.cap = max(self.base, cap)
        self.factor = factor

    def delay(self, consecutive_failures: int) -> float:
        raw = self.base * (self.factor ** max(0, consecutive_failures - 1))
        raw = min(raw, self.cap)
        jitter = random.uniform(-0.2, 0.2) * raw
        return max(0.0, round(raw + jitter, 3))


# ---------------------------------------------------------------------------
# 有效性校验
# ---------------------------------------------------------------------------
def validate_reading(reading: dict) -> bool:
    """与小程序一致: total/surplus/switchState 齐备且可解析;
    switchState ∈ {0,1}; 数值有限。总度数 >= 0, 余额允许为负 (欠费)。"""
    try:
        total = float(reading.get("total"))
        surplus = float(reading.get("surplus"))
        sw = reading.get("switchState")
        if isinstance(sw, bool):
            sw = 1 if sw else 0
        sw = int(sw)
    except (TypeError, ValueError, AttributeError):
        return False
    if sw not in (0, 1):
        return False
    if not (math.isfinite(total) and math.isfinite(surplus)):
        return False
    if total < 0:
        return False
    return True


# ---------------------------------------------------------------------------
# 云端客户端 (复刻 net.js w/x/A/E + event.js; MQTT 响应事件 sn/cmd)
# ---------------------------------------------------------------------------
class CloudClient:
    """云端读表客户端:
       init()     = yunmuInit 拿 {client_id, mqtt_url, topic, req_topic} + 连 MQTT
       meter_ble_read_step1 = remoteCommandV1 {step:1} -> 写缓冲 bytes (云端生成)
       meter_ble_read_step5 = remoteCommandV1 {step:5, code: 响应字节} -> 读数
    """

    def __init__(self, user: str, passwd: str, base_url: str = CFG_URL,
                 timeout_http: float = 6.0, mqtt_factory=None, log: logging.Logger = None):
        self.user = user
        self.passwd = passwd
        self.base_url = base_url
        self.timeout_http = timeout_http
        self._mqtt_factory = mqtt_factory  # 测试注入; None -> paho
        self._log = log or logging.getLogger("bzp_ble")
        self._cfg = None
        self._client_id = None
        self._transport = None
        self._waiters = {}  # event_key -> {"event": threading.Event, "payload": dict}
        self._lock = threading.Lock()
        self._closed = threading.Event()
        self._closed.set()  # 初始视为未打开

    # ---------- 纯函数 (可单测) ----------
    def build_request_data(self, data: dict, timeout: int, client_id: str) -> dict:
        """net.js E(): t.data.timeout=t.timeout; t.data.client_id=f"""
        return dict(data, timeout=timeout, client_id=client_id)

    def sign_for_sn(self, sn: str, ts: int) -> str:
        return sign_hex(self.user, self.passwd, sn, ts)

    def _encrypt(self, key_hex: str, plaintext: str) -> str:
        return aes_cbc_encrypt(key_hex, plaintext.encode("utf-8"))

    @staticmethod
    def normalize_code(code) -> bytes:
        """step:1 返回的 code -> bytes。
        逆向确认小程序直接 new Int8Array(buf).buffer, 即云端返回**整数数组**;
        对 hex 字符串 / 逗号字符串做防御性兼容 (见 PROTOCOL.md 备注)。"""
        if code is None:
            raise CloudError(code=400, msg="step:1 缺少 data.code")
        if isinstance(code, bytes):
            return code
        if isinstance(code, (list, tuple)):
            try:
                return bytes(int(x) & 0xFF for x in code)
            except (TypeError, ValueError) as e:
                raise CloudError(code=400, msg="code 数组非法: %s" % e)
        if isinstance(code, str):
            s = code.strip()
            if _HEX_RE.match(s) and len(s) % 2 == 0 and s:
                return _hex_to_bytes(s)
            if "," in s and all(_NUM_RE.match(x.strip()) for x in s.split(",")):
                return bytes(int(x.strip()) for x in s.split(","))
            raise CloudError(code=400, msg="code 字符串无法解析: %r" % code[:40])
        raise CloudError(code=400, msg="code 类型不支持: %s" % type(code).__name__)

    # ---------- MQTT 路由 (复刻 net.js x() message handler) ----------
    def _on_message(self, topic: str, payload: bytes):
        """topic = X/{sn}/{cmd}/... -> 事件 {sn}/{cmd} (s[1], s[2])"""
        try:
            data = json.loads(payload.decode("utf-8", "replace"))
        except ValueError:
            return
        parts = topic.split("/")
        if len(parts) < 3:
            return
        key = "%s/%s" % (parts[1], parts[2])
        with self._lock:
            waiter = self._waiters.get(key)
        if waiter is not None:
            waiter["payload"] = data
            waiter["event"].set()

    def _wait_event(self, key: str, timeout: float, stop_event: threading.Event = None):
        with self._lock:
            waiter = self._waiters.setdefault(key, {"event": threading.Event(), "payload": None})
        ev = waiter["event"]
        deadline = time.time() + timeout
        while not ev.is_set():
            if stop_event is not None and stop_event.is_set():
                return None
            if self._closed.is_set():
                return None
            remaining = deadline - time.time()
            if remaining <= 0:
                with self._lock:
                    self._waiters.pop(key, None)
                raise CloudError(code=-1, msg="云端响应超时 (MQTT 事件 %s)" % key)
            ev.wait(min(0.25, remaining))
        with self._lock:
            self._waiters.pop(key, None)
        payload = waiter["payload"]
        ev.clear()
        return payload

    # ---------- 网络 ----------
    def _http_post(self, url: str, body: dict, headers: dict, timeout: float) -> dict:
        import urllib.request
        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
        except Exception as e:
            raise CloudError(code=-1, msg="HTTP 请求失败: %s" % redact(str(e)))
        try:
            return json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            raise CloudError(code=-1, msg="HTTP 响应非 JSON")

    def _connect_mqtt(self, cfg: dict):
        if self._mqtt_factory is not None:
            self._transport = self._mqtt_factory(cfg, self._on_message)
            self._transport.connect(timeout=15)
            return
        try:
            import paho.mqtt.client as mqtt  # type: ignore
        except ImportError:
            raise DependencyError(
                "缺少 paho-mqtt: 请执行 pip install paho-mqtt websocket-client")
        url = cfg.get("mqtt_url", "")
        p = urlparse(url)
        # yunmuInit currently returns the mini-program spelling ``wxs://``;
        # it is secure WebSocket MQTT and is equivalent to ``wss://``.
        is_websocket = url.startswith(("ws://", "wss://", "wxs://"))
        is_tls = url.startswith(("wss://", "wxs://", "mqtts://"))
        transport = "websockets" if is_websocket else "tcp"
        if p.port:
            port = p.port
        elif transport == "websockets":
            port = 443 if is_tls else 80
        else:
            port = 8883 if url.startswith("mqtts://") else 1883
        client_id = cfg.get("client_id")
        # MQTT v5 deliberately has no ``clean_session`` constructor argument.
        # Paho 2.x rejects it with ValueError before any network connection is
        # attempted.  The broker returns a fresh client_id for every yunmuInit,
        # so the v5 default clean-start behaviour is what we want here.
        kwargs = dict(client_id=client_id, protocol=mqtt.MQTTv5, transport=transport)
        if hasattr(mqtt, "CallbackAPIVersion"):
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, **kwargs)
        else:
            client = mqtt.Client(**kwargs)
        if transport == "websockets":
            client.ws_set_options(path=p.path or "/mqtt")
        if is_tls:
            client.tls_set()
        client.username_pw_set(self.user, self.passwd)
        client.reconnect_delay_set(min_delay=1, max_delay=30)
        client.on_message = lambda c, u, m: self._on_message(m.topic, m.payload)
        try:
            client.connect(p.hostname, port, keepalive=55)
        except Exception as e:
            raise CloudError(code=-1, msg="MQTT 连接失败: %s" % redact(str(e)))
        client.loop_start()
        try:
            res = client.subscribe(cfg.get("topic", "#"), qos=2)
            if isinstance(res, tuple) and res[0] not in (mqtt.MQTT_ERR_SUCCESS, 0):
                raise CloudError(code=-1, msg="MQTT 订阅失败: %r" % (res,))
        except CloudError:
            raise
        except Exception:
            pass  # 订阅失败不致命, 事件仍可能到达
        self._transport = client

    def init(self, stop_event: threading.Event = None):
        """yunmuInit + MQTT 连接 (复刻 net.js w()/x())。"""
        self._closed.clear()
        ts = int(time.time())
        nor = rand_str(18)
        sig = sign_hex(self.user, self.passwd, nor, ts)
        resp = self._http_post(
            self.base_url + "/api/v1/yunmuInit",
            {"username": self.user, "password": self.passwd, "test": False},
            {"Content-Type": "application/json", "version": "2",
             "timestamp": str(ts), "norStr": nor, "sign": base64_of_hex(sig)},
            self.timeout_http)
        if resp.get("code") != 200:
            raise CloudError(code=resp.get("code"), msg="yunmuInit 失败: %s" % resp.get("msg"))
        d = resp.get("data") or {}
        if d.get("ciphertext"):
            try:
                cfg = json.loads(aes_cbc_decrypt(sig, d["ciphertext"]))
            except Exception as e:
                raise CloudError(code=400, msg="yunmuInit 解密失败: %s" % redact(str(e)))
        else:
            cfg = d
        self._cfg = cfg
        self._client_id = cfg.get("client_id") or cfg.get("clientId")
        if not self._client_id:
            raise CloudError(code=400, msg="yunmuInit 未返回 client_id")
        self._connect_mqtt(cfg)
        self._log.info("云端初始化完成: client_id=%s… mqtt=%s topic=%s",
                       redact(str(self._client_id))[:8], redact(cfg.get("mqtt_url", "")),
                       redact(cfg.get("topic", "")))

    # ---------- meter_ble_read ----------
    def remote_command(self, sn: str, cmd: str, data: dict, timeout: int,
                       stop_event: threading.Event = None) -> dict:
        """net.js E() remoteCommandV1 + MQTT 事件 sn/cmd。"""
        if self._client_id is None:
            raise CloudError(code=-1, msg="云端未初始化")
        body_data = self.build_request_data(data, timeout, self._client_id)
        ts = int(time.time())
        key = self.sign_for_sn(sn, ts)
        cipher = self._encrypt(key, json.dumps(body_data, ensure_ascii=False))
        resp = self._http_post(
            self.base_url + "/api/v1/remoteCommandV1",
            {"ciphertext": cipher},
            {"Content-Type": "application/json",
             "x-api-key": self.user, "x-api-secret": self.passwd,
             "x-api-timestamp": str(ts), "x-api-sn": sn,
             "version": "3", "platform": "WX"},
            self.timeout_http)
        if resp.get("code") != 200:
            raise CloudError(code=resp.get("code"),
                             msg="remoteCommandV1 失败: %s" % resp.get("msg", resp))
        event_key = "%s/%s" % (sn, cmd)
        payload = self._wait_event(event_key, timeout=timeout, stop_event=stop_event)
        if payload is None:
            raise CloudError(code=-1, msg="云端响应超时 (cmd=%s)" % cmd)
        return payload

    def meter_ble_read_step1(self, sn: str, timeout: int,
                             stop_event: threading.Event = None) -> bytes:
        payload = self.remote_command(sn, CMD_METER_READ, {"step": 1}, timeout, stop_event)
        if str(payload.get("code")) != "200":
            raise CloudError(code=payload.get("code"), msg="step:1 失败: %s" % payload.get("msg"))
        code = (payload.get("data") or {}).get("code")
        return self.normalize_code(code)

    def meter_ble_read_step5(self, sn: str, resp_bytes: bytes, timeout: int,
                             stop_event: threading.Event = None) -> dict:
        payload = self.remote_command(
            sn, CMD_METER_READ, {"step": 5, "code": list(resp_bytes)}, timeout, stop_event)
        if str(payload.get("code")) != "200":
            raise CloudError(code=payload.get("code"), msg="step:5 失败: %s" % payload.get("msg"))
        d = payload.get("data") or {}
        return {"total": d.get("total"), "surplus": d.get("surplus"),
                "switchState": d.get("switchState")}

    def close(self):
        self._closed.set()
        with self._lock:
            for w in self._waiters.values():
                w["event"].set()
            self._waiters.clear()
        if self._transport is not None:
            try:
                if hasattr(self._transport, "loop_stop"):
                    self._transport.loop_stop()
                if hasattr(self._transport, "disconnect"):
                    self._transport.disconnect()
            except Exception:
                pass
            self._transport = None


class BusinessCloudClient:
    """当前包租婆小程序使用的 BLE 读表链路 (HTTP 版)。

    当前版本先调用带用户登录态的 ``/ymSdk/ble_read_meter`` 生成业务命令，
    再通过设备 SDK 的 ``bleCommandV1`` 完成请求/响应解析。isRes=0/1 两次
    请求复用同一 devCode/macList；当前响应字段为 total_value、
    surplus_value、switch_status。登录态只从权限为 0600 的本机 auth JSON
    读取，日志中绝不输出其内容。
    """

    BUSINESS_URL = "https://bzp.iyunmu.com/bzp_backup/ymSdk/ble_read_meter"
    GATEWAY_URL = CFG_URL + "/api/v1/bleCommandV1"

    def __init__(self, user: str, passwd: str, auth_file: str,
                 timeout_http: float = 10.0, mac: Optional[str] = None,
                 platform: str = "ios", brand: str = "yunmu",
                 log: logging.Logger = None):
        self.user = user
        self.passwd = passwd
        self.auth_file = os.path.abspath(os.path.expanduser(auth_file))
        self.timeout_http = timeout_http
        self.mac = mac
        self.platform = platform
        self.brand = brand
        self._log = log or logging.getLogger("bzp_ble")
        self._auth = None
        self._pending = None

    def _post(self, url: str, body: dict, headers: dict) -> dict:
        import urllib.request
        req = urllib.request.Request(
            url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_http) as response:
                raw = response.read()
            return json.loads(raw.decode("utf-8", "replace"))
        except Exception as e:
            raise CloudError(code=-1, msg="HTTP 请求失败: %s" % redact(str(e)))

    def init(self, stop_event: threading.Event = None):
        try:
            st = os.stat(self.auth_file)
            if st.st_mode & 0o077:
                raise DependencyError("登录态文件权限过宽，必须为 0600: %s" % self.auth_file)
            with open(self.auth_file, "r", encoding="utf-8") as f:
                auth = json.load(f)
        except DependencyError:
            raise
        except Exception as e:
            raise DependencyError("无法读取包租婆登录态: %s" % redact(str(e)))
        required = ("X-CSRFToken", "Cookie", "userid", "mapp-id", "role-id")
        missing = [key for key in required if not auth.get(key)]
        if missing:
            raise DependencyError("包租婆登录态缺少字段: %s" % ",".join(missing))
        self._auth = auth
        self._log.info("包租婆业务登录态已载入 (内容已脱敏)")

    def _business_headers(self) -> dict:
        if self._auth is None:
            raise CloudError(code=-1, msg="业务登录态未初始化")
        headers = dict(self._auth)
        headers["content-type"] = "application/json;charset=UTF-8"
        headers["x-timestamp"] = str(int(time.time()))
        return headers

    def _dev_code_and_maclist(self):
        """按小程序连接期逻辑计算，并在同一事务的两次请求中复用。"""
        if not self.mac:
            return [], []
        try:
            dev_code = list(ym_ble_calc_dev_code(self.mac, self.platform,
                                                  self.brand))
        except Exception as e:
            self._log.warning("devCode 计算失败, 退化为空数组: %s",
                              redact(str(e))[:120])
            return [], []
        return dev_code, [self.mac]

    def _gateway(self, sn: str, payload: dict) -> dict:
        data = dict(payload)
        data.setdefault("devCode", [])
        data.setdefault("macList", [])
        data.setdefault("sn", sn)
        data.setdefault("test", False)
        data.setdefault("noCheck", False)
        ts = int(time.time())
        key = sign_hex(self.user, self.passwd, sn, ts)
        encrypted = aes_cbc_encrypt(
            key, json.dumps(data, ensure_ascii=False).encode("utf-8"))
        response = self._post(
            self.GATEWAY_URL, {"ciphertext": encrypted},
            {"content-type": "application/json", "x-api-key": self.user,
             "x-api-secret": self.passwd, "x-api-timestamp": str(ts),
             "x-api-sn": sn, "version": "5", "platform": "WX"})
        if response.get("code") != 200:
            raise CloudError(code=response.get("code"),
                             msg="bleCommandV1 失败: %s" % response.get("msg"))
        ciphertext = (response.get("data") or {}).get("ciphertext")
        if not ciphertext:
            raise CloudError(code=400, msg="bleCommandV1 响应缺少 ciphertext")
        try:
            return json.loads(aes_cbc_decrypt(key, ciphertext))
        except Exception as e:
            raise CloudError(code=400, msg="bleCommandV1 解密失败: %s" % redact(str(e)))

    @staticmethod
    def _decode_gateway_code(code, tx_msg_id) -> bytes:
        if not isinstance(code, str):
            return CloudClient.normalize_code(code)
        try:
            tx = int(tx_msg_id)
            groups = [code[i:i + 3] for i in range(0, len(code), 3)]
            if not groups or any(len(group) != 3 for group in groups):
                raise ValueError("分组长度错误")
            return bytes((int(group, 16) - tx) & 0xFF for group in reversed(groups))
        except Exception as e:
            raise CloudError(code=400, msg="网关写缓冲解析失败: %s" % redact(str(e)))

    @staticmethod
    def _response_sign(access_key, packet: bytes, timestamp, sn: str) -> str:
        packet_hex = "".join("%02x" % value for value in reversed(packet))
        stamp_hex = hex(int(timestamp))[2:]
        source = packet_hex + str(timestamp) + str(access_key) + sn[2:] + stamp_hex
        digest = hashlib.sha256(source.upper().encode("utf-8")).hexdigest().upper()
        return base64.b64encode(digest.encode("ascii")).decode("ascii")

    def meter_ble_read_step1(self, sn: str, timeout: int,
                             stop_event: threading.Event = None) -> bytes:
        response = self._post(
            self.BUSINESS_URL, {"sn": sn}, self._business_headers())
        if response.get("code") != 200 or not isinstance(response.get("data"), dict):
            raise CloudError(code=response.get("code"),
                             msg="ble_read_meter 失败: %s" % response.get("msg"))
        command = dict(response["data"])
        command["user_id"] = self._auth["userid"]
        payload = {key: command.get(key) for key in
                   ("cmdType", "ver", "params", "access_key", "sign", "timeStamp")}
        payload.update({"forge_flag": command.get("forge_flag", False),
                        "isRes": 0, "user_id": command["user_id"]})
        if command.get("callback"):
            payload["callback"] = command["callback"]
        dev_code, mac_list = self._dev_code_and_maclist()
        payload.update({"devCode": dev_code, "macList": mac_list, "sn": sn,
                        "test": False, "noCheck": False})
        gateway = self._gateway(sn, payload)
        tx_msg_id = gateway.get("txMsgId")
        self._pending = {"command": command, "txMsgId": tx_msg_id,
                         "devCode": dev_code, "macList": mac_list}
        return self._decode_gateway_code(gateway.get("code"), tx_msg_id)

    def meter_ble_read_step5(self, sn: str, resp_bytes: bytes, timeout: int,
                             stop_event: threading.Event = None) -> dict:
        if not self._pending:
            raise CloudError(code=400, msg="缺少当前 BLE 事务上下文")
        command = self._pending["command"]
        packet = bytes(resp_bytes)
        dev_code = self._pending.get("devCode", [])
        mac_list = self._pending.get("macList", [])
        payload = {
            "cmdType": command.get("cmdType"), "ver": command.get("ver"),
            "pkt": list(packet), "isRes": 1,
            "access_key": command.get("access_key"),
            "timeStamp": command.get("timeStamp"),
            "forge_flag": command.get("forge_flag", False),
            "user_id": command.get("user_id"),
            "devCode": dev_code, "macList": mac_list, "sn": sn,
            "test": False, "noCheck": False,
            "sign": self._response_sign(command.get("access_key"), packet,
                                         command.get("timeStamp"), sn),
        }
        if self._pending.get("txMsgId"):
            payload["txMsgId"] = self._pending["txMsgId"]
        if command.get("callback"):
            payload["callback"] = command["callback"]
        result = self._gateway(sn, payload)
        self._pending = None
        if isinstance(result, dict) and result.get("errno") not in (None, 0):
            raise CloudError(code=result.get("errno"),
                             msg="bleCommandV1 业务失败: %s" % result.get("msg"))
        if not isinstance(result, dict):
            raise CloudError(code=400, msg="bleCommandV1 step5 响应非对象")
        reading = {
            "total": result.get("total_value", result.get("total")),
            "surplus": result.get("surplus_value", result.get("surplus")),
            "switchState": result.get("switch_status", result.get("switchState")),
        }
        for key in ("elec_rate", "read_time"):
            if result.get(key) is not None:
                reading[key] = result[key]
        return reading

    def close(self):
        self._pending = None


# ---------------------------------------------------------------------------
# BLE 后端
# ---------------------------------------------------------------------------
class BleBackendBase:
    name = "base"

    def open(self): ...

    def connect(self, mac: str, timeout: float): ...

    def discover(self):
        """返回 (service_uuid, write_uuid, notify_uuid)"""
        return SERVICE_UUID, WRITE_UUID, NOTIFY_UUID

    def start_notify(self, notify_uuid: str): ...

    def write(self, write_uuid: str, data: bytes): ...

    def wait_notification(self, timeout: float, stop_event: threading.Event = None):
        """返回 bytes; 超时/停止返回 None"""
        ...

    def disconnect(self): ...

    def soft_recover(self): ...

    def close(self): ...


class BleakBackend(BleBackendBase):
    """首选后端: bleak (纯 Python + dbus-fast / winrt)。"""
    name = "bleak"

    def __init__(self, hci: str = "hci0", log: logging.Logger = None):
        self.hci = hci
        self._log = log or logging.getLogger("bzp_ble")
        self._client = None
        self._q = None
        self._adapter_check_done = False

    def open(self):
        try:
            import bleak  # noqa
        except ImportError:
            raise DependencyError("缺少 bleak: 请执行 pip install bleak")
        if not self._adapter_check_done:
            # 轻量探测适配器 (不发起扫描)
            try:
                import bleak
                _ = bleak.BleakScanner  # 触发 dbus 后端加载
            except Exception as e:
                raise DependencyError("BLE 适配器不可用: %s" % redact(str(e)))
            self._adapter_check_done = True

    def connect(self, mac: str, timeout: float):
        import bleak
        self._client = bleak.BleakClient(mac, timeout=timeout)
        try:
            self._client.connect(timeout=timeout)
        except Exception as e:
            self._client = None
            raise BleError("连接失败 %s: %s" % (mac, redact(str(e))[:160]))

    def discover(self):
        if self._client is None:
            raise BleError("未连接")
        svc, wr, nt = SERVICE_UUID, WRITE_UUID, NOTIFY_UUID
        try:
            services = self._client.services
            if not getattr(services, "services", None) and hasattr(self._client, "get_services"):
                services = self._client.get_services()
            found_svc = None
            for s in services.services.values():
                if s.uuid.lower().startswith("49535343") or s.uuid.lower() == SERVICE_UUID:
                    found_svc = s
                    break
            if found_svc is None:
                raise BleError("未找到服务 %s" % SERVICE_UUID)
            svc = found_svc.uuid
            chars = list(found_svc.characteristics.values()) or []
            if not chars:
                raise BleError("服务 %s 无特征" % svc)
            by_uuid = {c.uuid.lower(): c for c in chars}
            wr = WRITE_UUID if WRITE_UUID.lower() in by_uuid else \
                (next((c.uuid for c in chars if c.properties & {"write", "write-without-response"}), chars[0].uuid))
            nt = NOTIFY_UUID if NOTIFY_UUID.lower() in by_uuid else \
                (next((c.uuid for c in chars if c.properties & {"notify", "indicate"}), chars[0].uuid))
            self._log.info("GATT: svc=%s write=%s notify=%s", svc, wr, nt)
        except BleError:
            raise
        except Exception as e:
            raise BleError("服务发现失败: %s" % redact(str(e))[:160])
        return svc, wr, nt

    def start_notify(self, notify_uuid: str):
        if self._client is None:
            raise BleError("未连接")
        import queue
        self._q = queue.Queue()

        def _cb(_c, data: bytearray):
            self._q.put(bytes(data))

        try:
            self._client.start_notify(notify_uuid, _cb)
        except Exception as e:
            raise BleError("订阅通知失败: %s" % redact(str(e))[:160])

    def write(self, write_uuid: str, data: bytes):
        if self._client is None:
            raise BleError("未连接")
        # 复刻 ble.js z(): 先带响应写, 失败回退无响应写
        last = None
        for response in (True, False):
            try:
                self._client.write_gatt_char(write_uuid, bytearray(data), response=response)
                return
            except Exception as e:
                last = e
        raise BleError("写入失败: %s" % redact(str(last))[:160])

    def wait_notification(self, timeout: float, stop_event: threading.Event = None):
        if self._q is None:
            raise BleError("未订阅通知")
        deadline = time.time() + timeout
        while True:
            if stop_event is not None and stop_event.is_set():
                return None
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            try:
                return self._q.get(timeout=min(0.25, remaining))
            except Exception:
                continue

    def disconnect(self):
        if self._client is not None:
            try:
                self._client.disconnect()
            except Exception:
                pass
            self._client = None

    def soft_recover(self):
        """安全软恢复: bluetoothctl 电源循环 (仅瞬时状态, 不动系统配置)。"""
        try:
            before = subprocess.run(["bluetoothctl", "show"], capture_output=True, text=True, timeout=10)
            self._log.info("软恢复: 检查适配器状态")
            subprocess.run(["bluetoothctl", "power", "off"], capture_output=True, timeout=10)
            time.sleep(1.5)
            subprocess.run(["bluetoothctl", "power", "on"], capture_output=True, timeout=10)
            time.sleep(1.5)
            self._log.info("软恢复完成 (适配器电源循环)")
        except Exception as e:
            self._log.warning("软恢复失败(继续重试): %s", redact(str(e))[:120])

    def close(self):
        self.disconnect()


class GatttoolBackend(BleBackendBase):
    """BlueZ gatttool 后端，整轮事务保持同一个交互连接。"""
    name = "gatttool"

    def __init__(self, hci: str = "hci0", log: logging.Logger = None):
        self.hci = hci
        self._log = log or logging.getLogger("bzp_ble")
        self._child = None
        self._write_handle = None
        self._cccd_handle = None
        self._notifications = []

    def open(self):
        if shutil.which("gatttool") is None or shutil.which("hcitool") is None:
            raise DependencyError("缺少 bluez 工具: 请安装 bluez (gatttool/hcitool) 或 pip install bleak")
        try:
            import pexpect  # noqa: F401
        except ImportError:
            raise DependencyError("缺少 pexpect: 请安装 python3-pexpect")

    def _prompt_command(self, command: str, timeout: float) -> str:
        """在已连接的同一 gatttool 会话中执行命令并等提示符返回。"""
        import pexpect
        if self._child is None or not self._child.isalive():
            raise BleError("GATT 会话未连接")
        self._child.sendline(command)
        idx = self._child.expect([r"\[LE\][^\r\n]*>", pexpect.EOF, pexpect.TIMEOUT], timeout=timeout)
        out = self._child.before or ""
        if idx == 1:
            raise BleError("gatttool 会话意外结束: %s" % redact(out)[-160:])
        if idx == 2:
            raise BleError("gatttool 命令超时(%s): %s" % (command.split()[0], redact(out)[-160:]))
        return out

    def _command_until(self, command: str, needles: list, timeout: float) -> str:
        """执行异步 gatttool 命令，等到所需输出全部真正出现。

        gatttool 会在 ``primary``/``characteristics`` 命令刚提交时先打印
        一个提示符，随后才异步输出结果，因此不能把提示符当完成标志。
        """
        import pexpect
        if self._child is None or not self._child.isalive():
            raise BleError("GATT 会话未连接")
        self._child.sendline(command)
        patterns = ["(?i)" + re.escape(n) for n in needles]
        seen = set()
        chunks = []
        deadline = time.time() + timeout
        while len(seen) < len(needles):
            remaining = deadline - time.time()
            if remaining <= 0:
                raise BleError("gatttool 命令超时(%s): %s" %
                               (command.split()[0], redact("".join(chunks))[-160:]))
            idx = self._child.expect(
                patterns + [r"Error:", pexpect.EOF, pexpect.TIMEOUT],
                timeout=remaining)
            chunks.append((self._child.before or "") +
                          (self._child.after if isinstance(self._child.after, str) else ""))
            self._capture_notifications(chunks[-1])
            if idx < len(patterns):
                seen.add(idx)
                continue
            if idx == len(patterns):
                raise BleError("gatttool 命令失败(%s): %s" %
                               (command.split()[0], redact("".join(chunks))[-160:]))
            if idx == len(patterns) + 1:
                raise BleError("gatttool 会话意外结束")
            raise BleError("gatttool 命令超时(%s): %s" %
                           (command.split()[0], redact("".join(chunks))[-160:]))
        return "".join(chunks)

    def _capture_notifications(self, text: str):
        for match in re.finditer(
                r"(?:Notification|Indication) handle = 0x[0-9a-fA-F]+ "
                r"value:\s*([0-9a-fA-F ]+)", text):
            try:
                self._notifications.append(
                    bytes(int(value, 16) for value in match.group(1).split()))
            except ValueError:
                continue

    def connect(self, mac: str, timeout: float):
        import pexpect
        self.disconnect()
        self._mac = mac
        self._child = pexpect.spawn(
            "gatttool", ["-i", self.hci, "-b", mac, "--interactive"],
            encoding="utf-8", codec_errors="replace", timeout=timeout, echo=False)
        idx = self._child.expect([r"\[LE\][^\r\n]*>", pexpect.EOF, pexpect.TIMEOUT], timeout=5)
        if idx != 0:
            self.disconnect()
            raise BleError("gatttool 未进入交互模式")
        self._child.sendline("connect")
        idx = self._child.expect(
            ["Connection successful", r"Error:", pexpect.EOF, pexpect.TIMEOUT],
            timeout=timeout)
        out = self._child.before or ""
        if idx != 0:
            self.disconnect()
            raise BleError("gatttool 连接失败: %s" % redact(out)[-160:])
        # 这个 gatttool 版本在 ``Connection successful`` 后不会再打印一遍
        # 提示符；直接发送下一条命令，由 _prompt_command 等命令结束提示符。
        primary_out = self._command_until("primary", [SERVICE_UUID], timeout)
        service_start = "0x000e"
        for line in primary_out.splitlines():
            if SERVICE_UUID.lower() in line.lower():
                match = re.search(r"attr handle:\s*(0x[0-9a-fA-F]+)", line)
                if match:
                    service_start = match.group(1)
                break
        out = self._command_until(
            "characteristics %s 0xffff" % service_start,
            [WRITE_UUID, NOTIFY_UUID], timeout)
        wr = nt = None
        for m in re.finditer(
                r"char value handle\s*[:=]\s*(0x[0-9a-fA-F]+)[^\n]*"
                r"uuid\s*[:=]\s*(\S+)", out):
            h, u = m.group(1), m.group(2)
            if u.lower() == WRITE_UUID.lower():
                wr = h
            if u.lower() == NOTIFY_UUID.lower():
                nt = h
        if wr is None or nt is None:
            raise BleError("特征缺失 write=%s notify=%s" % (wr, nt))
        self._write_handle = wr
        # CCCD 通常在通知特征 value handle + 1
        self._cccd_handle = "0x%x" % (int(nt, 16) + 1)
        self._log.info("GATT: write_handle=%s notify_cccd=%s", self._write_handle,
                       self._cccd_handle)

    def start_notify(self, notify_uuid: str):
        self._notifications = []
        self._command_until(
            "char-write-req %s 0100" % self._cccd_handle,
            ["Characteristic value was written successfully"], timeout=10)

    def write(self, write_uuid: str, data: bytes):
        hexs = data.hex()
        if self._child is None or not self._child.isalive():
            raise BleError("GATT 会话未连接")
        # 目标特征 properties=0x04，只支持 Write Without Response。直接发 cmd
        # 可避免等待 10 秒的 write-request 错误期间吞掉设备的即时通知。
        self._child.sendline("char-write-cmd %s %s" % (self._write_handle, hexs))

    def wait_notification(self, timeout: float, stop_event: threading.Event = None):
        import pexpect
        if self._child is None or not self._child.isalive():
            raise BleError("GATT 会话未连接")
        if self._notifications:
            return self._notifications.pop(0)
        deadline = time.time() + timeout
        while True:
            if stop_event is not None and stop_event.is_set():
                return None
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            idx = self._child.expect(
                [r"(?:Notification|Indication) handle = 0x[0-9a-fA-F]+ value:\s*([0-9a-fA-F ]+)",
                 pexpect.EOF, pexpect.TIMEOUT],
                timeout=min(0.5, remaining))
            if idx == 0:
                try:
                    return bytes(int(x, 16) for x in self._child.match.group(1).split())
                except ValueError:
                    continue
            if idx == 1:
                raise BleError("等待通知时 GATT 会话断开")
            if idx == 2:
                continue

    def disconnect(self):
        if self._child is not None:
            try:
                if self._child.isalive():
                    self._child.sendline("disconnect")
                    time.sleep(0.2)
            except Exception:
                pass
            try:
                self._child.close(force=True)
            except Exception:
                pass
            self._child = None

    def soft_recover(self):
        try:
            subprocess.run(["bluetoothctl", "power", "off"], capture_output=True, timeout=10)
            time.sleep(1.5)
            subprocess.run(["bluetoothctl", "power", "on"], capture_output=True, timeout=10)
            time.sleep(1.5)
            self._log.info("软恢复完成 (适配器电源循环)")
        except Exception as e:
            self._log.warning("软恢复失败(继续重试): %s", redact(str(e))[:120])

    def close(self):
        self.disconnect()


def _find_spec_safe(name):
    """find_spec 的容错包装: 父包缺失时 find_spec('paho.mqtt') 会抛 ModuleNotFoundError。"""
    try:
        return importlib.util.find_spec(name)
    except (ImportError, ModuleNotFoundError, ValueError, AttributeError):
        return None


def make_backend(kind: str, log: logging.Logger = None) -> BleBackendBase:
    if kind == "bleak":
        return BleakBackend(log=log)
    if kind == "gatttool":
        return GatttoolBackend(log=log)
    if kind == "auto":
        if shutil.which("gatttool"):
            # This implementation's gatttool path is synchronous and has been
            # exercised against the local BlueZ adapter. Bleak 2.x exposes an
            # async-only client API, so do not select it implicitly here.
            log.info("自动选择已验证的 gatttool 后端")
            return GatttoolBackend(log=log)
        if _find_spec_safe("bleak") is not None:
            raise DependencyError(
                "检测到 bleak 但缺少已验证的同步 BLE 后端; 请安装 bluez gatttool")
        raise DependencyError("无可用 BLE 后端: 请 pip install bleak 或安装 bluez gatttool")
    raise DependencyError("未知后端: %s" % kind)


# ---------------------------------------------------------------------------
# 依赖检查
# ---------------------------------------------------------------------------
def check_dependencies(backend_kind: str = "auto", which=shutil.which,
                       find_spec=_find_spec_safe) -> list:
    """返回 [(名称, 是否就绪, 提示)]"""
    checks = [
        ("python", sys.version_info >= (3, 8), "需要 Python >= 3.8"),
        ("openssl", which("openssl") is not None, "需要 openssl (AES-CBC, 请安装 openssl)"),
        ("paho-mqtt", find_spec("paho.mqtt") is not None,
         "需要 paho-mqtt: pip install paho-mqtt websocket-client"),
    ]
    if backend_kind in ("auto", "bleak"):
        checks.append(("bleak", find_spec("bleak") is not None, "需要 bleak: pip install bleak"))
    if backend_kind in ("auto", "gatttool"):
        checks.append(("gatttool", which("gatttool") is not None,
                       "需要 bluez gatttool (apt install bluez)"))
    return checks


def assert_dependencies(checks: list):
    missing = [c for c in checks if not c[1]]
    if missing:
        hints = "\n".join("  - %s: %s" % (c[0], c[2]) for c in missing)
        raise DependencyError("本机依赖缺失, 无法可靠运行:\n%s\n"
                              "请先安装依赖; 修复后重新运行本脚本。"
                              "(可加 --skip-dep-check 跳过, 仅建议测试用)" % hints)


# ---------------------------------------------------------------------------
# 重试引擎
# ---------------------------------------------------------------------------
class BleReadRetryEngine:
    def __init__(self, sn: str, mac: str, backend: BleBackendBase, cloud: CloudClient,
                 opts, log: logging.Logger = None):
        self.sn = sn
        self.mac = mac
        self.backend = backend
        self.cloud = cloud
        self.opts = opts
        self._log = log or logging.getLogger("bzp_ble")
        self.stop_event = threading.Event()
        self.started_at = time.time()
        self.backoff = Backoff(base=opts.base_backoff, cap=opts.max_backoff)
        self.round_no = 0
        self.consecutive_failures = 0
        self.total_attempts = 0
        self._signal_installed = False

    # ---------- 信号安全停止 ----------
    def install_signal_handlers(self):
        if threading.current_thread() is not threading.main_thread():
            return  # 仅在主线程安装 (测试在子线程运行时跳过)
        def _handler(signum, _frame):
            self._log.warning("收到停止信号 %s, 正在安全退出…", signum)
            self.stop_event.set()
        try:
            signal.signal(signal.SIGINT, _handler)
            signal.signal(signal.SIGTERM, _handler)
            self._signal_installed = True
        except (ValueError, OSError):
            pass

    def request_stop(self):
        self.stop_event.set()

    # ---------- 单轮事务 ----------
    def _attempt_round(self) -> Optional[dict]:
        """连接->服务发现->订阅通知->(step1->写->等通知->step5->校验) 至多 round_attempts 次。
        任何普通失败返回 None (外层无限重试)。每轮无论成败都彻底断开清理。"""
        self._log.info("=== 第 %d 轮开始 (连续失败 %d) ===", self.round_no, self.consecutive_failures)
        try:
            try:
                self.backend.connect(self.mac, self.opts.connect_timeout)
                _svc, wr, nt = self.backend.discover()
                self.backend.start_notify(nt)
            except BleError as e:
                self._log.warning("BLE 连接/发现失败: %s", redact(str(e))[:160])
                return None
            for attempt in range(1, self.opts.round_attempts + 1):
                if self.stop_event.is_set():
                    return None
                self.total_attempts += 1
                self._log.info("-- 第 %d 轮/尝试 %d: 云端取写缓冲 step:1 --", self.round_no, attempt)
                try:
                    buf = self.cloud.meter_ble_read_step1(self.sn, self.opts.timeout,
                                                          self.stop_event)
                except CloudError as e:
                    self._log.warning("step:1 失败: %s", redact(str(e))[:160])
                    continue
                if self.stop_event.is_set():
                    return None
                self._log.info("-- 写入 BLE %d 字节 --", len(buf))
                try:
                    self.backend.write(wr, buf)
                except BleError as e:
                    self._log.warning("BLE 写入失败: %s", redact(str(e))[:160])
                    continue
                resp = self.backend.wait_notification(self.opts.timeout, self.stop_event)
                if resp is None:
                    self._log.warning("设备响应超时 (通知未到) — 常规重试")
                    continue
                self._log.info("-- 收到通知 %d 字节, 云端解析 step:5 --", len(resp))
                try:
                    reading = self.cloud.meter_ble_read_step5(self.sn, resp,
                                                              self.opts.timeout,
                                                              self.stop_event)
                except CloudError as e:
                    self._log.warning("step:5 失败: %s", redact(str(e))[:160])
                    continue
                if validate_reading(reading):
                    reading["_round"] = self.round_no
                    reading["_attempt"] = attempt
                    return reading
                self._log.warning("读数无效, 重试: %s",
                                  {k: reading.get(k) for k in ("total", "surplus", "switchState")})
            return None
        finally:
            try:
                self.backend.disconnect()
                self._log.info("本轮清理完成 (连接已断开)")
            except Exception as e:
                self._log.warning("清理异常: %s", redact(str(e))[:120])

    # ---------- 软恢复 ----------
    def _soft_recover(self, cloud=None):
        self._log.warning("连续失败 %d 轮, 执行 BLE 适配器软恢复", self.consecutive_failures)
        try:
            self.backend.disconnect()
        except Exception:
            pass
        self.backend.soft_recover()
        if cloud is not None:
            try:
                cloud.close()
            except Exception:
                pass
        self.consecutive_failures = 0

    # ---------- 结果落盘 ----------
    def _write_json(self, data: dict):
        path = self.opts.result_file
        if not path:
            return
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        data.setdefault("script", "bzp_ble_read_until_success.py")
        data.setdefault("python", sys.version.split()[0])
        data.setdefault("started_at", time.strftime("%Y-%m-%dT%H:%M:%S%z",
                                                    time.localtime(self.started_at)))
        data.setdefault("finished_at", time.strftime("%Y-%m-%dT%H:%M:%S%z"))
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        self._log.info("结果已写入 %s", path)

    def _save_result(self, reading: dict):
        self._write_json({
            "status": "success",
            "sn": self.sn,
            "mac": self.mac,
            "read_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "rounds": self.round_no,
            "total_attempts": self.total_attempts,
            "elapsed_seconds": round(time.time() - self.started_at, 1),
            "total": reading.get("total"),
            "surplus": reading.get("surplus"),
            "switchState": reading.get("switchState"),
            "switchState_bool": bool(int(reading.get("switchState"))),
            "source": "ble_live",
        })

    def _save_interrupted(self):
        self._write_json({
            "status": "interrupted",
            "sn": self.sn,
            "mac": self.mac,
            "rounds": self.round_no,
            "total_attempts": self.total_attempts,
            "elapsed_seconds": round(time.time() - self.started_at, 1),
            "note": "由 SIGINT/SIGTERM 人工停止 (未获得有效读数)",
        })

    # ---------- 主循环 ----------
    def run(self) -> int:
        self.install_signal_handlers()
        try:
            self.backend.open()
        except DependencyError as e:
            self._log.error("依赖检查失败: %s", redact(str(e)))
            return EXIT_FATAL

        self._log.info("开始无限重试读表: sn=%s mac=%s (Ctrl+C 停止)", self.sn, self.mac)
        cloud_ready = False
        while not self.stop_event.is_set():
            if self.opts.max_rounds and self.round_no >= self.opts.max_rounds:
                self._log.info("达到 --max-rounds=%d, 停止", self.opts.max_rounds)
                self._write_json({"status": "max_rounds", "sn": self.sn, "mac": self.mac,
                                  "rounds": self.round_no})
                return EXIT_OK
            self.round_no += 1
            if not cloud_ready:
                try:
                    self.cloud.init(stop_event=self.stop_event)
                    cloud_ready = True
                except DependencyError as e:
                    self._log.error("依赖检查失败: %s", redact(str(e)))
                    return EXIT_FATAL
                except CloudError as e:
                    # 普通网络/云端临时失败: 不退出, 退避后重试
                    self._log.warning("云端初始化失败, 稍后重试: %s", redact(str(e))[:200])
                    self._round_failed_backoff()
                    continue
            reading = self._attempt_round()
            if reading is not None:
                self.consecutive_failures = 0
                self._save_result(reading)
                self._log.info("★★★ 读到有效实时读数: total=%s surplus=%s switchState=%s ★★★",
                               reading.get("total"), reading.get("surplus"),
                               reading.get("switchState"))
                return EXIT_OK
            self.consecutive_failures += 1
            if self.consecutive_failures >= self.opts.soft_reset_after:
                self._soft_recover(self.cloud)
                cloud_ready = False  # 软恢复后云端也重连
            delay = self.backoff.delay(self.consecutive_failures)
            self._log.info("本轮失败, %ss 后重试 (连续失败 %d)…", delay,
                           self.consecutive_failures)
            self.stop_event.wait(delay)  # 可被信号立即唤醒
        self._save_interrupted()
        self._log.warning("收到停止请求, 已安全退出 (未获得有效读数)")
        return EXIT_INTERRUPTED

    def _round_failed_backoff(self):
        self.consecutive_failures += 1
        delay = self.backoff.delay(self.consecutive_failures)
        self._log.info("%ss 后重试 (连续失败 %d)…", delay, self.consecutive_failures)
        self.stop_event.wait(delay)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="包租婆电表 BLE 无限重试读表 (YM00236K2A68)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--sn", default=DEFAULT_SN, help="设备 SN")
    p.add_argument("--mac", default=DEFAULT_MAC, help="设备 MAC")
    p.add_argument("--timeout", type=int, default=30, help="云端/设备响应超时(秒)")
    p.add_argument("--connect-timeout", type=float, default=15.0, help="BLE 连接超时(秒)")
    p.add_argument("--round-attempts", type=int, default=3,
                   help="每轮内 step1->写->通知->step5 的最大尝试次数")
    p.add_argument("--base-backoff", type=float, default=2.0, help="退避基数(秒)")
    p.add_argument("--max-backoff", type=float, default=60.0, help="退避上限(秒)")
    p.add_argument("--soft-reset-after", type=int, default=6,
                   help="连续失败多少次后执行适配器软恢复")
    p.add_argument("--max-rounds", type=int, default=0,
                   help="最多轮数, 0=无限 (默认)")
    p.add_argument("--backend", choices=["auto", "bleak", "gatttool"], default="auto",
                   help="BLE 后端")
    p.add_argument("--log-dir", default=str(state_dir() / "bzp-ble"), help="日志目录")
    p.add_argument("--result-file", default=None,
                   help="结果文件路径 (默认 <log-dir>/bzp_ble_read_result.json)")
    p.add_argument("--auth-file", default="~/.local/share/bzp-ble/auth.json",
                   help="包租婆业务登录态 JSON (权限必须为 0600)")
    p.add_argument("--platform", default="ios",
                   help="devCode 上报平台 (与小程序 fallback 一致)")
    p.add_argument("--brand", default="yunmu",
                   help="devCode 上报品牌 (与小程序 fallback 一致)")
    p.add_argument("--skip-dep-check", action="store_true", help="跳过依赖检查 (仅测试)")
    p.add_argument("--verbose", action="store_true", help="DEBUG 日志")
    return p.parse_args(argv)


def main(argv=None) -> int:
    opts = parse_args(argv)
    log = make_logger(opts.log_dir, opts.verbose)
    if not opts.result_file:
        opts.result_file = os.path.join(opts.log_dir, "bzp_ble_read_result.json")

    checks = check_dependencies(backend_kind=opts.backend)
    for name, ok, hint in checks:
        log.info("依赖 %-8s %s %s", name, "OK" if ok else "缺失", "" if ok else hint)
    if not opts.skip_dep_check:
        try:
            assert_dependencies(checks)
        except DependencyError as e:
            log.error("%s", redact(str(e)))
            return EXIT_FATAL
    else:
        log.warning("已跳过依赖检查 (--skip-dep-check)")

    try:
        backend = make_backend(opts.backend, log=log)
    except DependencyError as e:
        log.error("%s", redact(str(e)))
        return EXIT_FATAL

    cloud = BusinessCloudClient(USER, PASSWD, auth_file=opts.auth_file,
                                mac=opts.mac, platform=opts.platform,
                                brand=opts.brand, log=log)
    engine = BleReadRetryEngine(opts.sn, opts.mac, backend, cloud, opts, log=log)
    code = EXIT_FATAL
    try:
        code = engine.run()
    except Exception as e:
        log.exception("未预期错误: %s", redact(str(e)))
    finally:
        try:
            cloud.close()
        except Exception:
            pass
        try:
            backend.close()
        except Exception:
            pass
        log.info("进程退出, exit=%d", code)
    return code


if __name__ == "__main__":
    sys.exit(main())
