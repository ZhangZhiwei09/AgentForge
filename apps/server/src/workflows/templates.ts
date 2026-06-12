// Built-in Workflow Templates — 3 production-ready workflow definitions
// Users can instantiate these via POST /api/workflows/templates/:id/instantiate
import type { WorkflowDefinition } from "@agentforge/shared-types";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  definition: WorkflowDefinition;
}

// ---- Template 1: Content Summarizer ----

const contentSummarizer: WorkflowTemplate = {
  id: "content-summarizer",
  name: "Content Summarizer",
  description:
    "多源内容聚合并生成结构化摘要。输入 URL 列表，输出包含关键主题、摘要和矛盾点的综合报告。",
  category: "content",
  definition: {
    name: "Content Summarizer",
    version: "1.0",
    description: "从多个 URL 抓取内容，逐一摘要，最后综合为结构化报告",
    variables: {
      source_urls: {
        type: "array",
        required: true,
        description: "要摘要的 URL 列表",
      },
      language: {
        type: "string",
        default: "zh",
        description: "输出语言",
      },
    },
    steps: [
      {
        id: "fetch_all",
        type: "tool",
        tool: "web_fetch",
        args: {
          url: "{{source_urls}}",
        },
        output_as: "raw_contents",
      },
      {
        id: "summarize_each",
        type: "agent",
        prompt:
          "Summarize each article in 2-3 sentences. Language: {{language}}.\n\nArticles: {{raw_contents}}",
        model: "gpt-4o-mini",
        output_as: "summaries",
      },
      {
        id: "synthesize",
        type: "agent",
        prompt: `Synthesize the following summaries into a coherent overview. Identify common themes and contradictions.

Summaries: {{summaries}}

Format as markdown with:
## Key Themes
## Detailed Summary
## Contradictions (if any)`,
        output_as: "final_report",
      },
    ],
    on_failure: "stop",
  },
};

// ---- Template 2: Data Analysis Pipeline ----

const dataAnalysis: WorkflowTemplate = {
  id: "data-analysis",
  name: "Data Analysis Pipeline",
  description:
    "数据分析流水线：采集 → 清洗 → 分析 → 生成报告。自动处理原始数据并输出专业报告。",
  category: "analysis",
  definition: {
    name: "Data Analysis Pipeline",
    version: "1.0",
    description: "从数据源获取数据，清洗结构化，回答分析问题，生成专业报告",
    variables: {
      data_source: {
        type: "string",
        required: true,
        description: "数据源 URL 或文件路径",
      },
      analysis_question: {
        type: "string",
        required: true,
        description: "要回答的分析问题",
      },
    },
    steps: [
      {
        id: "fetch_data",
        type: "tool",
        tool: "web_fetch",
        args: { url: "{{data_source}}" },
        output_as: "raw_data",
      },
      {
        id: "clean_data",
        type: "agent",
        prompt:
          "Clean and structure the following data into a CSV-like format. Remove noise, handle missing values, and normalize.\n\nData: {{raw_data}}",
        output_as: "clean_data",
      },
      {
        id: "analyze",
        type: "agent",
        prompt:
          "Analyze the data to answer: {{analysis_question}}\n\nData: {{clean_data}}\n\nProvide statistical insights, trends, and patterns. Include specific numbers.",
        output_as: "analysis",
      },
      {
        id: "generate_report",
        type: "agent",
        prompt: `Generate a professional data analysis report in markdown.

Question: {{analysis_question}}
Analysis: {{analysis}}

Include:
## Executive Summary
## Methodology
## Key Findings
## Recommendations
## Appendix (data highlights)`,
        output_as: "report",
      },
    ],
    on_failure: "stop",
  },
};

// ---- Template 3: Code Review ----

const codeReview: WorkflowTemplate = {
  id: "code-review",
  name: "Automated Code Review",
  description:
    "多维度代码审查：安全、性能、可维护性并行检查，输出综合审计报告。",
  category: "engineering",
  definition: {
    name: "Automated Code Review",
    version: "1.0",
    description: "并行审查代码的安全性、性能和可维护性，生成综合报告",
    variables: {
      code: {
        type: "string",
        required: true,
        description: "待审查的源代码",
      },
      language: {
        type: "string",
        default: "typescript",
        description: "编程语言",
      },
    },
    steps: [
      {
        id: "parallel_review",
        type: "parallel",
        wait: "all",
        branches: [
          {
            id: "security_review",
            label: "Security",
            steps: [
              {
                id: "check_security",
                type: "agent",
                prompt: `Review the following {{language}} code for security vulnerabilities. Look for:
- SQL injection / NoSQL injection
- Cross-site scripting (XSS)
- Authentication/authorization issues
- Sensitive data exposure
- Insecure dependencies or configurations

CODE:
\`\`\`{{language}}
{{code}}
\`\`\`

Output findings as a list, each with: severity (Critical/High/Medium/Low), description, location, and fix suggestion.`,
                output_as: "security_findings",
              },
            ],
          },
          {
            id: "performance_review",
            label: "Performance",
            steps: [
              {
                id: "check_perf",
                type: "agent",
                prompt: `Review for performance issues:
- N+1 queries or excessive database calls
- Memory leaks or unnecessary allocations
- Blocking operations in async contexts
- Missing caching opportunities
- Inefficient algorithms or data structures

CODE:
\`\`\`{{language}}
{{code}}
\`\`\`

Output findings as a list, each with: severity (Critical/High/Medium/Low), description, location, and optimization suggestion.`,
                output_as: "perf_findings",
              },
            ],
          },
          {
            id: "maintainability_review",
            label: "Maintainability",
            steps: [
              {
                id: "check_maint",
                type: "agent",
                prompt: `Review for maintainability issues:
- Poor naming conventions
- High coupling / low cohesion
- SOLID principle violations
- Missing error handling
- Overly complex functions or classes
- Duplicate or dead code

CODE:
\`\`\`{{language}}
{{code}}
\`\`\`

Output findings as a list, each with: severity (Critical/High/Medium/Low), description, location, and improvement suggestion.`,
                output_as: "maint_findings",
              },
            ],
          },
        ],
      },
      {
        id: "synthesize_review",
        type: "agent",
        prompt: `Synthesize the following review findings into a single code review report:

## Security Findings
{{security_findings}}

## Performance Findings
{{perf_findings}}

## Maintainability Findings
{{maint_findings}}

Create a comprehensive report:
## Overall Assessment
## Critical Issues (must fix)
## High Priority Issues
## Medium/Low Priority Issues
## Summary by Category

Prioritize by severity: Critical > High > Medium > Low.`,
        output_as: "review_report",
        depends_on: ["parallel_review"],
      },
    ],
    on_failure: "stop",
  },
};

// ---- Export all templates ----

export const builtinTemplates: WorkflowTemplate[] = [
  contentSummarizer,
  dataAnalysis,
  codeReview,
];

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return builtinTemplates.find((t) => t.id === id);
}

export function listTemplates(): WorkflowTemplate[] {
  return builtinTemplates.map((t) => ({
    ...t,
  }));
}
