"""Reference-compatible built-in golden cases for smoke and local runs."""

from src.evaluation.types import EvalCase, ExpectedOutcome

GOLDEN_DATASET: tuple[EvalCase, ...] = (
    EvalCase(
        id="chitchat-hello",
        suite="routing",
        question="你好",
        expected=ExpectedOutcome(
            intent="chitchat",
            forbid_retrieve=True,
            forbid_graph=True,
            forbid_web=True,
            judge_groundedness=False,
        ),
    ),
    EvalCase(
        id="kb-travel-signoff",
        suite="kb-hit",
        question="出差预估费用超过五千谁还要加签？",
        expected=ExpectedOutcome(
            intent="kb",
            require_retrieve=True,
            forbid_web=True,
            relevant_doc_titles=["差旅"],
            key_points=["张敏", "加签"],
        ),
    ),
    EvalCase(
        id="kb-overtime-meal",
        suite="rewrite",
        question="加班餐补怎么报、标准是多少？",
        expected=ExpectedOutcome(
            intent="kb",
            require_retrieve=True,
            forbid_web=True,
            expect_rewrite=True,
            relevant_doc_titles=[],
        ),
    ),
    EvalCase(
        id="kb-annual-party",
        suite="kb-empty",
        question="公司年会抽奖规则是什么？",
        expected=ExpectedOutcome(
            intent="kb",
            require_retrieve=True,
            forbid_web=True,
            expect_refusal=True,
            relevant_doc_titles=[],
        ),
    ),
    EvalCase(
        id="web-fx",
        suite="web",
        question="今天人民币兑美元汇率",
        expected=ExpectedOutcome(
            intent="web",
            require_web=True,
            forbid_retrieve=True,
            forbid_graph=True,
            judge_groundedness=False,
        ),
    ),
    EvalCase(
        id="kb-vpn-account",
        suite="kb-hit",
        question="VPN 连不上先查什么，账号开通找谁？",
        expected=ExpectedOutcome(
            intent="kb",
            require_retrieve=True,
            forbid_web=True,
            relevant_doc_titles=["信息安全"],
            key_points=["张伟"],
        ),
    ),
    EvalCase(
        id="kb-release-window",
        suite="kb-hit",
        question="知识库上线怎么做灰度？谁负责窗口？",
        expected=ExpectedOutcome(
            intent="kb",
            require_retrieve=True,
            forbid_web=True,
            relevant_doc_titles=["生产环境变更", "发布"],
            key_points=["李明"],
            must_not_contain=["王芳"],
        ),
    ),
    EvalCase(
        id="kb-intern-defense",
        suite="kb-empty",
        question="实习生转正答辩要交哪些材料？",
        expected=ExpectedOutcome(
            intent="kb",
            require_retrieve=True,
            forbid_web=True,
            expect_refusal=True,
            relevant_doc_titles=[],
        ),
    ),
    EvalCase(
        id="kb-not-profile",
        suite="routing",
        question="预算审核员属于哪个部门",
        expected=ExpectedOutcome(
            intent="kb",
            require_retrieve=True,
        ),
    ),
)


def golden_cases() -> list[EvalCase]:
    return [case.model_copy(deep=True) for case in GOLDEN_DATASET]
