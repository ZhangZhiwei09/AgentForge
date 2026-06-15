// App Generation Tools — WeaveFox Phase 1 (V12)
// Tools for AI-driven application code generation, file management, and code review
// Follows the same pattern as builtins.ts and other tool files
import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "./types.js";
import type { RunContext } from "../runtime/context.js";

// ---------------------------------------------------------------------------
// 1. plan_app_structure — Design the file tree for the app
// ---------------------------------------------------------------------------

const planAppStructureDef: ToolDefinition = {
  type: "function",
  function: {
    name: "plan_app_structure",
    description:
      "规划应用的文件树结构。根据用户需求和选定的框架，设计完整的项目文件列表。返回每个文件的路径、语言类型和用途说明。在生成任何代码之前先调用此工具，确保整体结构合理。",
    parameters: {
      type: "object",
      properties: {
        requirements: {
          type: "string",
          description: "用户的需求描述，包括功能、目标用户等信息",
        },
        framework: {
          type: "string",
          description: "目标框架，如 react、vue、html",
        },
        skills: {
          type: "string",
          description: "已选择的技能列表（JSON 数组），为空表示无特殊技能",
        },
      },
      required: ["requirements", "framework"],
    },
  },
};

async function planAppStructureExecute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<string> {
  const requirements = (args.requirements as string) || "";
  const framework = (args.framework as string) || "react";
  const skills = (args.skills as string) || "[]";

  if (!requirements.trim()) {
    return "Error: requirements is required";
  }

  // Note: This tool is designed to be called by the LLM within the ReAct loop.
  // The LLM itself generates the plan content. This function provides context
  // that helps the LLM produce a better plan.
  return JSON.stringify({
    context: {
      requirements,
      framework,
      skills: JSON.parse(skills),
      guidance: {
        react: {
          default_structure: [
            "src/App.tsx — 主应用组件",
            "src/main.tsx — 入口文件",
            "src/index.css — 全局样式",
            "index.html — HTML 模板",
            "package.json — 项目配置",
            "tsconfig.json — TypeScript 配置",
            "vite.config.ts — Vite 构建配置",
          ],
          patterns: [
            "使用函数组件 + Hooks",
            "组件文件放在 src/components/ 下",
            "类型定义放在 src/types/ 或内联",
            "使用 CSS Modules 或 Tailwind CSS",
            "状态管理用 React Context 或 Zustand",
          ],
        },
        vue: {
          default_structure: [
            "src/App.vue — 主应用组件",
            "src/main.ts — 入口文件",
            "src/style.css — 全局样式",
            "index.html — HTML 模板",
            "package.json — 项目配置",
            "tsconfig.json — TypeScript 配置",
            "vite.config.ts — Vite 构建配置",
          ],
          patterns: [
            "使用 Composition API (<script setup lang='ts'>)",
            "组件文件放在 src/components/ 下",
            "使用 <style scoped> 进行样式隔离",
          ],
        },
        html: {
          default_structure: [
            "index.html — 主页面（包含内联 CSS 和 JS）",
            "style.css — 全局样式",
            "app.js — 应用逻辑",
          ],
          patterns: [
            "使用语义化 HTML5 标签",
            "CSS 使用 CSS 变量和 Flexbox/Grid 布局",
            "JavaScript 使用原生 ES6+ 语法",
          ],
        },
      },
    },
    instruction:
      "请根据以上上下文，为这个应用设计完整的文件树结构。输出应为 JSON 格式：{ files: [{ path, language, description }], reasoning: string }。确保覆盖所有必要的文件，包括组件、样式、配置等。",
  });
}

// ---------------------------------------------------------------------------
// 2. generate_file — Generate a single source file
// ---------------------------------------------------------------------------

const generateFileDef: ToolDefinition = {
  type: "function",
  function: {
    name: "generate_file",
    description:
      "生成单个源文件的完整代码。根据文件路径、语言类型和详细规格生成高质量代码。支持 TypeScript/JavaScript/React JSX/Vue SFC/CSS/HTML/JSON 等。生成代码应完整可运行，包含必要的导入和类型注解。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "文件在项目中的路径，如 'src/App.tsx'、'src/components/Button.tsx'、'src/index.css'",
        },
        language: {
          type: "string",
          description: "文件语言类型: tsx, ts, css, html, json, js, vue",
          enum: ["tsx", "ts", "css", "html", "json", "js", "vue"],
        },
        specification: {
          type: "string",
          description:
            "该文件的详细规格说明，包括功能需求、组件接口、样式要求、特殊注意事项",
        },
        framework: {
          type: "string",
          description: "目标框架: react, vue, html",
        },
      },
      required: ["path", "language", "specification", "framework"],
    },
  },
};

