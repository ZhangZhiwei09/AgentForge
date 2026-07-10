// ── 订单卡片 ──
// 展示订单信息：订单号、状态、商品列表、合计、物流

import { Package, Truck, ChevronRight } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";
import type { OrderCardData } from "@agentforge/shared-types";

// ── CVA ──

const cardVariants = cva(
  "my-2 rounded-xl border border-slate-200 bg-white shadow-sm",
  {
    variants: {
      intent: {
        default: "p-4",
        compact: "p-3",
      },
    },
    defaultVariants: {
      intent: "default",
    },
  },
);

const statusBadgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
  {
    variants: {
      status: {
        pending: "bg-amber-100 text-amber-700",
        confirmed: "bg-blue-100 text-blue-700",
        shipped: "bg-indigo-100 text-indigo-700",
        delivered: "bg-green-100 text-green-700",
        cancelled: "bg-red-100 text-red-700",
        refunded: "bg-slate-100 text-slate-600",
      },
    },
    defaultVariants: {
      status: "pending",
    },
  },
);

type CardVariantProps = VariantProps<typeof cardVariants>;

// ── Props ──

interface Props extends CardVariantProps {
  data: OrderCardData;
  isStreaming?: boolean;
  onViewDetail?: (orderId: string) => void;
  className?: string;
}

// ── 骨架 ──

function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block animate-pulse rounded bg-slate-200", className)}
    >
      &nbsp;
    </span>
  );
}

// ── 组件 ──

export function OrderCard({
  data,
  intent,
  isStreaming,
  onViewDetail,
  className,
}: Props) {
  if (isStreaming && !data.orderId) {
    return (
      <div className={cn(cardVariants({ intent }), className)}>
        <div className="flex items-center gap-2 mb-3">
          <Skeleton className="w-5 h-5 rounded" />
          <Skeleton className="w-24 h-4" />
        </div>
        <Skeleton className="w-48 h-3 mb-2" />
        <Skeleton className="w-32 h-3 mb-2" />
        <Skeleton className="w-40 h-3" />
      </div>
    );
  }

  const statusKey = (data.status || "pending").toLowerCase();
  const validStatus = [
    "pending",
    "confirmed",
    "shipped",
    "delivered",
    "cancelled",
    "refunded",
  ].includes(statusKey)
    ? statusKey
    : "pending";

  return (
    <div className={cn(cardVariants({ intent }), className)}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-slate-500" />
          <span className="text-sm font-semibold text-slate-800">
            {data.orderId}
          </span>
        </div>
        <span className={statusBadgeVariants({ status: validStatus as StatusKey })}>
          {data.statusLabel}
        </span>
      </div>

      {/* Items */}
      <div className="mb-3 space-y-1.5">
        {data.items.map((item, i) => (
          <div key={i} className="flex justify-between text-xs text-slate-600">
            <span>
              {item.name} × {item.quantity}
            </span>
            <span className="font-medium text-slate-800">
              ¥{item.price.toFixed(2)}
            </span>
          </div>
        ))}
      </div>

      {/* Total */}
      <div className="flex justify-between border-t border-slate-100 pt-2 mb-2">
        <span className="text-xs font-medium text-slate-700">合计</span>
        <span className="text-sm font-bold text-slate-900">
          ¥{data.total.toFixed(2)}
        </span>
      </div>

      {/* Logistics (optional) */}
      {(data.carrier || data.trackingNo) && (
        <div className="flex items-center gap-1.5 text-[10px] text-slate-500 mb-2">
          <Truck className="h-3 w-3" />
          {data.carrier && <span>{data.carrier}</span>}
          {data.trackingNo && <span>· {data.trackingNo}</span>}
        </div>
      )}

      {data.estimatedDelivery && (
        <p className="text-[10px] text-slate-400 mb-2">
          预计送达：{data.estimatedDelivery}
        </p>
      )}

      {/* View Detail */}
      {onViewDetail && (
        <button
          onClick={() => onViewDetail(data.orderId)}
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors"
        >
          查看详情
          <ChevronRight className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

type StatusKey = "pending" | "confirmed" | "shipped" | "delivered" | "cancelled" | "refunded";

export default OrderCard;
