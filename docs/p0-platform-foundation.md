# P0 Platform Foundation

> **完成日期：** 2026-06-09
> **分支：** init
> **阶段定位：** 将 AgentForge 从单用户 Demo 升级为可部署的多用户产品基础

---

## 一、概述

P0 是 AgentForge V4 完成后的第一个平台工程阶段，聚焦于"能让第二个用户使用"的最低平台门槛。包含 5 个子阶段：

| 子阶段 | 名称 | 状态 |
|--------|------|------|
| P0-1 | 认证与多租户 | ✅ |
| P0-2 | 结构化日志 | ✅ |
| P0-3 | 测试基础设施 | ✅ |
| P0-4 | CI/CD 流水线 | ✅ |
| P0-5 | 安全加固 | ✅ |

---

## 二、P0-1 认证与多租户

### 变更摘要

从硬编码单用户 `00000000-...-0001` 演进为 JWT + API Key 双模认证体系。

### 数据模型

**User 表扩展：**
```sql
ALTER TABLE users ADD COLUMN password_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN avatar_url VARCHAR(500);
ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT 'user';
```

**新增表：**
- `refresh_tokens` — 刷新令牌（JWT + 哈希存储 + 吊销支持）
- `api_keys` — API 密钥（哈希存储 + 最后使用时间 + 过期吊销）

### 新增文件

| 文件 | 用途 |
|------|------|
| `apps/server/src/services/auth.ts` | AuthService：注册、登录、JWT 签发/验证、密码哈希、Refresh Token 轮转、API Key 管理 |
| `apps/server/src/middleware/auth.ts` | 认证中间件：提取 Bearer Token / API Key → 验证 → 注入 `c.set("user", ...)` |
| `apps/server/src/routes/auth.ts` | 认证路由：signup、signin、refresh、signout、me、api-keys CRUD |
| `apps/server/src/lib/hono.ts` | 类型化 Hono 工厂函数 `createHono()`，统一 `AppVariables` 类型 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `packages/database/prisma/schema.prisma` | 添加 passwordHash、avatarUrl、role 字段 + RefreshToken、ApiKey 模型 |
| `apps/server/src/app.ts` | 注册 authMiddleware + authRoutes；导出 `AppVariables` 类型 |
| `apps/server/src/index.ts` | 种子数据改用 `authService.signUp()`（默认密码：agentforge） |
| `apps/server/src/routes/chat.ts` | `DEFAULT_USER_ID` → `c.get("user").id`；增加会话所有权校验 |
| `apps/server/src/routes/conversations.ts` | `DEFAULT_USER_ID` → `c.get("user").id`；查询/删除增加 userId 过滤 |
| `apps/server/src/routes/memories.ts` | `DEFAULT_USER_ID` → `c.get("user").id` |
| `packages/sdk/src/client.ts` | 新增 `signUp/signIn/refreshToken/getMe/apiKey` 方法；自动注入 Authorization header |
| `packages/shared-types/src/user.ts` | 新增 AuthUser, SignUpRequest, SignInRequest, AuthResponse, ApiKeyDTO 等类型 |

### 架构决策

- **JWT 实现**：基于 Node.js 内置 `crypto` 模块（HMAC-SHA256），零外部依赖
- **密码哈希**：SHA-256 + UUID 盐值（`salt:hash` 格式存储）
- **Token 有效期**：Access Token 15 分钟 / Refresh Token 7 天
- **API Key 格式**：`af_` 前缀 + 32 位 hex
- **公开路由白名单**：`/api/auth/*`、`/api/health`、`/api/customer-chat`

### API 端点

```http
POST   /api/auth/signup          # 注册（email + password）
POST   /api/auth/signin          # 登录 → JWT + Refresh Token
POST   /api/auth/refresh         # 刷新 Access Token
POST   /api/auth/signout         # 登出（吊销 Refresh Token）
GET    /api/auth/me              # 获取当前用户信息
POST   /api/auth/api-keys        # 创建 API Key
GET    /api/auth/api-keys        # 列出 API Key
DELETE /api/auth/api-keys/:id    # 吊销 API Key
```

---

## 三、P0-2 结构化日志

### 变更摘要

从 `console.log` 演进为 pino 结构化 JSON 日志 + 请求级 Correlation ID。

### 新增文件

| 文件 | 用途 |
|------|------|
| `packages/logger/package.json` | `@agentforge/logger` 包清单 |
| `packages/logger/tsconfig.json` | TypeScript 配置 |
| `packages/logger/src/index.ts` | pino 日志器 + AsyncLocalStorage 请求上下文 |
| `apps/server/src/middleware/request-id.ts` | Request ID 中间件（生成/转发 X-Request-ID + 请求耗时记录） |

