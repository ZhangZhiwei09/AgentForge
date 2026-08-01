# Identity Diagnosis Agent Spec

> **⚠️ 架构已变更（2026-07）**: 此 Spec 描述的是独立 LangGraph 端点方案。实际实现已改为 DIAGNOSIS 作为 Agent Runtime 的第 5 条路由（`DiagnosisRouteAgent`），通过主链路 `AgentRuntimeService → Router → DiagnosisRouteAgent` 执行，不再使用 LangGraph。详见 `docs/architecture/routing.md`。
>
> 以下为原始 Spec，保留作为设计参考。

## Goal

Build an independent LangGraph-based diagnosis endpoint for identity verification troubleshooting. *(注：LangGraph 方案已废弃，见 ADR-001)*

The first version reduces repeated manual frontend troubleshooting by turning user questions into a controlled workflow:

1. Extract structured business fields.
2. Ask for missing fields before diagnosis.
3. Retrieve knowledge base evidence.
4. Call mock monitoring tools when diagnosis needs runtime data.
5. Generate a standard diagnosis template.

## Entry Point

```http
POST /api/diagnosis/query
```

Request:

```json
{
  "query": "商户 10086 今天上午活体通过率下降，帮忙排查",
  "kbIds": ["optional-kb-id"]
}
```

Response includes:

- `intent`
- `status`
- `entities`
- `missingFields`
- `evidence`
- `toolResults`
- `answer`
- `warnings`

## MVP Scenarios

### Error Code Explanation

Input:

```text
FACE_TIMEOUT 是什么原因，怎么处理？
```

Expected:

- `intent = error_code_explanation`
- Knowledge retrieval is executed.
- Monitoring tools are not called.
- Answer includes cause, next steps, and document citations.

### Single Trace Diagnosis

Input:

```text
traceId abc123 用户刷脸失败，帮忙看下
```

Expected:

- `intent = single_trace_diagnosis`
- `traceId = abc123`
- Trace mock tool is called.
- Answer includes failure stage, error code, evidence, and next steps.

### Merchant Rate Drop Diagnosis

Input:

```text
商户 10086 今天上午活体通过率下降，帮忙排查
```

Expected:

- `intent = merchant_rate_drop`
- `merchantId = 10086`
- `timeRange = 今天上午`
- Merchant metrics mock tool is called.
- Answer includes success rate, baseline, top errors, and recommended actions.

### Missing Information

Input:

```text
核身失败了，帮忙看下
```

Expected:

- `status = needs_clarification`
- `missingFields` is not empty.
- Knowledge retrieval is not executed.
- Monitoring tools are not called.
- Answer asks for merchant ID, time range, trace/order ID, or error code.

## Boundaries

This version does not include:

- Neo4j.
- Real monitoring or log platform integration.
- Complex graph RAG.
- Multi-turn memory.
- Frontend UI.
- Production authorization changes.

This version includes:

- Independent diagnosis route.
- LangGraph workflow.
- Rule-first intent and entity extraction.
- Mock monitoring tools.
- RAG adapter through existing `KnowledgeService`.
- Regression tests for the MVP paths.

## Validation

Run:

```bash
pnpm --filter @agentforge/server typecheck
pnpm --filter @agentforge/server test
```

Manual API checks:

```bash
curl -X POST http://localhost:8000/api/diagnosis/query \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"FACE_TIMEOUT 是什么原因，怎么处理？\"}"
```

```bash
curl -X POST http://localhost:8000/api/diagnosis/query \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"核身失败了，帮忙看下\"}"
```

```bash
curl -X POST http://localhost:8000/api/diagnosis/query \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"traceId abc123 用户刷脸失败，帮忙看下\"}"
```

```bash
curl -X POST http://localhost:8000/api/diagnosis/query \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"商户 10086 今天上午活体通过率下降，帮忙排查\"}"
```

