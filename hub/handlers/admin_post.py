"""handlers.admin_post — POST · 管理员账号维护（云端同步 / 改密改角色删除）

仅在「已登录 + 管理员」且同源校验通过后可到达；由 handlers/api_post.py 拆分而来。
"""
from __future__ import annotations

from ..accounts import _accounts_report, _accounts_update, _cloud_cfg, _cloud_sync_all


class AdminPostMixin:

    def _post_accounts_sync(self):
        # 把本地账号库整体推到云端副本（幂等）
        n = _cloud_sync_all()
        self._send_json({"ok": True, "synced": n,
                         "cloud": bool(_cloud_cfg()),
                         "report": _accounts_report("local", reveal=True)})

    def _post_accounts_update(self):
        # 数据处理脚本 · 账号维护：改密码 / 改角色 / 删除（管理员）
        body = self._read_body()
        try:
            uid = int(body.get("id"))
        except Exception:  # noqa: BLE001
            self._send_json({"ok": False, "error": "缺少账号 id。"}, status=400)
            return
        fields = {}
        if body.get("password") is not None:
            fields["password"] = body.get("password")
        if body.get("role") is not None:
            fields["role"] = body.get("role")
        if body.get("delete"):
            fields["delete"] = True
        if not fields:
            self._send_json({"ok": False, "error": "没有要修改的字段。"}, status=400)
            return
        try:
            ok, err = _accounts_update(uid, fields)
        except Exception as e:  # noqa: BLE001
            self._send_json({"ok": False, "error": f"更新失败：{e}"}, status=500)
            return
        if not ok:
            self._send_json({"ok": False, "error": err}, status=400)
            return
        self._send_json({"ok": True, "report": _accounts_report("local", reveal=True)})
