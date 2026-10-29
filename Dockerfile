# project-hub 容器镜像
#
# 枢纽本体只用 Python 标准库；唯一需要第三方的子应用是 starshu（Node/Express）。
# 因此基础镜像同时提供 Node 22 与 Python 3.11（>=3.11 即可）。
#
# 构建：
#   docker build -t project-hub .
# 运行（云端模式：绑定 0.0.0.0、读 $PORT 自动进入云端模式）：
#   docker run -p 3000:3000 -e PORT=3000 project-hub
# 本地模式（仍建议用源码直接跑，见 功能文档 §2）：
#   docker run -p 8000:8000 -e PORT=8000 project-hub

FROM node:22-slim

# 安装 Python 3.11（Debian slim 自带 python3，但无 pip/venv，补齐）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    # 部分子项目启动命令写的是 `python xxx.py`，确保 `python` 可用
    && ln -s /usr/bin/python3 /usr/local/bin/python

WORKDIR /app

# 复制整个工程（含 starshu 子应用与静态资源）
COPY . /app

# 安装星枢 Node 依赖（唯一需要第三方的子应用；缺失时由 subapps.py 运行时再补装）
RUN npm install --prefix starshu --omit=dev

ENV PORT=3000
EXPOSE 3000

# 云端发布平台约定：找 main.py 并以 `python main.py` 启动；
# 检测到 $PORT 即自动进入云端模式（绑定 0.0.0.0、读 PORT）。
CMD ["python3", "main.py"]
