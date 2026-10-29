"""HTTP 处理层：按职责拆成多个 Mixin，最终组合成 HubHandler。

组合顺序即方法解析顺序（MRO）：BaseMixin 放通用能力，其余按请求类型划分；
方法之间通过 self 互相调用，不 import 彼此，因此不存在循环依赖。
"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler

from .base import BaseMixin
from .browse import BrowseMixin
from .subapp import SubappMixin
from .routes_get import GetMixin
from .project_ops import ProjectOpsMixin
from .files_api import FilesMixin
from .files_write import FilesWriteMixin
from .auth_post import AuthPostMixin
from .admin_post import AdminPostMixin
from .project_post import ProjectPostMixin
from .api_post import ApiPostMixin


class HubHandler(BaseMixin, GetMixin, BrowseMixin, SubappMixin,
                 ProjectOpsMixin, FilesMixin, FilesWriteMixin,
                 AuthPostMixin, AdminPostMixin, ProjectPostMixin,
                 ApiPostMixin, BaseHTTPRequestHandler):
    # HTTP/1.1 才能用 keep-alive：默认的 HTTP/1.0 每个请求新建一条 TCP 连接，
    # 首屏几十个资源就是几十次握手。开启的前提是所有响应都带 Content-Length
    # （已逐个核对：JSON/静态/错误页/重定向/代理均带；204 无响应体，天然安全）。
    protocol_version = "HTTP/1.1"
    # 长连接空闲超时：浏览器拿完资源会挂着连接，不设超时的话线程会被长期占住。
    # 65s 大于浏览器的空闲复用窗口，正常复用不受影响。
    timeout = 65


__all__ = ["HubHandler"]
