# 生产部署运维手册

## 服务器信息

| 项目 | 值 |
|------|-----|
| 公网 IP | `39.108.63.145` |
| SSH | `ssh root@39.108.63.145`（密码见 `.env.production`） |
| 系统 | Alibaba Cloud ECS 华南1（深圳），Docker 26.1.3 |
| 代码路径 | `/root/agentforge/` |
| 配置文件 | `/root/agentforge/infra/docker/.env.production` |

## 架构概览

```
用户 → :80 (Nginx 前端) → :8000 (Server, Docker 内部)
                                  ↓
用户 → :3000 (Langfuse 观测面板)
```

所有服务通过 `docker-compose.prod.yml` 编排，`--env-file .env.production` 注入配置。

## 常用操作

### 启动全部服务

```bash
ssh root@39.108.63.145
cd /root/agentforge/infra/docker
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

首次冷启动约 30 秒，DB + Redis + Milvus + Server + Nginx + Langfuse 全部就绪。

### 停止全部服务

```bash
cd /root/agentforge/infra/docker
docker compose --env-file .env.production -f docker-compose.prod.yml down
```

**停止后数据不会丢失**——数据库、向量库、Langfuse 数据保存在 Docker Volume 中，下次启动自动恢复。

### 查看服务状态

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### 查看日志

```bash
# 全部日志
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=50

# 单个服务
docker compose --env-file .env.production -f docker-compose.prod.yml logs server --tail=50
```

### 仅重启 Server（代码更新后）

```bash
cd /root/agentforge/infra/docker
docker compose --env-file .env.production -f docker-compose.prod.yml up -d server
```

Server 重启约 10 秒，期间客服前端暂时不可用。

## 更新部署

### 只改前端

```bash
# 本地构建
pnpm --filter @agentforge/customer-service build

# 上传到服务器
scp -r apps/customer-service/dist/* root@39.108.63.145:/tmp/html/

# SSH 到服务器替换
ssh root@39.108.63.145
docker cp /tmp/html/. docker-customer-service-1:/usr/share/nginx/html/
# 无需重启，刷新页面即生效
```

### 改了后端或 Dockerfile

```bash
# 本地提交 & 推送代码
git add . && git commit -m "feat: xxx" && git push

# 在服务器上拉取最新代码
ssh root@39.108.63.145
cd /root/agentforge
git pull

# 重新构建镜像
docker build -f infra/docker/Dockerfile.server -t agentforge-server:latest .

# 重启
cd infra/docker
docker compose --env-file .env.production -f docker-compose.prod.yml up -d server
```

## 数据库维护

### 连接数据库

```bash
docker exec -it docker-db-1 psql -U agentforge
```

### 执行 SQL 脚本

```bash
docker exec -w /app/apps/server -i docker-server-1 node < script.js
```

### 重置数据库

```bash
# 停止服务
docker compose --env-file .env.production -f docker-compose.prod.yml down

# 删除数据库 Volume（⚠️ 不可逆）
docker volume rm docker_pgdata

# 重新启动（Prisma migrate 自动建表）
docker compose --env-file .env.production -f docker-compose.prod.yml up -d

# 插入种子数据
docker exec -w /app/apps/server -i docker-server-1 node < infra/scripts/seed-users.js
```

## Langfuse 观测

| 项目 | 值 |
|------|-----|
| 访问地址 | http://39.108.63.145:3000 |
| Public Key | `pk-lf-3f1072ce-4009-4f9c-a997-718460ea52ee` |
| Secret Key | `sk-lf-...`（完整值见服务器 `.env.production`） |

### 首次设置

1. 打开 Langfuse → 注册管理员账号
2. 创建 Organization → 创建 Project
3. Settings → API Keys → 获取 Key
4. 更新 `.env.production` 中的 `LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY`
5. 重启 Server：`docker compose --env-file .env.production -f docker-compose.prod.yml up -d server`

### 查看数据

Traces 面板展示每次 AI 对话的：
- **调用链路**：用户消息 → Router → Agent → LLM → 响应
- **性能指标**：TTFT（首字延迟）、TTLT（完整响应时间）、Token 消耗
- **错误追踪**：异常栈、失败原因

## 防火墙

阿里云控制台 → 防火墙（已配置 4 条规则）：

| 端口 | 用途 |
|------|------|
| 80 | 客服前端 |
| 3000 | Langfuse 面板 |
| (SSH) | 远程管理 |

需要在 `https://console.aliyun.com` → 轻量应用服务器 → 防火墙 管理。

## 故障排查

### 页面无法访问

```bash
# 检查容器状态
docker ps

# 检查特定容器日志
docker logs docker-customer-service-1
docker logs docker-server-1
```

### 提问报错

```bash
# 检查 Server 日志中的错误
docker compose --env-file .env.production -f docker-compose.prod.yml logs server | grep -i error
```

常见原因：
- LLM API Key 过期或余额不足 → 更新 `.env.production` 中的 `OPENAI_API_KEY`
- 数据库连接失败 → 检查 DB 容器是否运行
- 外键约束错误 → 运行 `seed-users.js` 补全系统用户数据

### Docker Hub 镜像拉取超时

国内网络访问 Docker Hub 可能很慢。镜像加速器已配置（daocloud、163、baidubce），GHCR（`ghcr.io`）不受加速，改用 Docker Hub 镜像（如 `langfuse/langfuse:2` 替代 `ghcr.io/langfuse/langfuse:2`）。
