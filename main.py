# -*- coding: utf-8 -*-
"""
云端部署入口 main.py
====================
作用：给云端发布平台一个标准的启动入口。
      发布平台会自动寻找 main.py 并以 `python main.py` 启动服务，
      本文件只做一件事：转交给 hub.py 的 main()，由它决定监听地址与端口。

为什么需要它：项目真正的服务是 hub.py，本地用 start.py / hub.py 启动；
      但云端沙箱按惯例找 main.py，找不到就起不来。加这个薄入口后，
      本地和云端都能用各自习惯的方式启动，逻辑仍然只有一份（hub.py）。

端口说明：hub.py 的 main() 检测到云端沙箱注入的 PORT 环境变量时，
      会自动进入云端模式（绑定 0.0.0.0、读取 PORT、启用登录与权限闸门），
      所以这里不需要、也不应该传任何参数，保持 `python main.py` 即可。
"""

from hub import main

if __name__ == "__main__":
    main()
