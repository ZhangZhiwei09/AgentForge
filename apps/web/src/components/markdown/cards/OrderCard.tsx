// ── 订单卡片 ──
// 展示订单摘要：状态标签、商品列表、物流信息、操作按钮

import { Package, Truck, Clock } from "lucide-react";
import type { OrderCardData } from "@agentforge/shared-types";

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> =
  {
    pending: { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-400" },
    paid: { bg: "bg-blue-50", text: "text-blue-700", dot: "bg-blue-400" },
    shipped: {
      bg: "bg-indigo-50",
      text: "text-indigo-700",
      dot: "bg-indigo-400",
    },
    delivered: {
      bg: "bg-green-50",
      text: "text-green-700",
      dot: "bg-green-400",
    },
    cancelled: { bg: "bg-red-50", text: "text-red-700", dot: "bg-red-400" },
    returned: {
      bg: "bg-orange-50",
      text: "text-orange-700",
      dot: "bg-orange-400",
    },
    refunded: {
      bg: "bg-purple-50",
      text: "text-purple-700",
      dot: "bg-purple-400",
    },
  };

const defaultStatus = {
  bg: "bg-gray-50",
  text: "text-gray-600",
  dot: "bg-gray-300",
};

interface Props {
  data: OrderCardData;
}

export function OrderCard({ data }: Props) {
  const colors = STATUS_COLORS[data.status] ?? defaultStatus;

  return (
    <div className="my-2 rounded-xl border border-[hsl(var(--border))] bg-white shadow-sm overflow-hidden">
      {/* 头部：订单号 + 状态 */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50/50">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-gray-500" />
          <span className="text-xs font-medium text-gray-600">订单</span>
          <span className="text-xs font-mono text-gray-800">
            {data.orderId}
          </span>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${colors.bg} ${colors.text}`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${colors.dot}`}
          />
          {data.statusLabel}
        </span>
      </div>

      {/* 商品列表 */}
      <div className="px-4 py-2 border-t border-gray-100">
        {data.items.map((item, i) => (
          <div
            key={i}
            className="flex items-center justify-between py-1.5 text-xs"
          >
            <span className="text-gray-700">{item.name}</span>
            <span className="text-gray-500">
              ×{item.quantity} ¥{item.price.toFixed(2)}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between py-2 border-t border-gray-100 mt-1">
          <span className="text-xs font-medium text-gray-700">合计</span>
          <span className="text-sm font-semibold text-gray-900">
            ¥{data.total.toFixed(2)}
          </span>
        </div>
      </div>

      {/* 物流信息（如有） */}
      {(data.carrier || data.trackingNo || data.estimatedDelivery) && (
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50/30 space-y-1">
          {data.carrier && (
            <div className="flex items-center gap-1.5 text-xs text-gray-600">
              <Truck className="h-3 w-3" />
              <span>{data.carrier}</span>
              {data.trackingNo && (
                <span className="font-mono text-gray-500">
                  · {data.trackingNo}
                </span>
              )}
            </div>
          )}
          {data.estimatedDelivery && (
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <Clock className="h-3 w-3" />
              <span>预计送达：{data.estimatedDelivery}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
