#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""微信个人号桥：把 WeChatFerry(wcferry) 包成本机 HTTP 服务，只给 dsh-im-bridge 用。

为什么要有这一层：Node 侧绝不 import wcferry（它要 Windows 上的微信客户端 + 它自己的
DLL 注入），于是把"能碰微信"的全部代码收在这一个 Python 文件里，Node 只发 HTTP。

三个接口：
  GET  /status            这台桥和微信现在是什么状态
  POST /send              {to, text} → 发一条私聊文本
  GET  /events?since=N    增量拉取私聊文本消息（seq 单调递增）

只做私聊文本：群聊、图片、语音、卡片消息这一版一律不进缓冲区（说清楚比默默丢弃好）。

启动：  python tools/wcf-bridge/bridge.py
端口：  环境变量 WCF_BRIDGE_PORT，默认 19100，只监听 127.0.0.1（绝不对外开）
环境：  Windows + 官方微信 3.9.12.17（WeChatFerry guide 指定版本）+ pip install wcferry

没有 wcferry、微信没登录、注入失败时进程都不退出：/status 回 loggedIn:false + 一句人话，
原因写在日志里。一个"启动就崩"的脚本只会让用户在终端里看见堆栈。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Empty
from urllib.parse import parse_qs, urlparse

BRIDGE_HOST = "127.0.0.1"
DEFAULT_PORT = 19100
# 环形缓冲上限：Node 侧按 since 追增量，落后太多说明它已经放弃了，旧消息没有再补的价值
MAX_EVENTS = 500
# 心跳：终端安静 30 秒就无法判断"没人说话"还是"卡死了"，这两件事的处置完全不同
HEARTBEAT_SECONDS = 30
# wcferry.get_msg 在空队列上会立刻抛 Empty，不睡就是纯空转烧一个核
IDLE_SLEEP_SECONDS = 0.2
# WeChatFerry 只适配这个版本；装错版本的表现是"日志里什么都没有"或注入失败，先说清楚
WECHAT_VERSION = "3.9.12.17"
MSG_TYPE_TEXT = 1
MAX_BODY_BYTES = 64 * 1024


def log(message):
    sys.stdout.write("[" + time.strftime("%Y-%m-%d %H:%M:%S") + "] " + message + "\n")
    sys.stdout.flush()


