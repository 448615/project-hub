#!/usr/bin/env python3
"""性能层回归：前端合并包、搜索索引、端口探测缓存。

这三处都是"用缓存换速度"的改动，出了问题不会报错，只会表现为
「改了东西没生效」或「明明有文件却搜不到」。所以测试重点不是快不快，
而是缓存该失效的时候有没有失效。
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.abspath("."))

from hub import static_assets          # noqa: E402
from hub import projects               # noqa: E402
from hub.search_index import invalidate, search   # noqa: E402


def test_bundle():
    ok = True
    # 1) 真实清单能拼出非空的包，且每个登记的文件都出现在包里
    static_root = os.path.join(os.path.abspath("."), "static")
    data, ver = static_assets.bundle_bytes(static_root)
    listed = static_assets._read_order(static_root)
    missing = [r for r in listed
               if ("/* ---- " + r + " ---- */").encode("utf-8") not in data]
    good = bool(data) and bool(ver) and not missing
    print(f"[{'PASS' if good else 'FAIL'}] 合并包: {len(data)} bytes, "
          f"{len(listed)} 个文件, 缺失={missing}")
    ok &= good

    # 2) 同一份源码再取一次必须完全一致（缓存命中不能变形）
    data2, ver2 = static_assets.bundle_bytes(static_root)
    good = data2 == data and ver2 == ver
    print(f"[{'PASS' if good else 'FAIL'}] 缓存一致性: ver={ver} 重复={ver2}")
    ok &= good

    # 3) 改一个源文件 → 指纹必须变（否则浏览器/缓存永远拿旧包）
    tmp = tempfile.mkdtemp(prefix="bundleTest_")
    try:
        os.makedirs(os.path.join(tmp, "js"))
        with open(os.path.join(tmp, "js", "bundle.order"), "w", encoding="utf-8") as f:
            f.write("js/a.js\njs/b.js\n")
        for name, body in (("a.js", "var A=1;\n"), ("b.js", "var B=2;\n")):
            with open(os.path.join(tmp, "js", name), "w", encoding="utf-8") as f:
                f.write(body)
        d1, v1 = static_assets.bundle_bytes(tmp)
        with open(os.path.join(tmp, "js", "b.js"), "w", encoding="utf-8") as f:
            f.write("var B=222;\n")
        os.utime(os.path.join(tmp, "js", "b.js"), (1, 1))   # 确保 mtime 变化
        d2, v2 = static_assets.bundle_bytes(tmp)
        good = v1 != v2 and b"B=222" in d2
        print(f"[{'PASS' if good else 'FAIL'}] 改文件后指纹变化: {v1} → {v2}")
        ok &= good

        # 4) 漏登记检测：多放一个 js 不写进清单，应被 check_order 抓到
        with open(os.path.join(tmp, "js", "c.js"), "w", encoding="utf-8") as f:
            f.write("var C=3;\n")
        miss = static_assets.check_order(tmp)
        good = len(miss) == 1 and miss[0].startswith("js/c.js")
        print(f"[{'PASS' if good else 'FAIL'}] 漏登记检测: {miss}")
        ok &= good

        # 4b) 清单里写了不存在的文件，也要被抓到（拼错路径同样是静默失效）
        os.remove(os.path.join(tmp, "js", "c.js"))     # 先清掉上一步的干扰项
        with open(os.path.join(tmp, "js", "bundle.order"), "a", encoding="utf-8") as f:
            f.write("js/typo.js\n")
        bad = static_assets.check_order(tmp)
        good = len(bad) == 1 and bad[0].startswith("js/typo.js")
        print(f"[{'PASS' if good else 'FAIL'}] 幽灵条目检测: {bad}")
        ok &= good
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # 5) 真实项目里不应该存在漏登记
    real_missing = static_assets.check_order(static_root)
    good = real_missing == []
    print(f"[{'PASS' if good else 'FAIL'}] 真实项目无漏登记: {real_missing}")
    ok &= good

    # 6) 压缩确实生效（文本资源至少省一半）
    import gzip
    gz = gzip.compress(data, 6)
    good = len(gz) < len(data) * 0.6
    print(f"[{'PASS' if good else 'FAIL'}] gzip 收益: {len(data)} → {len(gz)} bytes")
    ok &= good
    return ok


def test_search_index():
    ok = True
    tmp = tempfile.mkdtemp(prefix="searchTest_")
    try:
        proj = os.path.join(tmp, "proj")
        os.makedirs(os.path.join(proj, "sub"))
        with open(os.path.join(proj, "README.md"), "w", encoding="utf-8") as f:
            f.write("x")
        with open(os.path.join(proj, "sub", "DeepFile.txt"), "w", encoding="utf-8") as f:
            f.write("x")

        invalidate()
        hits = search(tmp, "deepfile")           # 大小写不敏感
        good = len(hits) == 1 and hits[0]["project"] == "proj" \
            and hits[0]["path"] == "sub/DeepFile.txt"
        print(f"[{'PASS' if good else 'FAIL'}] 子目录命中: {hits}")
        ok &= good

        # 新建文件后：不先失效则仍是旧索引（TTL 内），失效后立刻能搜到
        with open(os.path.join(proj, "NewNote.md"), "w", encoding="utf-8") as f:
            f.write("x")
        stale = search(tmp, "newnote")
        invalidate()
        fresh = search(tmp, "newnote")
        good = len(stale) == 0 and len(fresh) == 1
        print(f"[{'PASS' if good else 'FAIL'}] 写后失效: 失效前={len(stale)} 失效后={len(fresh)}")
        ok &= good

        # node_modules 必须跳过（否则索引会被依赖撑爆）
        os.makedirs(os.path.join(tmp, "proj", "node_modules", "pkg"))
        with open(os.path.join(tmp, "proj", "node_modules", "pkg", "Target.js"), "w") as f:
            f.write("x")
        invalidate()
        hits = search(tmp, "target.js")
        good = hits == []
        print(f"[{'PASS' if good else 'FAIL'}] 跳过 node_modules: {hits}")
        ok &= good

        # 空查询不触发扫描、也不报错
        good = search(tmp, "") == []
        print(f"[{'PASS' if good else 'FAIL'}] 空查询返回空: {good}")
        ok &= good
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return ok


def test_port_cache():
    ok = True
    calls = {"n": 0}
    orig = projects._probe_port

    def fake(port):
        calls["n"] += 1
        return False

    projects.invalidate_ports()
    projects._probe_port = fake
    try:
        a = projects.detect_port(65531)
        b = projects.detect_port(65531)
        good = (a is False and b is False and calls["n"] == 1)
        print(f"[{'PASS' if good else 'FAIL'}] 端口探测走缓存: 探测次数={calls['n']}")
        ok &= good

        projects.invalidate_ports()
        projects.detect_port(65531)
        good = calls["n"] == 2
        print(f"[{'PASS' if good else 'FAIL'}] 失效后重新探测: 探测次数={calls['n']}")
        ok &= good

        # 非法端口不能抛异常（配置写错也要能出页面）
        good = projects.detect_port("abc") is False and projects.detect_port(None) is False
        print(f"[{'PASS' if good else 'FAIL'}] 非法端口返回 False")
        ok &= good
    finally:
        projects._probe_port = orig
        projects.invalidate_ports()
    return ok


def main():
    ok = True
    ok &= test_bundle()
    ok &= test_search_index()
    ok &= test_port_cache()
    print("\n结果:", "全部通过" if ok else "有失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
