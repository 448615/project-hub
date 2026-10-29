# -*- coding: utf-8 -*-
"""server — 受限并发 HTTP 服务（替代裸 ThreadingHTTPServer）

P0-2 修复：``http.server.ThreadingHTTPServer`` 每来一个连接就开一条线程，且没有上限、
连接 socket 也不设超时。在公网部署下，慢客户端、慢上游（/browse 代理、/apps 反代）或
半开连接会把工作线程一条条占满，最终所有请求都拿不到线程 → 服务无响应（但进程还活着，
健康检查可能仍然“活着”）。

本类做三件事：
  1. **并发封顶**：用 ``BoundedSemaphore`` 限制同时在跑的请求线程数（默认 64，
     ``HUB_MAX_WORKERS`` 可调）。超过上限的连接在信号量上排队，而非无限开线程；
     且限定时间内拿不到名额就直接关连接，避免请求无限堆积。
  2. **连接超时**：``get_request`` 给每个接受的 socket 设收发超时（默认 30s，
     ``HUB_REQUEST_TIMEOUT`` 可调）。慢客户端/慢上游无法再把线程永久挂起。
  3. **守护线程**：``daemon_threads=True``，进程退出时不残留工作线程。
"""
from __future__ import annotations

import os
import socketserver
import threading
from http.server import ThreadingHTTPServer


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    try:
        v = float(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # 并发线程上限：1..1024 之间，防止一个坏配置把系统拖垮
        self.max_workers = _env_int("HUB_MAX_WORKERS", 64, 1, 1024)
        # 单连接收发超时（秒）：1..600 之间
        self.request_timeout = _env_float("HUB_REQUEST_TIMEOUT", 30.0, 1.0, 600.0)
        self._sem = threading.BoundedSemaphore(self.max_workers)

    def get_request(self):
        # 给每个新接受的连接设置收发超时，避免慢客户端/慢上游永久挂起处理线程
        conn, addr = super().get_request()
        try:
            conn.settimeout(self.request_timeout)
        except Exception:  # noqa: BLE001  settimeout 失败不应影响建连
            pass
        return conn, addr

    def process_request(self, request, client_address):
        # 用信号量限制并发处理线程数：拿不到名额就直接丢弃该连接，而非无限堆积
        if not self._sem.acquire(timeout=self.request_timeout):
            try:
                request.close()
            except Exception:  # noqa: BLE001
                pass
            return

        def _runner():
            try:
                # 复用 ThreadingMixIn 默认实现：finish_request -> shutdown_request
                self.process_request_thread(request, client_address)
            finally:
                self._sem.release()

        t = threading.Thread(target=_runner, daemon=self.daemon_threads)
        t.start()

    def server_bind(self):
        # 端口处于 TIME_WAIT 时允许立即重绑，避免重启报“地址已在使用”
        self.allow_reuse_address = True
        super().server_bind()