class BridgeState(object):
    """进程内唯一的状态：微信连接 + 消息环形缓冲。所有字段都由锁保护。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.events = deque(maxlen=MAX_EVENTS)
        self.seq = 0
        self.received = 0
        self.ready = False
        self.logged_in = False
        self.self_wxid = ""
        self.nickname = ""
        self.error = "正在连接微信客户端…"
        self.wcf = None

    def set_error(self, text):
        with self.lock:
            self.error = text

    def attach(self, wcf, self_wxid, nickname):
        with self.lock:
            self.wcf = wcf
            self.ready = True
            self.logged_in = True
            self.self_wxid = self_wxid
            self.nickname = nickname
            self.error = ""

    def status(self):
        """ok 只表示"桥还活着"：微信没登录是 loggedIn:false + error，不是桥坏了。"""
        with self.lock:
            payload = {
                "ok": True,
                "loggedIn": bool(self.logged_in),
                "selfWxid": self.self_wxid,
                "nickname": self.nickname,
                "received": self.received,
                "buffered": len(self.events),
            }
            if not self.logged_in:
                payload["error"] = self.error or "微信还没登录：先在微信客户端扫码登录"
            return payload

    def push(self, event):
        with self.lock:
            self.seq += 1
            self.received += 1
            item = {"seq": self.seq}
            item.update(event)
            self.events.append(item)
            return item

    def events_since(self, since):
        with self.lock:
            next_seq = self.seq
            items = [dict(item) for item in self.events if item["seq"] > since]
        return {"ok": True, "events": items, "next": next_seq}

    def send(self, to, text):
        with self.lock:
            wcf = self.wcf
            logged_in = self.logged_in
            error = self.error
        if not logged_in or wcf is None:
            return {"ok": False, "error": "微信还没登录：" + (error or "先在微信客户端扫码登录")}
        try:
            # 锁外发送：send_text 要走注入的客户端，占着锁会让 /status 跟着一起卡
            response = wcf.send_text(text, to)
        except Exception as exc:  # noqa: BLE001 - 任何异常都要变成人话，不能让 HTTP 层 500
            return {"ok": False, "error": "发送失败：" + str(exc)}
        # wcferry 的返回形态随版本变（None / {'status': 0}）：只认"明确非 0 的失败码"，
        # 把 None 当失败会让正常发送变成一条假错误
        if isinstance(response, dict):
            status = response.get("status", 0)
            if status not in (0, None):
                return {"ok": False, "error": "微信拒绝了这次发送（status=" + str(status) + "）：对方可能不是好友，或触发了风控"}
        return {"ok": True}


def _attr(obj, *names):
    for name in names:
        value = getattr(obj, name, None)
        if value not in (None, ""):
            return value
    return None


def _ts_ms(msg):
    """消息时间统一成毫秒时间戳。wcferry 各版本给的形态不一（秒、毫秒、日期串），挨个试。"""
    raw = _attr(msg, "ts", "time", "create_time", "createTime")
    if isinstance(raw, (int, float)):
        value = float(raw)
        if value > 1e11:
            return int(value)
        if value > 1e8:
            return int(value * 1000)
    if isinstance(raw, str) and raw.strip() != "":
        text = raw.strip()
        if text.isdigit():
            value = float(text)
            return int(value) if value > 1e11 else int(value * 1000)
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
            try:
                return int(time.mktime(time.strptime(text, fmt)) * 1000)
            except ValueError:
                continue
    return int(time.time() * 1000)


def message_event(msg):
    """WxMsg → {ts, from, text, type}；不是私聊文本就返回 None（这一版只做私聊）。"""
    if int(_attr(msg, "type") or -1) != MSG_TYPE_TEXT:
        return None
    room = str(_attr(msg, "roomid", "room_id") or "")
    if room != "":
        return None
    sender = str(_attr(msg, "sender", "from") or "")
    if sender == "":
        return None
    text = str(_attr(msg, "content", "text") or "")
    if text == "":
        return None
    return {"ts": _ts_ms(msg), "from": sender, "text": text, "type": "text"}


def _self_wxid_of(wcf):
    try:
        return str(wcf.get_self_wxid() or "")
    except Exception:  # noqa: BLE001 - 拿不到就留空，Node 侧只当"自己发的消息认不出来"
        return ""


def _nickname_of(wcf):
    try:
        info = wcf.get_user_info() or {}
    except Exception:  # noqa: BLE001
        return ""
    if isinstance(info, dict):
        for key in ("name", "nickname", "nickName", "wxid"):
            value = info.get(key)
            if value:
                return str(value)
    return ""


def worker_loop(state, stop_event):
    """收消息线程：连不上就写清楚原因然后安静退出，HTTP 服务照常响应。"""
    try:
        from wcferry import Wcf
    except Exception as exc:  # noqa: BLE001
        state.set_error("没有找到 wcferry 这个 Python 包（" + str(exc) + "）：先 pip install wcferry 再启动本脚本")
        log(state.error)
        return

    try:
        wcf = Wcf(debug=False)
        wcf.enable_receiving_msg()
    except Exception as exc:  # noqa: BLE001
        state.set_error("连不上微信（需要微信 " + WECHAT_VERSION + " 已登录并开着）：" + str(exc))
        log(state.error)
        return

    state.attach(wcf, _self_wxid_of(wcf), _nickname_of(wcf))
    log("已连上微信：selfWxid=" + (state.self_wxid or "?") + " nickname=" + (state.nickname or "?"))

    while not stop_event.is_set():
        try:
            msg = wcf.get_msg()
        except Empty:
            time.sleep(IDLE_SLEEP_SECONDS)
            continue
        except Exception as exc:  # noqa: BLE001
            state.set_error("收消息时出错：" + str(exc))
            log(state.error)
            time.sleep(1)
            continue
        if msg is None:
            time.sleep(IDLE_SLEEP_SECONDS)
            continue
        event = message_event(msg)
        if event is None:
            continue
        item = state.push(event)
        log("收到私聊 seq=" + str(item["seq"]) + " from=" + item["from"] + " 字数=" + str(len(item["text"])))


def heartbeat_loop(state, stop_event):
    while not stop_event.wait(HEARTBEAT_SECONDS):
        payload = state.status()
        log(
            "心跳：loggedIn=" + str(payload["loggedIn"]).lower()
            + " 已收 " + str(payload["received"]) + " 条"
            + " 缓冲 " + str(payload["buffered"]) + "/" + str(MAX_EVENTS)
            + (" 问题=" + payload["error"] if "error" in payload else "")
        )


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "wcf-bridge/1.0"
    protocol_version = "HTTP/1.1"
    state = None

    def log_message(self, fmt, *args):  # noqa: A003
        # 默认实现把每条请求写到 stderr：1 秒一次的轮询会把它变成一堵墙
        return

    def _send_json(self, payload, code=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _path(self):
        return urlparse(self.path)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 的命名约定
        url = self._path()
        if url.path == "/status":
            return self._send_json(self.state.status())
        if url.path == "/events":
            since = 0
            raw = parse_qs(url.query).get("since", ["0"])[0]
            try:
                since = int(raw)
            except (TypeError, ValueError):
                since = 0
            return self._send_json(self.state.events_since(max(0, since)))
        return self._send_json({"ok": False, "error": "没有这个接口：" + url.path}, 404)

    def do_POST(self):  # noqa: N802
        url = self._path()
        if url.path != "/send":
            return self._send_json({"ok": False, "error": "没有这个接口：" + url.path}, 404)
        try:
            length = int(self.headers.get("content-length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._send_json({"ok": False, "error": "请求体为空或过大（上限 64KB）"})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"ok": False, "error": "请求体不是合法 JSON：" + str(exc)})
        if not isinstance(body, dict):
            return self._send_json({"ok": False, "error": "请求体必须是 {to, text} 这样的对象"})
        to = body.get("to")
        text = body.get("text")
        if not isinstance(to, str) or to.strip() == "":
            return self._send_json({"ok": False, "error": "to 必须是非空的 wxid 字符串"})
        if not isinstance(text, str) or text == "":
            return self._send_json({"ok": False, "error": "text 必须是非空字符串"})
        return self._send_json(self.state.send(to.strip(), text))


def port_of(env):
    raw = str(env.get("WCF_BRIDGE_PORT", "") or "").strip()
    if raw == "":
        return DEFAULT_PORT
    try:
        port = int(raw)
    except ValueError:
        log("WCF_BRIDGE_PORT 不是数字（" + raw + "），改用默认 " + str(DEFAULT_PORT))
        return DEFAULT_PORT
    if port < 1 or port > 65535:
        log("WCF_BRIDGE_PORT 超出 1~65535（" + raw + "），改用默认 " + str(DEFAULT_PORT))
        return DEFAULT_PORT
    return port


def main():
    port = port_of(os.environ)
    state = BridgeState()
    stop_event = threading.Event()
    threading.Thread(target=worker_loop, args=(state, stop_event), name="wcf-worker", daemon=True).start()
    threading.Thread(target=heartbeat_loop, args=(state, stop_event), name="wcf-heartbeat", daemon=True).start()

    handler = type("BoundBridgeHandler", (BridgeHandler,), {"state": state})
    try:
        server = ThreadingHTTPServer((BRIDGE_HOST, port), handler)
    except OSError as exc:
        # 端口被占是唯一"必须退出"的情况：再往下跑也接不到任何请求
        log("端口 " + str(port) + " 起不来（" + str(exc) + "）：可能已经有一个桥在跑，或换 WCF_BRIDGE_PORT 再试")
        return 1
    server.daemon_threads = True
    log("微信桥已监听 http://" + BRIDGE_HOST + ":" + str(port) + "（只接受本机访问，Ctrl+C 退出）")
    log("要求的微信版本：" + WECHAT_VERSION + "；扫码登录在微信客户端里完成，不在这个脚本里")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("收到 Ctrl+C，正在退出")
    finally:
        stop_event.set()
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
