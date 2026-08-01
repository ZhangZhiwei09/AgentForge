# Multi-Agent Development Pipeline

All non-trivial features follow a **5-stage gated pipeline** with four specialized agents. Each stage acts as a gate — the work cannot proceed until the current gate approves.

## Pipeline Flow

```
Architect ──→ Architecture Reviewer ──→ Code Agent ──→ Architect (Review) ──→ Professional Reviewer
   │              │                        │               │                        │
   │         CHANGES_REQUIRED          REWORK_REQUIRED  CHANGES_REQUIRED          APPROVED
   └──────────────┘                        └───────────────┘                        │
        (loop)             (loop)              (loop)                            ✅ Done
```

## Agent Mapping

| Stage | Role | Agent Type | Mode |
|-------|------|-----------|------|
| 1 | Architect | `principal-architect` | Design |
| 2 | Architecture Reviewer | `architecture-reviewer` | Review |
| 3 | Code Agent | `implementation-engineer` | Implement |
| 4 | Architect (Review) | `principal-architect` | Review |
| 5 | Professional Reviewer | `principal-code-reviewer` | Review |

---

## Stage 1: Architect (Design)

**Agent:** `principal-architect` (Design Mode)

**Input:** Feature requirements or task description.

**Output:** A design plan containing:
- Architecture decisions and trade-offs
- Component/file-level breakdown
- Data flow and API contracts
- Task decomposition with dependencies
- Risk analysis and mitigation

**Gate:** Output must be a complete, reviewable design document.

## Stage 2: Architecture Reviewer

**Agent:** `architecture-reviewer`

**Input:** Architect's design plan.

**Output:** A verdict:
- **APPROVED** → proceed to Stage 3 (Code Agent)
- **CHANGES_REQUIRED** → return to Stage 1 (Architect) with specific issues to address

**What it checks:** Design soundness, trade-off 合理性, consistency with existing architecture, scalability, security posture, and feasibility.

## Stage 3: Code Agent (Implementation)

**Agent:** `implementation-engineer`

**Input:** Approved design plan from Stage 2.

**Output:** Working code that faithfully implements the design. The implementation engineer does NOT redesign — it follows the plan exactly. If the plan has gaps, it flags them rather than improvising.

**Gate:** All planned files created/modified, tests pass, no architectural drift.

## Stage 4: Architect Review (Implementation Compliance)

**Agent:** `principal-architect` (Review Mode)

**Input:** The implemented code + the original approved design plan.

**Output:** A compliance verdict:
- **PASS** → proceed to Stage 5 (Professional Reviewer)
- **REWORK_REQUIRED** → return to Stage 3 (Code Agent) with specific deviations listed

**What it checks:** Does the code match the design? Are there unplanned architectural changes? Did any design assumptions break during implementation?

## Stage 5: Professional Reviewer (Code Quality)

**Agent:** `principal-code-reviewer`

**Input:** The implemented code.

**Output:** A structured review with issues classified as:
- **P0 (Blocking):** Must fix before merge — correctness, security, data loss
- **P1 (Must Fix):** Should fix — reliability, performance, maintainability
- **P2 (Suggestion):** Nice to have — readability, style, minor optimizations

**Gate:**
- **APPROVED** (no P0 issues) → ✅ Task complete, ready to merge
- **CHANGES_REQUIRED** (P0 issues present) → return to Stage 3 (Code Agent)

---

## When to Use

### Full Pipeline

Use the full pipeline for:
- New features (new routes, services, components)
- Significant refactoring (changes spanning 3+ files)
- API design changes
- Database schema changes

### Skip to Stage 3

Skip directly to implementation for:
- Bug fixes with clear root cause
- Small, well-defined changes following existing patterns
- Configuration updates
- Documentation changes