### 修改文件（共 15 个）

所有 `apps/server/src/` 下的 console 调用替换为结构化日志：

| 文件 | 替换内容 |
|------|----------|
| `services/chat.ts` | `console.log/warn` → `logger.info/warn/debug` |
| `services/memory-engine.ts` | 同上 |
| `services/knowledge.ts` | 同上 |
| `services/knowledge-ingestion.ts` | 同上 |
| `services/customer-chat.ts` | 同上 |
| `services/bm25.ts` | 同上 |
| `tools/registry.ts` | 同上 |
| `routes/chat.ts` | 同上 |
| `routes/knowledge.ts` | 同上 |
| `middleware/error.ts` | 同上 |
| `index.ts` | 同上 |

### 日志级别约定

| 级别 | 场景 |
|------|------|
| `trace` | LLM 原始 chunk |
| `debug` | LLM 调用、工具执行、中间状态 |
| `info` | 请求生命周期、用户操作、种子数据 |
| `warn` | 可恢复错误（Milvus 降级、服务跳过） |
| `error` | 请求失败、数据库连接失败 |

---

## 四、P0-3 测试基础设施

### 变更摘要

从零测试覆盖到 16 个核心路径测试，建立 vitest 测试框架。

### 新增文件

| 文件 | 用途 |
|------|------|
| `apps/server/vitest.config.ts` | vitest 配置（单 fork 模式，兼容 Windows） |
| `apps/server/src/__tests__/setup.ts` | 测试环境初始化 |
| `apps/server/src/tools/__tests__/registry.test.ts` | ToolRegistry 单元测试（11 tests） |
| `apps/server/src/services/__tests__/bm25.test.ts` | BM25 编码器测试（5 tests） |

### 测试结果

```
 Test Files  2 passed (2)
      Tests  16 passed (16)
   Duration  514ms
```

### 测试清单

- **ToolRegistry**：注册、列表、按名获取定义、执行（calculator/get_current_time/web_search）、未知工具报错、非法表达式
- **BM25SparseEncoder**：fit 训练、文档编码、查询编码、未知词处理、相关性排序

### 新增脚本

```bash
pnpm --filter @agentforge/server test        # 运行测试
pnpm --filter @agentforge/server test:watch  # 监听模式
```

---

## 五、P0-4 CI/CD 流水线

### 新增文件

| 文件 | 用途 |
|------|------|
| `.github/workflows/ci.yml` | GitHub Actions：install → prisma generate → typecheck → test |

### 触发条件

- Push 到 `main`、`init`、`feature/**` 分支
- Pull Request 到 `main` 分支

### CI 环境

- PostgreSQL 16 (pgvector) 作为 Service Container
- Node.js 20 + pnpm 9
- 测试数据库：`agentforge_test`

---

## 六、P0-5 安全加固

### 新增文件

| 文件 | 用途 |
|------|------|
| `apps/server/src/middleware/rate-limit.ts` | 滑动窗口内存限流中间件 |

### 限流策略

| 级别 | 限制 | 窗口 |
|------|------|------|
| 全局 | 60 次/分钟/IP | 60s |
| Chat API | 20 次/分钟/IP | 60s |

### 行为

- 超限返回 `429 Too Many Requests` + `Retry-After` 头
- 基于 `X-Forwarded-For` / `X-Real-IP` 识别客户端

---

## 七、验证清单

| 检查项 | 命令 | 结果 |
|--------|------|------|
| 全量类型检查 | `pnpm typecheck` | ✅ 12/12 包通过 |
| 测试套件 | `pnpm --filter @agentforge/server test` | ✅ 16 tests passed |
| Prisma 迁移 | `prisma migrate dev` | ✅ 已应用 `add_auth_tables` |
| 默认用户 | 种子数据 | ✅ dev@agentforge.local / agentforge |

---

## 八、向后兼容说明

- 现有 API 端点路径不变
- 认证中间件白名单跳过了 `/api/health` 和 `/api/customer-chat`
- 种子数据自动创建默认用户（邮箱 `default@agentforge.local`，密码 `agentforge`）
- 所有 conversation/memory/knowledge 数据已按 `user_id` 隔离
- 前端 SDK 的 `AgentForgeClient` 构造函数新增可选 `getAccessToken` 和 `onAuthError` 回调，无 Token 时行为与旧版一致
