#!/usr/bin/env python3
"""测试替身：一个只实现「各 Mixin 依赖到的成员」的最小 handler。

为什么不直接起真服务：这些测试要断言的正是鉴权闸门、路径校验、回收站清单这类
**请求边界**行为，用真 socket 反而把断言埋在 HTTP 细节里。这里模拟到
send_response / send_header / wfile.write 这一层就够，跑起来是毫秒级。

约定：
* ``FakeHub(cookie=...)`` 模拟带会话 Cookie 的请求；
* ``FakeHub(body={...})`` 模拟 JSON 请求体（自动补 Content-Length，走 _read_body）；
* 断言用 ``.status`` / ``.json`` / ``.header("name")``。
"""
from __future__ import annotations

import io
import json

from hub.handlers.base import BaseMixin
from hub.handlers.project_ops import ProjectOpsMixin
from hub.handlers.files_api import FilesMixin
from hub.handlers.files_write import FilesWriteMixin
from hub.handlers.auth_post import AuthPostMixin


class FakeHub(BaseMixin, ProjectOpsMixin, FilesMixin, FilesWriteMixin, AuthPostMixin):
    # 类属性兜底：被请求的方法可能直接读 self.root / self.cloud
    root = "."
    config = {}
    cloud = False
    admins = set()

    def __init__(self, *, root=None, config=None, cookie="", body=None,
                 req_headers=None, client=("127.0.0.1", 50000)):
        self.headers = dict(req_headers or {})
        if cookie:
            self.headers["Cookie"] = cookie
        payload = b"" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        if payload:
            self.headers["Content-Length"] = str(len(payload))
        self.rfile = io.BytesIO(payload)
        self.wfile = self
        self.client_address = client
        self.root = root or FakeHub.root
        self.config = {} if config is None else config
        self.cloud = False
        self.status = None
        self.out_headers = []
        self.body_bytes = b""

    # ---- 响应输出替身 ----
    def write(self, data):
        self.body_bytes += data

    def send_response(self, code):
        self.status = code

    def send_response_only(self, code, message=None):
        self.status = code

    def send_header(self, k, v):
        self.out_headers.append((k, v))

    def end_headers(self):
        pass

    # ---- 断言辅助 ----
    def header(self, name):
        for k, v in self.out_headers:
            if k.lower() == name.lower():
                return v
        return None

    @property
    def json(self):
        return json.loads(self.body_bytes.decode("utf-8"))