async function generateFileExecute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<string> {
  const path = (args.path as string) || "";
  const language = (args.language as string) || "tsx";
  const specification = (args.specification as string) || "";
  const framework = (args.framework as string) || "react";

  if (!path.trim()) return "Error: path is required";
  if (!specification.trim()) return "Error: specification is required";

  // Return context for the LLM — the actual code generation happens in the ReAct loop
  // The LLM sees this tool result and generates the code in its response
  return JSON.stringify({
    status: "ready_to_generate",
    context: {
      path,
      language,
      framework,
      specification,
      guidelines: {
        tsx: [
          "使用 TypeScript 严格模式，为所有 props 定义接口",
          "使用函数组件 + React Hooks",
          "组件名使用 PascalCase",
          "导出方式：默认导出组件，命名导出类型",
          "包含必要的 React 导入",
          "可访问性：添加 aria-label、role 等属性",
          `在组件根元素添加 data-af-id 属性，值为组件名（如 data-af-id="Button"）`,
        ],
        ts: [
          "使用 TypeScript 严格模式",
          "导出类型和接口",
          "使用 const 断言和 as const 模式",
          "包含 JSDoc 注释",
        ],
        css: [
          "使用 CSS 变量定义主题色",
          "使用 rem/em 相对单位",
          "响应式设计：移动优先",
          "布局使用 Flexbox/Grid",
          "添加过渡动画提升交互体验",
        ],
        html: [
          "使用语义化 HTML5 标签",
          "包含 viewport meta 标签",
          "使用 CSS 变量定义主题",
        ],
        json: ["严格 JSON 格式", "添加注释说明配置项（如格式支持）"],
        js: [
          "使用 ES6+ 语法（const/let、箭头函数、模板字符串）",
          "使用 JSDoc 注释",
          "避免使用 var",
        ],
        vue: [
          "使用 Composition API + <script setup lang='ts'>",
          "Props 和 Emits 使用 defineProps/defineEmits 带类型",
          "使用 <style scoped> 进行样式隔离",
        ],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 3. review_code — Self-review generated code
// ---------------------------------------------------------------------------

const reviewCodeDef: ToolDefinition = {
  type: "function",
  function: {
    name: "review_code",
    description:
      "审阅已生成代码的质量、正确性、可访问性和最佳实践。返回问题列表和改进建议。在生成所有文件后调用此工具进行质量检查。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要审阅的文件路径",
        },
        code: {
          type: "string",
          description: "要审阅的代码内容",
        },
        language: {
          type: "string",
          description: "文件语言类型",
        },
      },
      required: ["path", "code", "language"],
    },
  },
};

async function reviewCodeExecute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<string> {
  const path = (args.path as string) || "";
  const code = (args.code as string) || "";
  const language = (args.language as string) || "tsx";

  if (!code.trim())
    return JSON.stringify({
      passes: true,
      issues: [],
      summary: "空文件，无需审阅",
    });

  // Provide review guidance context — the LLM performs the actual review
  return JSON.stringify({
    path,
    language,
    code_length: code.length,
    review_criteria: {
      correctness: "代码逻辑是否正确，是否会产生运行时错误",
      completeness: "是否缺少必要的导入、类型定义、错误处理",
      best_practices: `是否遵循 ${language} 的最佳实践和惯用写法`,
      accessibility: "是否包含必要的 ARIA 属性、语义化标签",
      performance: "是否存在不必要的重渲染、内存泄漏风险",
      security: "是否存在 XSS、注入等安全风险",
      typescript: language.includes("ts")
        ? "类型是否完整、准确，是否滥用 any"
        : null,
    },
    instruction:
      "请对以上代码进行全面审阅。输出 JSON 格式：{ path, issues: [{ severity, line?, message, suggestion? }], summary, passes: boolean }。对于通过审阅的代码，设置 passes: true 并给出正面总结。",
  });
}

// ---------------------------------------------------------------------------
// 4. modify_file — Targeted modification of an existing file
// ---------------------------------------------------------------------------

const modifyFileDef: ToolDefinition = {
  type: "function",
  function: {
    name: "modify_file",
    description:
      "对现有文件进行定向修改。根据用户指令精确修改代码的特定部分，保持其他部分不变。适用于对话式迭代修改场景。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要修改的文件路径",
        },
        current_code: {
          type: "string",
          description: "文件的当前完整内容",
        },
        instruction: {
          type: "string",
          description: "修改指令，描述需要变更的内容",
        },
        language: {
          type: "string",
          description: "文件语言类型",
        },
      },
      required: ["path", "current_code", "instruction", "language"],
    },
  },
};

async function modifyFileExecute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<string> {
  const path = (args.path as string) || "";
  const currentCode = (args.current_code as string) || "";
  const instruction = (args.instruction as string) || "";
  const language = (args.language as string) || "tsx";

  if (!currentCode.trim()) return "Error: current_code is required";
  if (!instruction.trim()) return "Error: instruction is required";

  return JSON.stringify({
    path,
    language,
    instruction,
    current_code_length: currentCode.length,
    guidance: [
      "保持不影响修改指令的代码完全不变",
      "仅修改指令描述的部分",
      "返回完整的修改后文件内容",
      "保持原有的代码风格和缩进",
      "不要添加未要求的额外功能",
    ],
    instruction_for_llm:
      "请根据修改指令，生成完整的修改后文件内容。输出 JSON 格式：{ path, new_code: string, diff_summary: string }。确保只修改指令描述的部分。",
  });
}

// ---------------------------------------------------------------------------
// Export all app-gen tools with risk levels and timeouts
// ---------------------------------------------------------------------------

export const appGenTools: RegisteredTool[] = [
  {
    definition: planAppStructureDef,
    execute: planAppStructureExecute,
    riskLevel: "safe",
    timeout: 10_000,
    requireApproval: false,
    category: "codegen",
    parallelizable: false,
  },
  {
    definition: generateFileDef,
    execute: generateFileExecute,
    riskLevel: "safe",
    timeout: 30_000,
    requireApproval: false,
    category: "codegen",
    parallelizable: false, // sequential generation for consistency
  },
  {
    definition: reviewCodeDef,
    execute: reviewCodeExecute,
    riskLevel: "safe",
    timeout: 15_000,
    requireApproval: false,
    category: "codegen",
    parallelizable: true,
  },
  {
    definition: modifyFileDef,
    execute: modifyFileExecute,
    riskLevel: "mutation",
    timeout: 30_000,
    requireApproval: false,
    category: "codegen",
    parallelizable: false,
  },
];
