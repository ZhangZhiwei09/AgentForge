---
name: analyze-flow
description: 深度分析一个源文件的数据流，生成结构化的技术文档
args: <file_path> [description]
---

# analyze-flow

分析指定源文件的数据流，生成结构化、按文件名维度组织的技术文档。

## 输入

用户提供：

- `<file_path>`：必填，要分析的源文件绝对路径或相对路径
- `[description]`：可选，文件的简要描述（如"客服聊天服务"），不提供则从代码中推断

## 输出

生成一份独立的技术文档，保存到 `docs/<file-name>.md`（文件名从源文件名推导）。

## 分析模板

按以下固定结构分析每个文件：

### 一、概览

- 文件路径、所属模块
- 一句话职责描述
- 在系统中的位置（被谁调用、调用谁）
- 关键常量和配置（如 `MAX_HISTORY_MESSAGES`、固定 User ID 等）

### 二、请求/响应概览（如适用）

- 入口函数签名
- 参数格式（JSON Schema 或 TypeScript 类型）
- 返回值/输出格式
- SSE 事件类型（如流式场景）

### 三、逐步骤数据流

对核心方法按步骤编号，每一步说明：

1. **做什么**：这一步的目的
2. **输入/输出格式**：完整的数据结构（不要写"同上"或"略"）
3. **为什么**：设计决策的理由

示例格式：

```
### 步骤 1：获取或创建会话
**入参：** `sessionId: string | null`
**数据库操作：**
  prisma.conversation.findFirst({ where: { sessionId, type: "customer_service" } })
**返回：** Conversation { id, title, userId, type, sessionId, ... }
**为什么：**
  - type 字段隔离客服会话和主聊会话
  - 固定 userId 避免为匿名用户建 User 记录
```

### 四、关键数据结构

列出文件中定义/使用的重要 interface、type、enum，完整写出字段和注释。

### 五、设计要点与决策

- 每个设计决策配 **"为什么"** 解释
- 如果存在类似组件，添加对比表

### 六、数据流全景图

```
入口
  ├─ 步骤 1：做了什么 → 产出了什么数据
  ├─ 步骤 2：...
  └─ 步骤 N：...
```

## 规则

1. **必须读源码**：不能凭记忆写，要先 Read 文件全文
2. **每个步骤都有数据格式**：不能跳过，不能用"同上"
3. **每个设计决策都有"为什么"**：不说"显然"或"众所周知"
4. **写完整的数据结构**：interface 的所有字段都列出来，带注释
5. **禁止笼统描述**：不能说"进行了一些处理"，要说"做了什么处理，输入什么格式，输出什么格式"
6. **如果用到了外部服务/Provider**：追踪其接口定义，说明数据经过它时格式如何变化
7. **文档保存到 `docs/<file-name>.md`**：每分析一个文件生成一份独立文档
8. **如果目标是补充已有文档**（用户说"补充到 xxx.md"），则 Read 已有文档后 Edit 追加，而不是新建

## 使用示例

```
/analyze-flow apps/server/src/services/chat.ts 主聊天服务
/analyze-flow apps/server/src/providers/registry.ts
/analyze-flow apps/server/src/services/memory-engine.ts 长期记忆引擎
```
