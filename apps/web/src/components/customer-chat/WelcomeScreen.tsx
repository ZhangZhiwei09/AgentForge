import {
  MessageCircle,
  ShoppingBag,
  Truck,
  Headphones,
  UserCheck,
  CreditCard,
} from "lucide-react";

interface FAQTopic {
  icon: React.ReactNode;
  title: string;
  questions: string[];
  color: string;
}

const FAQ_TOPICS: FAQTopic[] = [
  {
    icon: <ShoppingBag className="h-5 w-5" />,
    title: "退换货政策",
    questions: ["如何申请退货？", "退货需要多长时间？", "什么情况不能退货？"],
    color: "bg-blue-50 text-blue-600 border-blue-200",
  },
  {
    icon: <Truck className="h-5 w-5" />,
    title: "物流配送",
    questions: ["几天能收到货？", "如何查询物流？", "全国都包邮吗？"],
    color: "bg-green-50 text-green-600 border-green-200",
  },
  {
    icon: <Headphones className="h-5 w-5" />,
    title: "售后服务",
    questions: ["客服工作时间？", "如何投诉建议？", "售后流程是什么？"],
    color: "bg-purple-50 text-purple-600 border-purple-200",
  },
  {
    icon: <UserCheck className="h-5 w-5" />,
    title: "会员权益",
    questions: ["会员等级有哪些？", "积分怎么使用？", "如何升级会员？"],
    color: "bg-amber-50 text-amber-600 border-amber-200",
  },
  {
    icon: <CreditCard className="h-5 w-5" />,
    title: "支付方式",
    questions: ["支持哪些支付方式？", "可以分期付款吗？", "支付失败怎么办？"],
    color: "bg-red-50 text-red-600 border-red-200",
  },
];

interface WelcomeScreenProps {
  onSend: (message: string) => void;
}

export function WelcomeScreen({ onSend }: WelcomeScreenProps) {
  return (
    <div className="flex flex-col items-center justify-center px-3 sm:px-6 py-6 sm:py-12 animate-fade-in">
      {/* 头部 */}
      <div className="flex h-12 w-12 sm:h-16 sm:w-16 items-center justify-center rounded-2xl bg-[hsl(var(--cs-primary))] shadow-lg mb-3 sm:mb-5">
        <MessageCircle className="h-6 w-6 sm:h-8 sm:w-8 text-white" />
      </div>
      <h2 className="text-lg sm:text-xl font-bold text-[hsl(var(--foreground))] mb-1 text-center">
        您好，欢迎来到智能客服中心
      </h2>
      <p className="text-xs sm:text-sm text-[hsl(var(--muted-foreground))] mb-4 sm:mb-8 text-center">
        请选择您想咨询的问题类型，或直接输入您的问题
      </p>

      {/* FAQ 话题卡片 */}
      <div className="grid w-full max-w-2xl grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-3">
        {FAQ_TOPICS.map((topic) => (
          <div
            key={topic.title}
            className={`rounded-xl border p-3 sm:p-4 transition-all duration-200 hover:shadow-md active:scale-[0.98] cursor-pointer ${topic.color}`}
          >
            <div className="flex items-center gap-2 mb-3">
              {topic.icon}
              <span className="text-sm font-semibold">{topic.title}</span>
            </div>
            <div className="space-y-1.5">
              {topic.questions.map((q) => (
                <button
                  key={q}
                  onClick={() => onSend(q)}
                  className="block w-full text-left text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors py-0.5"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-8 text-xs text-[hsl(var(--muted-foreground))]">
        客服工作时间：工作日 9:00 - 18:00
      </p>
    </div>
  );
}
