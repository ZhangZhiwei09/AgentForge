# Type Safety & Runtime Validation

AgentForge 的类型安全策略：编译期类型安全 + 运行时数据安全。

## Core Principles

- 禁止使用 `any` 类型。
- 禁止使用无注释的 `as unknown as` 双重断言。
- 类型系统无法证明安全时，优先修复类型定义，而不是绕过编译器。
- TypeScript 编译通过不等于类型安全，所有外部数据都必须经过运行时校验或类型收窄。

---

## Allowed Type Narrowing

优先使用以下方式获得精确类型：

1. **Prisma 类型推导** — 首选，从 Schema 自动推导
2. **Zod Schema + `safeParse`** — 外部数据首选
3. **Type Guard** (`value is T`) — 自定义收窄逻辑
4. **`instanceof`** — 类实例判断
5. **Discriminated Union** — 联合类型收窄
6. **泛型约束** — 编译期约束

### 示例

```ts
const parsed = AgentScratchpadSchema.safeParse(raw);

if (!parsed.success) {
  logger.warn({ issues: parsed.error.issues });
  return defaultValue;
}

return parsed.data;
```

---

## Forbidden Patterns

### 禁止：`foo as any`

```ts
// ❌
foo as any
```

### 禁止：`foo as unknown as Bar`

```ts
// ❌
foo as unknown as Bar
```

### 禁止：`(err as Error).message`

```ts
// ❌
(err as Error).message
```

### 禁止：直接断言外部数据

```ts
// ❌
session.scratchpad as AgentScratchpad
```

```ts
// ❌
apiResponse as UserDTO
```

### 需要校验的数据源

如果数据来自以下任何来源，必须先验证结构，再获得类型：

- 数据库 Json 字段
- 外部 API
- HTTP Request
- Redis
- Queue
- 文件系统
- LLM 输出
- MCP Tool 返回值

---

## Runtime Validation Requirements

以下数据源必须经过运行时验证：

- Prisma Json 字段
- Agent Scratchpad
- Workflow Checkpoint
- Team Blackboard
- LLM Structured Output
- Tool Arguments
- Tool Results
- External API Responses

### 推荐模式

```ts
const result = Schema.safeParse(raw);

if (!result.success) {
  logger.warn(...);
  return fallback;
}

return result.data;
```

---

## Exceptions

以下情况允许使用 `as unknown as`：

1. 第三方库类型声明错误
2. 第三方库缺失类型定义
3. Framework 类型不兼容但运行时已验证安全

### 必须添加注释

```ts
// SAFE:
// BullBoard handler implements Hono fetch interface.
// Type mismatch is caused by missing upstream typings.
const handler =
  bullBoardHandler as unknown as MiddlewareHandler;
```

禁止无注释使用。

---

## Refactoring Rule

发现 `foo as any` 时，**不允许机械替换**为：

```ts
// ❌ 机械替换
foo as unknown as Foo
```

必须寻找真实类型来源：

1. Prisma 类型推导
2. DTO 类型
3. Zod Schema
4. Type Guard
5. 泛型约束

只有在无法修改上游类型且已确认运行时安全的情况下，才允许例外处理。

---

## Goal

目标不是消灭 TypeScript 报错。

目标是：

- 编译期类型安全
- 运行时数据安全
- Agent Runtime 状态安全
- 数据库 Json 字段安全
- LLM 输出安全

> 禁止为了通过编译而绕过类型系统。
