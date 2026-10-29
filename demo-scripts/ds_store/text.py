# -*- coding: utf-8 -*-
"""ds_store.text — 输入规范化（防御性校验：只挡"明显不可能"的输入，不做业务规则）"""
from __future__ import annotations

from . import paths


def norm(email: str) -> str:
    """邮箱归一化：去空白 + 转小写 + 限长。库内所有比较都用它，避免大小写重复注册。"""
    return str(email or "").strip().lower()[:paths.MAX_FIELD_LEN]


def clean_text(value, default: str = "") -> str:
    text = str(value or "").strip()
    return text[:paths.MAX_FIELD_LEN] if text else default


def clean_role(role) -> str:
    role = str(role or "").strip().lower()
    return role if role in paths.VALID_ROLES else "user"
