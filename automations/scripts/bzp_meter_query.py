#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bzp_meter_query.py — 包租婆水电表查询脚本

查询包租婆(iyunmu)智能电表/水表的剩余量, 输出适合微信投递的文本。
API 匿名可用, 只需设备 SN。

用法:
  python3 bzp_meter_query.py                 # 查配置文件里的全部设备
  python3 bzp_meter_query.py --sn YM00236K2A68   # 查单个 SN
  python3 bzp_meter_query.py --json          # JSON 输出(供其他脚本消费)

配置: 修改下方 DEVICES 列表或使用 BZP_DEVICES 环境变量(JSON)。
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

API_BASE = os.environ.get("BZP_API_BASE", "https://bzp.iyunmu.com/bzp_backup")
TIMEOUT = 15

# 默认设备表: name 显示名, sn 设备号, type 类型(电表/水表), warn 低余量阈值
DEVICES = [
    {"name": "兰村大厦10E-B 电表", "sn": "YM00236K2A68", "type": "电表", "warn": 10.0},
    {"name": "兰村大厦10E/B 水表", "sn": "YM00234J0667", "type": "水表", "warn": 5.0},
]

# 设备查询接口(水表也是同一个接口, 响应里 product 区分 电表/水表)
API_DEVICE_INFO = "/v1/client/client_device_info/"


def load_devices():
    env = os.environ.get("BZP_DEVICES")
    if env:
        return json.loads(env)
    return DEVICES


def query_device(sn):
    """查询单个设备, 返回解析后的 dict。"""
    url = API_BASE + API_DEVICE_INFO
    body = json.dumps({"sn": sn}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return {"ok": False, "sn": sn, "error": f"HTTP {e.code}"}
    except Exception as e:
        return {"ok": False, "sn": sn, "error": str(e)}

    try:
        data = json.loads(raw)
    except Exception:
        return {"ok": False, "sn": sn, "error": "响应解析失败"}

    if data.get("code") != 200 or not data.get("data"):
        return {"ok": False, "sn": sn, "error": data.get("msg", "查询失败")}

    d = data["data"]
    return {
        "ok": True,
        "sn": sn,
        "name": d.get("name") or "",
        "product": d.get("product") or "",
        "surplus": d.get("surplusValue"),
        "total": d.get("totalValue"),
        "unit_price": d.get("unitPrice") or d.get("basisPrice"),
        "read_time": d.get("read_time") or "",
        "switch_status": d.get("switchStatus"),
        "dev_type": d.get("dev_name_format") or d.get("dev_type") or "",
        "payee": d.get("payee") or "",
        "pay_limit": d.get("pay_limit"),
    }


def fmt_surplus(v):
    """剩余量格式化: 电表是度, 水表可能是 m³; 接口统一用 surplusValue。"""
    if v is None:
        return "?"
    return f"{v:g}"


def render(devices, json_out=False):
    results = []
    for dev in devices:
        r = query_device(dev["sn"])
        r["cfg"] = dev
        results.append(r)

    if json_out:
        return json.dumps(results, ensure_ascii=False, indent=1)

    lines = []
    warns = []
    for r in results:
        if not r["ok"]:
            lines.append(f"❌ {r['cfg']['name']}({r['sn']}): 查询失败 - {r['error']}")
            continue
        d = r
        unit = "度" if (d["product"] == "电表" or d["cfg"]["type"] == "电表") else "m³"
        status = "✅ 通电" if d["switch_status"] == 1 else ("⛔ 断电" if d["switch_status"] == 0 else "?")
        lines.append(
            f"⚡ **{d['name']}** [{d['product']}] {status}\n"
            f"- 剩余: **{fmt_surplus(d['surplus'])} {unit}**\n"
            f"- 总用量: {fmt_surplus(d['total'])} {unit} | 单价: {d['unit_price']} 元\n"
            f"- 抄表时间: {d['read_time']} | 收款: {d['payee']}"
        )
        # 低余量预警
        warn_th = d["cfg"].get("warn")
        if warn_th and d["surplus"] is not None and d["surplus"] <= warn_th:
            warns.append(f"⚠️ {d['name']} 剩余 {fmt_surplus(d['surplus'])} {unit} < 阈值 {warn_th:g} {unit}")

    text = "\n\n".join(lines)
    if warns:
        text += "\n\n" + "\n".join(warns)
    return text


def main():
    args = sys.argv[1:]
    json_out = "--json" in args
    if "--sn" in args:
        i = args.index("--sn")
        sn = args[i + 1]
        devices = [{"name": sn, "sn": sn, "type": "电表", "warn": None}]
    else:
        devices = load_devices()
    text = render(devices, json_out)
    print(text)


if __name__ == "__main__":
    main()
