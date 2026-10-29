# -*- coding: utf-8 -*-
"""把 demo-scripts 的密码学 KAT 挂进根测试套件。

为什么不是把测试直接写在这里：``demo-scripts/`` 的设计约束是「单独拿走也能跑」，
它自己的测试必须待在自己目录下（``demo-scripts/tests/``）。但根目录的
``python -m unittest discover -s tests`` 只扫描 ``tests/``，不包这层就永远跑不到。

本文件只做「按路径加载 + 转交用例」，不含任何断言：
真实断言只有一份，住在 ``demo-scripts/tests/test_crypto_kat.py``，避免两处漂移。
"""
from __future__ import annotations

import importlib.util
import os
import unittest

_KAT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "demo-scripts",
    "tests",
    "test_crypto_kat.py",
)


def _load_kat():
    spec = importlib.util.spec_from_file_location("demo_scripts_crypto_kat", _KAT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_KAT = _load_kat()


def load_tests(loader, standard_tests, pattern):
    suite = unittest.TestSuite()
    for obj in vars(_KAT).values():
        if isinstance(obj, type) and issubclass(obj, unittest.TestCase) and obj is not unittest.TestCase:
            suite.addTests(loader.loadTestsFromTestCase(obj))
    return suite
