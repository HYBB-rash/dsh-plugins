#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_bzp_ble_read_until_success.py — 重试引擎单元测试 (temp/mocked BLE + mocked 云端)

覆盖: 有界抖动退避 / 校验 / payload 构造 / MQTT 事件路由 / 无限重试不退出 /
软恢复触发 / 信号安全停止 / 云端临时失败重试 / 依赖检查 / 结果落盘 / 日志脱敏。

全部使用假 BLE 后端与假云端, 不触碰真实蓝牙硬件、cron 或系统配置;
不发起任何真实网络请求。纯 stdlib (unittest), 无需 paho/bleak/pytest。
"""
import importlib.util
import json
import logging
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bzp_ble_read_until_success as m  # noqa: E402

SERVICE = m.SERVICE_UUID
WRITE = m.WRITE_UUID
NOTIFY = m.NOTIFY_UUID


def silent_logger():
    lg = logging.getLogger("test_bzp_ble_%d" % id(object()))
    lg.setLevel(logging.CRITICAL)
    lg.propagate = False
    lg.addHandler(logging.NullHandler())
    return lg


class FakeBackend(m.BleBackendBase):
    name = "fake"

    def __init__(self, fail_connects=0, notify_bytes=b"\x11\x22\x33\x44"):
        self.fail_connects = fail_connects
        self.notify_bytes = notify_bytes
        self.connect_calls = 0
        self.disconnect_calls = 0
        self.writes = []
        self.soft_recovers = 0
        self.closed = False
        self.notified = False

    def open(self):
        pass

    def connect(self, mac, timeout):
        self.connect_calls += 1
        if self.connect_calls <= self.fail_connects:
            raise m.BleError("fake connect fail #%d" % self.connect_calls)

    def discover(self):
        return SERVICE, WRITE, NOTIFY

    def start_notify(self, notify_uuid):
        self.notified = True

    def write(self, write_uuid, data):
        self.writes.append(bytes(data))

    def wait_notification(self, timeout, stop_event=None):
        return self.notify_bytes

    def disconnect(self):
        self.disconnect_calls += 1

    def soft_recover(self):
        self.soft_recovers += 1

    def close(self):
        self.closed = True


class FakeCloud:
    """云端假件: step:1 返回测试用写缓冲 (真实字节由云端运行时生成, 此处仅作管道测试)。"""

    def __init__(self, init_fails=0, step1_fails=0, step5_fails=0, invalid_first=0,
                 reading=None):
        self.init_fails = init_fails
        self.step1_fails = step1_fails
        self.step5_fails = step5_fails
        self.invalid_first = invalid_first
        self.reading = reading if reading is not None else \
            {"total": 1234.5, "surplus": 88.0, "switchState": 1}
        self.init_calls = 0
        self.step1_calls = 0
        self.step5_calls = 0
        self.responses = []
        self.closed = False

    def init(self, stop_event=None):
        self.init_calls += 1
        if self.init_calls <= self.init_fails:
            raise m.CloudError(code=500, msg="fake init boom")

    def meter_ble_read_step1(self, sn, timeout, stop_event=None):
        self.step1_calls += 1
        if self.step1_calls <= self.step1_fails:
            raise m.CloudError(code=500, msg="fake step1 boom")
        return b"\x01\x02\x03\x04"

    def meter_ble_read_step5(self, sn, resp, timeout, stop_event=None):
        self.step5_calls += 1
        self.responses.append(bytes(resp))
        if self.step5_calls <= self.step5_fails:
            raise m.CloudError(code=500, msg="fake step5 boom")
        if self.step5_calls <= self.invalid_first:
            return {"total": None, "surplus": 1.0, "switchState": 0}
        return dict(self.reading)

    def close(self):
        self.closed = True


class Opts:
    pass


def make_opts(**kw):
    o = Opts()
    o.timeout = 2
    o.connect_timeout = 2
    o.round_attempts = 3
    o.base_backoff = 0.01
    o.max_backoff = 0.05
    o.soft_reset_after = 6
    o.max_rounds = 0
    o.result_file = None
    for k, v in kw.items():
        setattr(o, k, v)
    return o


class TestBackoff(unittest.TestCase):
    def test_bounded_and_jittered(self):
        b = m.Backoff(base=2.0, cap=8.0)
        for i in range(1, 30):
            d = b.delay(i)
            self.assertGreaterEqual(d, 0.0)
            # 上限: 抖动 ±20% -> 最大 cap*1.2
            self.assertLessEqual(d, 8.0 * 1.2 + 1e-9)
        # 封顶后应接近 cap
        capped = [b.delay(i) for i in range(15, 25)]
        self.assertTrue(all(d >= 8.0 * 0.8 for d in capped))
        # 早期单调不超 cap
        self.assertLessEqual(b.delay(1), 2.0 * 1.2 + 1e-9)

    def test_zero_base(self):
        b = m.Backoff(base=0.0, cap=1.0)
        self.assertEqual(b.delay(5), 0.0)


class TestValidateReading(unittest.TestCase):
    def test_valid(self):
        self.assertTrue(m.validate_reading({"total": 1234.5, "surplus": 88.0,
                                            "switchState": 1}))
        self.assertTrue(m.validate_reading({"total": 0, "surplus": -5.0,
                                            "switchState": 0}))
        self.assertTrue(m.validate_reading({"total": "1234", "surplus": "88",
                                            "switchState": True}))
        self.assertTrue(m.validate_reading({"total": 1, "surplus": 1,
                                            "switchState": False}))

    def test_invalid(self):
        bad = [
            {"total": None, "surplus": 1.0, "switchState": 0},
            {"surplus": 1.0, "switchState": 0},
            {"total": 1.0, "surplus": 1.0, "switchState": 2},
            {"total": "abc", "surplus": 1.0, "switchState": 0},
            {"total": -1.0, "surplus": 1.0, "switchState": 0},
            {"total": float("nan"), "surplus": 1.0, "switchState": 0},
            {"total": float("inf"), "surplus": 1.0, "switchState": 0},
            {"total": 1.0, "surplus": 1.0, "switchState": None},
        ]
        for r in bad:
            self.assertFalse(m.validate_reading(r), r)


class TestCloudPayload(unittest.TestCase):
    def setUp(self):
        self.cl = m.CloudClient("u", "p")

    def test_step1_payload(self):
        d = self.cl.build_request_data({"step": 1}, 30, "cid-123")
        self.assertEqual(d, {"step": 1, "timeout": 30, "client_id": "cid-123"})

    def test_step5_payload(self):
        d = self.cl.build_request_data({"step": 5, "code": [1, 2, 3]}, 30, "cid")
        self.assertEqual(d["step"], 5)
        self.assertEqual(d["code"], [1, 2, 3])
        self.assertEqual(d["timeout"], 30)
        self.assertEqual(d["client_id"], "cid")

    def test_sign_deterministic_and_sensitive(self):
        s1 = self.cl.sign_for_sn("YM00236K2A68", 1234567890)
        s2 = self.cl.sign_for_sn("YM00236K2A68", 1234567890)
        s3 = self.cl.sign_for_sn("YM00236K2A68", 1234567891)
        self.assertEqual(s1, s2)
        self.assertNotEqual(s1, s3)
        self.assertRegex(s1, r"^[0-9A-F]{64}$")

    def test_normalize_code(self):
        self.assertEqual(self.cl.normalize_code([104, 3, 1]), b"\x68\x03\x01")
        self.assertEqual(self.cl.normalize_code(b"\x68\x03"), b"\x68\x03")
        self.assertEqual(self.cl.normalize_code("680301"), b"\x68\x03\x01")
        self.assertEqual(self.cl.normalize_code("170,3,1"), b"\xaa\x03\x01")
        with self.assertRaises(m.CloudError):
            self.cl.normalize_code(None)
        with self.assertRaises(m.CloudError):
            self.cl.normalize_code("zzzz")


class TestMqttRouting(unittest.TestCase):
    def setUp(self):
        self.cl = m.CloudClient("u", "p")

    def _add_waiter(self, key):
        with self.cl._lock:
            self.cl._waiters[key] = {"event": threading.Event(), "payload": None}
        return self.cl._waiters[key]

    def test_route_sn_cmd(self):
        w = self._add_waiter("YM00236K2A68/meter_ble_read")
        self.cl._on_message(
            "device/YM00236K2A68/meter_ble_read/abc",
            b'{"code":200,"data":{"code":[1,2]}}')
        self.assertTrue(w["event"].is_set())
        self.assertEqual(w["payload"]["data"]["code"], [1, 2])

    def test_short_topic_ignored(self):
        w = self._add_waiter("A/B")
        self.cl._on_message("a/b", b"{}")
        self.assertFalse(w["event"].is_set())

    def test_bad_json_ignored(self):
        w = self._add_waiter("A/B")
        self.cl._on_message("x/A/B/y", b"not json")
        self.assertFalse(w["event"].is_set())


class _EngineTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bzp_ble_test_")
        self.log = silent_logger()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _run(self, backend, cloud, opts=None):
        opts = opts or make_opts(result_file=os.path.join(self.tmp, "result.json"))
        if not opts.result_file:
            opts.result_file = os.path.join(self.tmp, "result.json")
        eng = m.BleReadRetryEngine("YM00236K2A68", "23:06:20:00:2A:68",
                                   backend, cloud, opts, log=self.log)
        code = eng.run()
        return code, eng, opts


class TestEngineLoop(_EngineTestBase):
    def test_success_first_try(self):
        be, cl = FakeBackend(), FakeCloud()
        code, eng, opts = self._run(be, cl)
        self.assertEqual(code, m.EXIT_OK)
        self.assertEqual(eng.round_no, 1)
        self.assertGreaterEqual(be.disconnect_calls, 1)
        self.assertEqual(be.writes, [b"\x01\x02\x03\x04"])
        with open(opts.result_file, encoding="utf-8") as f:
            r = json.load(f)
        self.assertEqual(r["status"], "success")
        self.assertEqual(r["sn"], "YM00236K2A68")
        self.assertEqual(r["total"], 1234.5)
        self.assertEqual(r["surplus"], 88.0)
        self.assertEqual(r["switchState_bool"], True)

    def test_retries_until_success_never_exits_on_normal_failure(self):
        be, cl = FakeBackend(fail_connects=3), FakeCloud()
        code, eng, _ = self._run(be, cl)
        self.assertEqual(code, m.EXIT_OK)
        self.assertEqual(be.connect_calls, 4)
        self.assertEqual(eng.round_no, 4)
        self.assertEqual(eng.consecutive_failures, 0)

    def test_invalid_reading_retried_within_round(self):
        be, cl = FakeBackend(), FakeCloud(invalid_first=1)
        code, eng, _ = self._run(be, cl)
        self.assertEqual(code, m.EXIT_OK)
        self.assertEqual(eng.round_no, 1)
        self.assertEqual(cl.step5_calls, 2)

    def test_cloud_step1_failure_retried_within_round(self):
        be, cl = FakeBackend(), FakeCloud(step1_fails=2)
        code, eng, _ = self._run(be, cl)
        self.assertEqual(code, m.EXIT_OK)
        self.assertEqual(eng.round_no, 1)
        self.assertEqual(cl.step1_calls, 3)

    def test_cloud_init_failure_retried_not_fatal(self):
        be, cl = FakeBackend(), FakeCloud(init_fails=2)
        code, eng, _ = self._run(be, cl)
        self.assertEqual(code, m.EXIT_OK)
        self.assertEqual(cl.init_calls, 3)
        self.assertEqual(eng.round_no, 3)

    def test_soft_recover_after_stall(self):
        be, cl = FakeBackend(fail_connects=7), FakeCloud()
        opts = make_opts(soft_reset_after=6,
                         result_file=os.path.join(self.tmp, "result.json"))
        code, eng, _ = self._run(be, cl, opts=opts)
        self.assertEqual(code, m.EXIT_OK)
        self.assertEqual(be.soft_recovers, 1)
        self.assertEqual(be.connect_calls, 8)

    def test_soft_recover_resets_counter(self):
        be, cl = FakeBackend(fail_connects=13), FakeCloud()
        opts = make_opts(soft_reset_after=6,
                         result_file=os.path.join(self.tmp, "result.json"))
        code, eng, _ = self._run(be, cl, opts=opts)
        self.assertEqual(code, m.EXIT_OK)
        # 第6、12次失败后各软恢复一次
        self.assertEqual(be.soft_recovers, 2)
        self.assertEqual(be.connect_calls, 14)

    def test_signal_stop_is_clean(self):
        be, cl = FakeBackend(fail_connects=10 ** 6), FakeCloud()
        opts = make_opts(result_file=os.path.join(self.tmp, "result.json"))
        eng = m.BleReadRetryEngine("YM00236K2A68", "23:06:20:00:2A:68",
                                   be, cl, opts, log=self.log)
        result = {}

        def _t():
            result["code"] = eng.run()

        th = threading.Thread(target=_t, daemon=True)
        th.start()
        # 等待至少两轮真实失败后, 模拟 SIGINT/SIGTERM (与信号处理器同一入口)
        for _ in range(200):
            if be.connect_calls >= 2:
                break
            time.sleep(0.01)
        eng.request_stop()
        th.join(timeout=10)
        self.assertFalse(th.is_alive())
        self.assertEqual(result["code"], m.EXIT_INTERRUPTED)
        self.assertGreaterEqual(be.disconnect_calls, 1)
        with open(opts.result_file, encoding="utf-8") as f:
            r = json.load(f)
        self.assertEqual(r["status"], "interrupted")
        self.assertIn("note", r)

    def test_max_rounds(self):
        be, cl = FakeBackend(fail_connects=10 ** 6), FakeCloud()
        opts = make_opts(max_rounds=2, result_file=os.path.join(self.tmp, "result.json"))
        code, eng, _ = self._run(be, cl, opts=opts)
        self.assertEqual(code, m.EXIT_OK)
        self.assertEqual(eng.round_no, 2)
        with open(opts.result_file, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["status"], "max_rounds")

    def test_result_and_log_have_no_secrets(self):
        be, cl = FakeBackend(), FakeCloud()
        log_dir = os.path.join(self.tmp, "logs")
        opts = make_opts(log_dir=log_dir,
                         result_file=os.path.join(self.tmp, "result.json"))
        eng = m.BleReadRetryEngine("YM00236K2A68", "23:06:20:00:2A:68",
                                   be, cl, opts,
                                   log=m.make_logger(log_dir, verbose=False))
        self.assertEqual(eng.run(), m.EXIT_OK)
        for path in (opts.result_file, os.path.join(log_dir,
                                                    "bzp_ble_read_until_success.log")):
            with open(path, encoding="utf-8") as f:
                content = f.read()
            self.assertNotIn(m.PASSWD, content)
            self.assertNotIn("PSheb6wzhuBkbuQzBD8mNAPZVY", content)

    def test_round_attempts_exhausted_then_next_round(self):
        # step:1 永远失败 -> 每轮耗尽 round_attempts 后进入下一轮, 不退出
        be, cl = FakeBackend(), FakeCloud(step1_fails=10 ** 6)
        opts = make_opts(round_attempts=2, max_rounds=3,
                         result_file=os.path.join(self.tmp, "result.json"))
        code, eng, _ = self._run(be, cl, opts=opts)
        self.assertEqual(code, m.EXIT_OK)
        self.assertEqual(eng.round_no, 3)
        self.assertEqual(cl.step1_calls, 6)  # 3轮 x 每轮2次
        self.assertGreaterEqual(be.disconnect_calls, 3)


class TestDependencyCheck(unittest.TestCase):
    def test_missing_openssl_reported(self):
        def fake_which(name):
            return None  # 全部缺失

        def fake_find(name):
            return None

        checks = m.check_dependencies(backend_kind="auto",
                                      which=fake_which, find_spec=fake_find)
        with self.assertRaises(m.DependencyError) as ctx:
            m.assert_dependencies(checks)
        self.assertIn("openssl", str(ctx.exception))

    def test_all_present_ok(self):
        def fake_which(name):
            return "/usr/bin/" + name

        def fake_find(name):
            return object()

        checks = m.check_dependencies(backend_kind="bleak",
                                      which=fake_which, find_spec=fake_find)
        self.assertTrue(all(ok for _, ok, _ in checks))
        m.assert_dependencies(checks)  # 不应抛异常

    def test_engine_fatal_on_dependency_error(self):
        be = FakeBackend()

        class FatalBackend(FakeBackend):
            def open(self):
                raise m.DependencyError("BLE 适配器不可用")

        log = silent_logger()
        eng = m.BleReadRetryEngine("S", "00:00:00:00:00:00", FatalBackend(),
                                   FakeCloud(), make_opts(), log=log)
        self.assertEqual(eng.run(), m.EXIT_FATAL)


class TestBackendSelection(unittest.TestCase):
    def test_make_backend_unknown(self):
        with self.assertRaises(m.DependencyError):
            m.make_backend("nope", log=silent_logger())

    def test_auto_falls_back_to_gatttool_when_no_bleak(self):
        # 本机无 bleak 时 auto -> gatttool (若 gatttool 存在)
        if importlib.util.find_spec("bleak") is None and shutil.which("gatttool"):
            be = m.make_backend("auto", log=silent_logger())
            self.assertIsInstance(be, m.GatttoolBackend)


class TestBusinessCloudProtocol(unittest.TestCase):
    def test_decode_gateway_code(self):
        # JS: split every 3 hex chars -> reverse -> subtract txMsgId.
        original = bytes([0x01, 0x7F, 0xFE])
        tx = 7
        encoded = "".join("%03x" % (value + tx) for value in reversed(original))
        self.assertEqual(m.BusinessCloudClient._decode_gateway_code(encoded, tx), original)

    def test_response_sign_matches_formula(self):
        packet = bytes([0x11, 0x22, 0x33])
        got = m.BusinessCloudClient._response_sign(
            "access", packet, 1700000000, "YM00236K2A68")
        self.assertIsInstance(got, str)
        self.assertGreater(len(got), 40)
        self.assertEqual(got, m.BusinessCloudClient._response_sign(
            "access", packet, 1700000000, "YM00236K2A68"))


class _FakeGatewayClient(m.BusinessCloudClient):
    """覆写 _post/_gateway：全程无网络，只记录请求并返回固定响应。"""

    def __init__(self, mac="23:06:20:00:2A:68", platform="ios", brand="yunmu",
                 step1_response=None, step5_response=None):
        super().__init__("u", "p", auth_file="/nonexistent", mac=mac,
                         platform=platform, brand=brand, log=silent_logger())
        self._auth = {"X-CSRFToken": "t", "Cookie": "c", "userid": "u1",
                      "mapp-id": "m", "role-id": "r"}
        self.calls = []
        self.step1_response = step1_response if step1_response is not None \
            else {"txMsgId": 7, "code": "680301"}
        self.step5_response = step5_response

    def _post(self, url, body, headers):
        self.calls.append({"kind": "business", "url": url, "body": dict(body)})
        return {"code": 200, "data": {
            "cmdType": "meter_ble_read", "ver": 1, "params": {},
            "access_key": "ACCESS", "sign": "SIGN", "timeStamp": 1700000000,
            "forge_flag": False}}

    def _gateway(self, sn, payload):
        self.calls.append({"kind": "gateway", "sn": sn, "payload": dict(payload)})
        if payload.get("isRes") == 0:
            return dict(self.step1_response)
        return dict(self.step5_response or {})


class TestBleCalcDevCode(unittest.TestCase):
    MAC = "23:06:20:00:2A:68"

    @staticmethod
    def _expected(platform, brand):
        return (bytes([0, 0, len(platform.encode())]) + platform.encode()
                + bytes([len(brand.encode())]) + brand.encode())

    def test_roundtrip_recovers_platform_brand(self):
        code = m.ym_ble_calc_dev_code(self.MAC, "ios", "yunmu",
                                      randbytes=bytes(range(10)))
        self.assertEqual(m.ym_ble_decode_dev_code(self.MAC, code),
                         self._expected("ios", "yunmu"))

    def test_output_length_26(self):
        code = m.ym_ble_calc_dev_code(self.MAC, "ios", "yunmu",
                                      randbytes=bytes(range(10)))
        self.assertEqual(len(code), 26)

    def test_deterministic_with_same_rand(self):
        rand = bytes(range(10))
        self.assertEqual(
            m.ym_ble_calc_dev_code(self.MAC, "ios", "yunmu", randbytes=rand),
            m.ym_ble_calc_dev_code(self.MAC, "ios", "yunmu", randbytes=rand))

    def test_differs_with_rand_or_mac(self):
        r1, r2 = bytes(range(10)), bytes(range(10, 20))
        self.assertNotEqual(
            m.ym_ble_calc_dev_code(self.MAC, "ios", "yunmu", randbytes=r1),
            m.ym_ble_calc_dev_code(self.MAC, "ios", "yunmu", randbytes=r2))
        self.assertNotEqual(
            m.ym_ble_calc_dev_code(self.MAC, "ios", "yunmu", randbytes=r1),
            m.ym_ble_calc_dev_code("12:34:56:78:9A:BC", "ios", "yunmu",
                                   randbytes=r1))

    def test_random_when_no_randbytes(self):
        first = m.ym_ble_calc_dev_code(self.MAC, "ios", "yunmu")
        second = m.ym_ble_calc_dev_code(self.MAC, "ios", "yunmu")
        self.assertNotEqual(first, second)
        for code in (first, second):
            self.assertEqual(m.ym_ble_decode_dev_code(self.MAC, code),
                             self._expected("ios", "yunmu"))

    def test_invalid_mac_raises(self):
        with self.assertRaises(ValueError):
            m.ym_ble_calc_dev_code("not-a-mac", "ios", "yunmu",
                                   randbytes=bytes(range(10)))


class TestBusinessCloudResponseMapping(unittest.TestCase):
    def _client(self, step5_response=None):
        return _FakeGatewayClient(step5_response=step5_response)

    def test_step5_maps_current_response_fields(self):
        client = self._client({
            "total_value": 1234.5, "surplus_value": 88.0,
            "switch_status": 1, "elec_rate": 0.52,
            "read_time": "2026-08-13 20:00:00"})
        client.meter_ble_read_step1("YM00236K2A68", 30)
        reading = client.meter_ble_read_step5("YM00236K2A68", b"\xaa" * 20, 30)
        self.assertEqual(reading["total"], 1234.5)
        self.assertEqual(reading["surplus"], 88.0)
        self.assertEqual(reading["switchState"], 1)
        self.assertEqual(reading["elec_rate"], 0.52)
        self.assertEqual(reading["read_time"], "2026-08-13 20:00:00")
        self.assertTrue(m.validate_reading(reading))

    def test_step5_legacy_field_fallback(self):
        client = self._client({"total": 10.0, "surplus": 2.0, "switchState": 0})
        client.meter_ble_read_step1("SN", 30)
        self.assertEqual(
            client.meter_ble_read_step5("SN", b"\xbb" * 20, 30),
            {"total": 10.0, "surplus": 2.0, "switchState": 0})

    def test_switch_status_bool_ok(self):
        client = self._client({"total_value": 1, "surplus_value": 1,
                               "switch_status": True})
        client.meter_ble_read_step1("SN", 30)
        self.assertTrue(m.validate_reading(
            client.meter_ble_read_step5("SN", b"\xcc" * 20, 30)))

    def test_missing_fields_map_to_none(self):
        client = self._client({})
        client.meter_ble_read_step1("SN", 30)
        self.assertFalse(m.validate_reading(
            client.meter_ble_read_step5("SN", b"\xdd" * 20, 30)))


class TestBusinessCloudRequestContract(unittest.TestCase):
    MAC = "23:06:20:00:2A:68"

    def _client(self, step5_response=None):
        return _FakeGatewayClient(mac=self.MAC, step5_response=step5_response)

    def test_step1_isres0_contract(self):
        client = self._client()
        self.assertIsInstance(client.meter_ble_read_step1("YM00236K2A68", 30), bytes)
        payload = [c for c in client.calls if c["kind"] == "gateway"][0]["payload"]
        self.assertEqual(payload["isRes"], 0)
        self.assertEqual(payload["sn"], "YM00236K2A68")
        self.assertIs(payload["test"], False)
        self.assertIs(payload["noCheck"], False)
        self.assertEqual(payload["macList"], [self.MAC])
        self.assertEqual(len(payload["devCode"]), 26)
        self.assertEqual(
            m.ym_ble_decode_dev_code(self.MAC, payload["devCode"]),
            bytes([0, 0, 3]) + b"ios" + bytes([5]) + b"yunmu")

    def test_step5_isres1_contract(self):
        client = self._client({"total_value": 1.0, "surplus_value": 1.0,
                               "switch_status": 1})
        client.meter_ble_read_step1("YM00236K2A68", 30)
        step1 = [c for c in client.calls if c["kind"] == "gateway"][0]["payload"]
        response = bytes(range(20))
        reading = client.meter_ble_read_step5("YM00236K2A68", response, 30)
        step5 = [c for c in client.calls if c["kind"] == "gateway"][1]["payload"]
        self.assertEqual(step5["isRes"], 1)
        self.assertEqual(step5["pkt"], list(response))
        self.assertEqual(step5["txMsgId"], 7)
        self.assertEqual(step5["devCode"], step1["devCode"])
        self.assertEqual(step5["macList"], step1["macList"])
        self.assertEqual(reading,
                         {"total": 1.0, "surplus": 1.0, "switchState": 1})

    def test_no_mac_keeps_legacy_empty_lists(self):
        client = _FakeGatewayClient(mac=None)
        client.meter_ble_read_step1("YM00236K2A68", 30)
        payload = [c for c in client.calls if c["kind"] == "gateway"][0]["payload"]
        self.assertEqual(payload["devCode"], [])
        self.assertEqual(payload["macList"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
