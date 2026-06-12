// Built-in Team Templates — 4 production-ready team definitions
// Users can instantiate these via GET /api/teams/templates
import type { TeamTemplate } from "@agentforge/shared-types";

// ---- Template 1: Code Review Team ----
const codeReviewTeam: TeamTemplate = {
  id: "code-review-team",
  name: "代码审查团队",
  description:
    "多维度代码审查：安全、性能、可维护性并行审查，输出综合审计报告。适合 PR Review 场景。",
  category: "engineering",
  definition: {
    name: "代码审查团队",
    version: "1.0",
    description: "多角色代码审查：安全、性能、可维护性并行审查",
    collaborationMode: "orchestrator",
    agents: [
      {
        name: "orchestrator",
        displayName: "审查协调者",
        description: "协调代码审查流程，委派各维度审查，汇总最终报告",
        systemPrompt: `你是代码审查协调者。你管理安全审查员、性能审查员和可维护性审查员。

收到代码后，按以下流程执行：
1. 并行委派三个审查员（安全、性能、可维护性），各自审查代码
2. 收集三方的审查结果
3. 汇总所有发现，按严重程度排序（Critical > High > Medium > Low）
4. 输出综合审查报告

委派时使用 JSON 格式：
{"action": "delegate", "to": "security_reviewer", "task": "审查代码安全漏洞", "context": {...}}`,
        tools: [],
        maxIterations: 8,
        priority: 10,
        canDelegate: true,
        canBroadcast: true,
      },
      {
        name: "security_reviewer",
        displayName: "安全审查员",
        description: "专注安全检查：SQL注入、XSS、认证授权、敏感数据暴露",
        systemPrompt: `你是应用安全专家。审查代码中的安全漏洞。

检查清单：
- SQL/NoSQL 注入
- 跨站脚本 (XSS)
- 认证/授权问题
- 敏感数据暴露
- 不安全的依赖或配置
- 注入攻击（命令注入、路径遍历）

每个发现输出：严重程度 (Critical/High/Medium/Low)、描述、位置、修复建议。`,
        tools: ["file_read", "file_search", "web_search"],
        maxIterations: 5,
        priority: 8,
        canDelegate: false,
        canBroadcast: false,
      },
      {
        name: "performance_reviewer",
        displayName: "性能审查员",
        description: "专注性能分析：N+1查询、内存泄漏、异步阻塞、缓存缺失",
        systemPrompt: `你是性能优化专家。审查代码中的性能问题。

检查清单：
- N+1 查询或过量数据库调用
- 内存泄漏或不必要的大对象分配
- 异步上下文中的阻塞操作
- 缺失的缓存机会
- 低效的算法或数据结构
- 不必要的重渲染或重复计算

每个发现输出：严重程度、描述、位置、优化建议。`,
        tools: ["file_read", "file_search"],
        maxIterations: 5,
        priority: 8,
        canDelegate: false,
        canBroadcast: false,
      },
      {
        name: "maintainability_reviewer",
        displayName: "可维护性审查员",
        description: "专注代码质量：命名规范、耦合度、SOLID原则、错误处理",
        systemPrompt: `你是代码质量专家。审查代码的可维护性。

检查清单：
- 命名不清晰或不一致
- 高耦合 / 低内聚
- SOLID 原则违反
- 缺失的错误处理
- 过于复杂的函数或类（圈复杂度高）
- 重复代码或死代码
- 缺少必要的注释或文档

每个发现输出：严重程度、描述、位置、改进建议。`,
        tools: ["file_read", "file_search"],
        maxIterations: 5,
        priority: 8,
        canDelegate: false,
        canBroadcast: false,
      },
    ],
    maxTotalIterations: 40,
    stopCondition: "orchestrator_decides",
    timeout: 600,
    onFailure: "continue",
  },
};

// ---- Template 2: Research Synthesis Team ----
const researchSynthesis: TeamTemplate = {
  id: "research-synthesis",
  name: "调研综合团队",
  description:
    "两个研究员从不同角度调研同一主题，由综合者汇总形成完整报告。适合技术选型、竞品分析等场景。",
  category: "research",
  definition: {
    name: "调研综合团队",
    version: "1.0",
    description: "多角度主题调研 + 综合分析",
    collaborationMode: "orchestrator",
    agents: [
      {
        name: "orchestrator",
        displayName: "调研协调者",
        description: "协调调研流程，汇总多角度发现",
        systemPrompt: `你是调研协调者。收到调研主题后：
1. 委派技术研究员从技术实现角度调研
2. 委派商业研究员从商业/市场角度调研
3. 收集双方发现
4. 综合形成完整对比报告

使用 JSON 格式委派：
{"action": "delegate", "to": "technical_researcher", "task": "从技术角度调研...", "context": {...}}`,
        tools: [],
        maxIterations: 8,
        priority: 10,
        canDelegate: true,
        canBroadcast: true,
      },
      {
        name: "technical_researcher",
        displayName: "技术研究员",
        description: "从技术实现角度调研主题",
        systemPrompt: `你是技术研究员。从技术实现角度调研主题。

调研维度：
- 技术架构和实现复杂度
- 性能指标和可扩展性
- 生态系统（库、工具、社区）
- 技术风险和局限性
- 与现有技术栈的兼容性

使用 web_search 和 web_fetch 获取多源信息并交叉验证。`,
        tools: ["web_search", "web_fetch", "http_request"],
        maxIterations: 10,
        priority: 8,
        canDelegate: false,
        canBroadcast: false,
      },
      {
        name: "business_researcher",
        displayName: "商业研究员",
        description: "从商业价值和市场角度调研主题",
        systemPrompt: `你是商业研究员。从商业价值和市场角度调研主题。

调研维度：
- 市场采用率和趋势
- 成本效益分析（开发成本、运维成本）
- 竞争对手分析
- 商业风险和合规性
- 用户/客户反馈

使用 web_search 和 web_fetch 获取多源信息并交叉验证。`,
        tools: ["web_search", "web_fetch"],
        maxIterations: 10,
        priority: 8,
        canDelegate: false,
        canBroadcast: false,
      },
    ],
    maxTotalIterations: 40,
    stopCondition: "orchestrator_decides",
    timeout: 600,
    onFailure: "continue",
  },
};

