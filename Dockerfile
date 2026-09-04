# ==========================================================
# 塔罗 Web · 腾讯云云托管 (CloudBase CloudRun) / 腾讯云 CCR / 任意 Docker 平台
#   - 基础镜像: python:3.12-slim (Debian, 小体积, 兼容 waitress/openai)
#   - 启动: waitress-serve WSGI, 支持 SSE 长连接 (X-Accel-Buffering: no 已在 app.py response header 里写死)
#   - 敏感: ZHIPU_API_KEY 绝对不要写进镜像。通过 腾讯云托管控制台 / 环境变量 / GitHub Secrets 注入
# ==========================================================

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 先装依赖 (利用 Docker layer cache, 代码不变就不重新 pip install)
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# 再拷代码 + 静态资源 + 牌库 (card/ 里 78 张图)
COPY app.py Procfile ./
COPY templates/   ./templates/
COPY static/      ./static/
COPY card/        ./card/

# 腾讯云云托管会在平台侧注入 PORT; 本地没给就默认 5000
ENV PORT=5000
EXPOSE 5000

# 注意: 不要用 flask dev server (0.0.0.0:5000), 要用 waitress 多线程 + 稳定 SSE streaming
# waitress 默认不触发缓冲, 且 --threads 足够服务多用户轮询 SSE
CMD ["sh", "-c", "waitress-serve --port=${PORT:-5000} --threads=32 --connection-limit=64 app:app"]
