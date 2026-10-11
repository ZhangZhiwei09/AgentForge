import { classifyBusinessIntent } from "./routing/business-classifier.js";
import type { EntryDecision, EntryDecisionInput } from "./types.js";

function requestOutsideQuotes(message: string): string {
  return message
    .replace(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`/g, " ")
    .trim()
    .replace(/[\s!！。.,，?？;；]+$/, "");
}

export function explicitEntryControl(message: string): "human" | "cancel" | null {
  const request = requestOutsideQuotes(message);
  if (/^(?:请|麻烦)?(?:帮我)?(?:取消|停止|结束)(?:当前|这次|本次)?(?:的)?(?:排查|诊断)$/.test(request)) {
    return "cancel";
  }
  if (/^(?:请|麻烦)?(?:帮我|我要|我想)?(?:转(?:接)?人工(?:支持|客服)?|找人工(?:支持|客服)?|联系人工支持)$/.test(request)) {
    return "human";
  }
  return null;
}

function affirmativeDiagnosis(message: string): boolean {
  const request = requestOutsideQuotes(message);
  const clauses = request.split(/[，,。!！?？;；\n]/).map((part) => part.trim());
  const informationObject = /(?:文档|资料|知识|说明|含义|教程|步骤|流程|原理|规则|示例|案例)(?:在哪里|在哪|是什么|有哪些)?(?:就行|即可|就好|就可以|就够)?(?:了|吧|吗|啊|呀|啦|呢)?$/;
  const informationQuestion = /(?:是什么|什么意思|意味着什么|(?:怎么|如何)(?:做|操作|使用|配置|排查|诊断|理解)|有哪些(?:步骤|流程|方法))/;
  // Match the request's purpose and negation target, rather than words inside service names.
  if (clauses.some((clause) =>
    /(?:不要|不用|无需|不需要|不想|不打算|别)(?:再|继续|进行|帮我|帮忙|做)?(?:排查|诊断|定位|查(?:一下|下|一查)?(?:这次|本次|当前)?(?:故障|原因|日志|监控|链路|trace))/i.test(clause)
    || (/^(?:请|麻烦)?(?:帮我|帮忙|(?:我)?(?:只是|只|仅)?(?:想|需要|要)?)?(?:了解|知道|解释|查看|看看|看|查询|查阅|查(?:一下|下|一查)?|找|学习|阅读)/.test(clause)
      && informationObject.test(clause)),
  )) return false;
  return clauses.some((clause) => {
    if (informationObject.test(clause) || informationQuestion.test(clause)) {
      return false;
    }
    if (/^(?:请|麻烦)?(?:帮我|帮忙|协助我|我想|我要|我需要|我想要)?(?:排查|诊断|定位|查一下|查下|查一查)/.test(clause)
      || /^(?:请|麻烦)?(?:帮我|帮忙)查/.test(clause)) {
      return true;
    }
    // A direct fault statement must be affirmative; arbitrary text between subject and fault is not trusted.
    return /^(?:我|我们|这个用户|该用户|某用户|本次请求|这次请求)(?:的)?(?:登录|认证|核身|刷脸|页面|接口|请求|服务|摄像头|SDK|sdk|网络|操作)(?:现在|刚才|一直|又|出现|发生|遇到|时){0,2}(?:失败|报错|超时|白屏|闪退|打不开|异常)/.test(clause);
  });
}

export async function decideEntry(input: EntryDecisionInput): Promise<EntryDecision> {
  input.signal?.throwIfAborted();
  if (input.safetyDecision) {
    return {
      action: "dispatch", route: "SAFETY", source: "safety_rule",
      reasoning: input.safetyDecision.reasoning,
    };
  }
  const control = explicitEntryControl(input.message);
  if (control === "human") {
    return {
      action: "dispatch", route: "HUMAN", source: "control_rule",
      reasoning: "明确请求人工支持",
    };
  }
  if (control === "cancel") {
    const cancelled = input.waitingDiagnosis && await input.cancelWaitingDiagnosis();
    input.signal?.throwIfAborted();
    return {
      action: "reply", source: "control_rule", reasoning: "取消等待补充的排查",
      answer: cancelled ? "已取消当前等待补充的排查。" : "当前没有可取消的等待排查。",
      suggestions: [],
    };
  }
  if (input.waitingDiagnosis) {
    return {
      action: "dispatch", route: "DIAGNOSIS", businessIntent: "diagnosis",
      source: "session_state", reasoning: "等待补充的配置诊断续跑",
    };
  }
  const configured = await input.loadEntryResult();
  input.signal?.throwIfAborted();
  if (configured?.action === "reply") {
    return { ...configured, source: "entry_flow", reasoning: "一级流程固定回复" };
  }
  if (configured?.action === "route") {
    if (configured.target === "HUMAN"
      || (configured.target === "DIAGNOSIS" && !affirmativeDiagnosis(input.message))) {
      return {
        action: "unavailable", source: "entry_flow",
        reasoning: `配置 ${configured.target} 分流缺少明确请求，请管理员检查匹配条件`,
        answer: "入口配置与当前请求不一致，暂时无法处理。请联系管理员检查流程配置。",
        suggestions: [],
      };
    }
    return {
      action: "dispatch", route: configured.target, handoff: configured.handoff,
      source: "entry_flow", reasoning: "一级流程分流",
      businessIntent: configured.target === "TASK" ? "consultation"
        : configured.target === "DIAGNOSIS" ? "diagnosis" : undefined,
    };
  }
  // An explicit continue preserves the published flow's decision to skip shortcuts.
  if (!configured && input.conversationalReply) {
    return {
      action: "reply", ...input.conversationalReply,
      source: "conversational_rule", reasoning: "精确问候匹配",
    };
  }
  const classified = await (input.classify ?? classifyBusinessIntent)(
    input.message, input.history, input.modelId, input.trace,
  );
  input.signal?.throwIfAborted();
  if (classified.status === "unavailable") {
    return {
      action: "unavailable", source: "business_llm", reasoning: classified.reason,
      answer: "意图识别服务暂时不可用，请稍后重试。",
      suggestions: [],
    };
  }
  const result = classified.result;
  if (result.intent === "unclear") {
    return {
      action: "clarify", source: "business_llm", reasoning: result.reasoning,
      answer: result.clarification, suggestions: [],
    };
  }
  return {
    action: "dispatch", source: "business_llm", reasoning: result.reasoning,
    route: result.intent === "consultation" ? "TASK" : "DIAGNOSIS",
    businessIntent: result.intent, resolvedQuery: result.resolvedQuery,
  };
}