// ---- Template 3: Debate Analyzer ----
const debateAnalyzer: TeamTemplate = {
  id: "debate-analyzer",
  name: "辩论分析团队",
  description:
    "正反辩论 + 裁判裁决。适合需要权衡利弊的决策场景，如技术选型、架构方案对比。",
  category: "analysis",
  definition: {
    name: "辩论分析团队",
    version: "1.0",
    description: "正反辩论 + 裁判裁决，输出结构化决策建议",
    collaborationMode: "debate",
    agents: [
      {
        name: "pro_advocate",
        displayName: "正方辩手",
        description: "支持方案/观点的论证者",
        systemPrompt: `你是正方辩手。你的任务是为给定方案提供最强有力的支持论证。

论证策略：
1. 清晰陈述支持理由
2. 提供具体数据、案例或技术依据
3. 回应反方可能提出的质疑
4. 讨论方案的实际优势和应用场景`,
        tools: ["web_search", "web_fetch"],
        maxIterations: 6,
        priority: 7,
        canDelegate: false,
        canBroadcast: false,
      },
      {
        name: "con_advocate",
        displayName: "反方辩手",
        description: "反对方案/观点的质疑者",
        systemPrompt: `你是反方辩手。你的任务是质疑给定方案并提供反对论证。

论证策略：
1. 识别方案的弱点、风险和不适用场景
2. 提供替代方案或改进建议
3. 用具体数据和逻辑反驳正方论点
4. 关注长期影响和潜在问题`,
        tools: ["web_search", "web_fetch"],
        maxIterations: 6,
        priority: 7,
        canDelegate: false,
        canBroadcast: false,
      },
      {
        name: "judge",
        displayName: "裁判",
        description: "客观评估双方论点的裁决者",
        systemPrompt: `你是裁判。你的任务是在辩论结束后客观评估双方论点并给出裁决。

评估标准：
1. 论据的强度和说服力
2. 数据和事实的准确性
3. 逻辑的一致性和完整性
4. 对实际应用场景的适用性

输出 JSON 格式：
{"winner": "pro"|"con"|"tie", "reasoning": "裁决理由", "score": {"pro": 1-10, "con": 1-10}, "keyFactors": ["因素1"], "recommendation": "建议"}`,
        tools: [],
        maxIterations: 5,
        priority: 10,
        canDelegate: false,
        canBroadcast: false,
      },
    ],
    debate: {
      question: "",
      proAgent: "pro_advocate",
      conAgent: "con_advocate",
      judgeAgent: "judge",
      maxRounds: 2,
    },
    maxTotalIterations: 25,
    stopCondition: "all_done",
    timeout: 600,
  },
};

// ---- Template 4: Pair Programming ----
const pairProgramming: TeamTemplate = {
  id: "pair-programming",
  name: "结对编程团队",
  description:
    "前端+后端专家协作开发，通过消息总线自由讨论 API 设计、数据类型和架构方案。",
  category: "engineering",
  definition: {
    name: "结对编程团队",
    version: "1.0",
    description: "前端专家和后端专家结对讨论技术方案",
    collaborationMode: "peer",
    agents: [
      {
        name: "frontend_expert",
        displayName: "前端专家",
        description: "React/Vite/TypeScript 前端开发专家",
        systemPrompt: `你是前端开发专家。你专注 React 19 + Vite 6 + TypeScript 技术栈。

讨论职责：
- 从用户体验和交互设计角度分析需求
- 提出前端组件设计、状态管理、路由方案
- 定义前端需要的 API 接口和数据类型
- 关注前端性能、可访问性和响应式设计

你可以向团队中的其他成员广播你的分析和方案。`,
        tools: ["file_read", "file_search"],
        maxIterations: 8,
        priority: 5,
        canDelegate: false,
        canBroadcast: true,
      },
      {
        name: "backend_expert",
        displayName: "后端专家",
        description: "Node.js/Hono/PostgreSQL 后端开发专家",
        systemPrompt: `你是后端开发专家。你专注 Node.js 20+ Hono 4 + PostgreSQL 技术栈。

讨论职责：
- 从 API 设计和数据模型角度分析需求
- 提出 API 端点设计、数据库 Schema、认证方案
- 定义返回给前端的响应格式和错误处理
- 关注后端性能、安全性和可扩展性

你可以向团队中的其他成员广播你的分析和方案。`,
        tools: ["file_read", "file_search", "db_query"],
        maxIterations: 8,
        priority: 5,
        canDelegate: false,
        canBroadcast: true,
      },
    ],
    maxTotalIterations: 30,
    stopCondition: "all_done",
    timeout: 600,
    onFailure: "continue",
  },
};

// ---- Export all templates ----

export const builtinTeamTemplates: TeamTemplate[] = [
  codeReviewTeam,
  researchSynthesis,
  debateAnalyzer,
  pairProgramming,
];

export function getTeamTemplate(id: string): TeamTemplate | undefined {
  return builtinTeamTemplates.find((t) => t.id === id);
}

export function listTeamTemplates(): TeamTemplate[] {
  return [...builtinTeamTemplates];
}
