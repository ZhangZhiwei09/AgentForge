// 客服意图识别服务 —— 基于关键词匹配的分类器
// V1 使用正则匹配，无需 LLM 调用，零延迟、零成本
// 后续可升级为 LLM-based 分类（调用小模型如 gpt-4o-mini）

const INTENT_PATTERNS: Record<string, RegExp> = {
  "退货退款": /退货|退款|换货|退钱|退换|退单|取消订单|订单取消/,
  "物流查询": /物流|快递|发货|运单|配送|送到|送货|邮寄|包裹|签收|没收到|还没到/,
  "售后联系": /投诉|客服|电话|联系|反馈|热线|人工|找你们/,
  "账户会员": /会员|积分|等级|注册|账号|密码|登录|绑定|修改.*信息|个人信息/,
  "支付订单": /支付|付款|订单|优惠券|分期|发票|收据|价钱|价格|多少钱|怎么买/,
};

export interface IntentResult {
  intent: string;
  confidence: number; // 0.0 ~ 1.0
}

export class IntentDetector {
  /**
   * 检测用户消息的意图分类
   * 如果匹配到多个，返回匹配关键词数最多的那个
   * 如果没有匹配，返回 "其他咨询"
   */
  detect(message: string): IntentResult {
    let bestIntent = "其他咨询";
    let bestScore = 0;

    for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
      const matches = message.match(pattern);
      if (matches) {
        // 匹配到的关键词越多，置信度越高
        const score = matches.length;
        if (score > bestScore) {
          bestScore = score;
          bestIntent = intent;
        }
      }
    }

    // 置信度：1 个关键词匹配 = 0.7, 2+ = 0.85+
    const confidence = bestIntent === "其他咨询" ? 0.0 : Math.min(0.7 + (bestScore - 1) * 0.15, 1.0);

    return { intent: bestIntent, confidence };
  }

  /** 列出所有支持的意图分类 */
  listIntents(): string[] {
    return Object.keys(INTENT_PATTERNS);
  }
}

// 单例
export const intentDetector = new IntentDetector();
