#!/bin/sh
# ── Nginx 入口：将模板中的环境变量替换为实际值 ──
# 默认后端地址为 Docker Compose 中的 server 服务
export SERVER_API_URL="${SERVER_API_URL:-http://server:8000}"

# 将模板中的 ${...} 占位符替换为环境变量值
envsubst '${SERVER_API_URL}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

echo "Starting nginx with SERVER_API_URL=$SERVER_API_URL"

exec "$@"
