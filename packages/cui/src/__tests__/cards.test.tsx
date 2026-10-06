import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActionCard } from "../cards/ActionCard";
import { OrderCard } from "../cards/OrderCard";
import { PolicyCard } from "../cards/PolicyCard";
import { StatusCard } from "../cards/StatusCard";
import { TableCard } from "../cards/TableCard";
import { DiagnosisCard } from "../cards/DiagnosisCard";
import type {
  ActionCardData,
  OrderCardData,
  PolicyCardData,
  StatusCardData,
  TableBlockData,
  DiagnosisProgress,
} from "@agentforge/shared-types";

describe("ActionCard", () => {
  const basicData: ActionCardData = {
    title: "您可能需要",
    description: "请选择操作",
    actions: [
      { label: "查询订单", action: "lookup_order" },
      { label: "联系客服", action: "contact_support", style: "secondary" },
    ],
  };

  it("renders title and description", () => {
    render(<ActionCard data={basicData} />);
    expect(screen.getByText("您可能需要")).toBeInTheDocument();
    expect(screen.getByText("请选择操作")).toBeInTheDocument();
  });

  it("renders action buttons", () => {
    render(<ActionCard data={basicData} />);
    expect(screen.getByText("查询订单")).toBeInTheDocument();
    expect(screen.getByText("联系客服")).toBeInTheDocument();
  });

  it("fires onAction callback", () => {
    const onAction = vi.fn();
    render(<ActionCard data={basicData} onAction={onAction} />);
    fireEvent.click(screen.getByText("查询订单"));
    expect(onAction).toHaveBeenCalledWith("lookup_order", undefined);
  });

  it("renders skeleton in streaming mode", () => {
    const { container } = render(
      <ActionCard data={{ title: "", description: "", actions: [] }} isStreaming />,
    );
    // Skeleton elements should be present
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("applies custom className", () => {
    const { container } = render(
      <ActionCard data={basicData} className="custom-class" />,
    );
    expect(container.firstChild).toHaveClass("custom-class");
  });
});

describe("OrderCard", () => {
  const basicData: OrderCardData = {
    orderId: "ORD-001",
    status: "shipped",
    statusLabel: "已发货",
    items: [{ name: "商品A", quantity: 2, price: 99.0 }],
    total: 198.0,
    createdAt: "2026-06-01",
  };

  it("renders order ID and status", () => {
    render(<OrderCard data={basicData} />);
    expect(screen.getByText("ORD-001")).toBeInTheDocument();
    expect(screen.getByText("已发货")).toBeInTheDocument();
  });

  it("renders total price", () => {
    render(<OrderCard data={basicData} />);
    expect(screen.getByText("¥198.00")).toBeInTheDocument();
  });

  it("renders skeleton in streaming mode", () => {
    const { container } = render(
      <OrderCard
        data={{ orderId: "", status: "", statusLabel: "", items: [], total: 0, createdAt: "" }}
        isStreaming
      />,
    );
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });
});

describe("PolicyCard", () => {
  const basicData: PolicyCardData = {
    category: "退换货政策",
    title: "7天无理由退货",
    conditions: ["商品完好", "不影响二次销售"],
  };

  it("renders category and title", () => {
    render(<PolicyCard data={basicData} />);
    expect(screen.getByText("退换货政策")).toBeInTheDocument();
    expect(screen.getByText("7天无理由退货")).toBeInTheDocument();
  });

  it("renders conditions", () => {
    render(<PolicyCard data={basicData} />);
    expect(screen.getByText("商品完好")).toBeInTheDocument();
    expect(screen.getByText("不影响二次销售")).toBeInTheDocument();
  });

  it("renders skeleton in streaming mode", () => {
    const { container } = render(
      <PolicyCard data={{ category: "", title: "", conditions: [] }} isStreaming />,
    );
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });
});

describe("StatusCard", () => {
  const basicData: StatusCardData = {
    title: "物流追踪",
    status: "in_progress",
    message: "运输中",
    steps: [
      { label: "已揽收", status: "done" },
      { label: "运输中", status: "active" },
    ],
  };

  it("renders title", () => {
    render(<StatusCard data={basicData} />);
    expect(screen.getByText("物流追踪")).toBeInTheDocument();
  });

  it("renders steps", () => {
    render(<StatusCard data={basicData} />);
    expect(screen.getByText("已揽收")).toBeInTheDocument();
    // "运输中" appears both as step label and message text
    const transportElements = screen.getAllByText("运输中");
    expect(transportElements.length).toBeGreaterThanOrEqual(1);
  });

  it("renders skeleton in streaming mode", () => {
    const { container } = render(
      <StatusCard data={{ title: "", status: "pending" }} isStreaming />,
    );
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });
});

describe("TableCard", () => {
  const basicData: TableBlockData = {
    headers: ["类目", "价格"],
    rows: [
      ["电子产品", "¥99"],
      ["服装", "¥199"],
    ],
  };

  it("renders headers", () => {
    render(<TableCard data={basicData} />);
    expect(screen.getByText("类目")).toBeInTheDocument();
    expect(screen.getByText("价格")).toBeInTheDocument();
  });

  it("renders data cells", () => {
    render(<TableCard data={basicData} />);
    expect(screen.getByText("电子产品")).toBeInTheDocument();
    expect(screen.getByText("¥99")).toBeInTheDocument();
  });

  it("renders caption when provided", () => {
    render(<TableCard data={{ ...basicData, caption: "产品列表" }} />);
    expect(screen.getByText("产品列表")).toBeInTheDocument();
  });
});

describe("DiagnosisCard", () => {
  const basicData: DiagnosisProgress = {
    status: "running",
    phases: [
      { phase: 1, label: "前端排查", status: "done", summary: "发现问题" },
      { phase: 2, label: "后端排查", status: "running" },
      { phase: 3, label: "综合分析", status: "pending" },
    ],
  };

  it("renders diagnosis header", () => {
    render(<DiagnosisCard diagnosis={basicData} />);
    expect(screen.getByText("多 Agent 协同诊断")).toBeInTheDocument();
  });

  it("renders phase labels", () => {
    render(<DiagnosisCard diagnosis={basicData} />);
    expect(screen.getByText(/前端排查/)).toBeInTheDocument();
    expect(screen.getByText(/后端排查/)).toBeInTheDocument();
    expect(screen.getByText(/综合分析/)).toBeInTheDocument();
  });

  it("renders resolution when done", () => {
    const doneData: DiagnosisProgress = {
      status: "done",
      phases: [{ phase: 1, label: "前端排查", status: "done", summary: "OK" }],
      resolution: "frontend_only",
      finalConclusion: "前端即可解决",
    };
    render(<DiagnosisCard diagnosis={doneData} />);
    expect(screen.getByText("快速通道 — 仅完成前端排查")).toBeInTheDocument();
    expect(screen.getByText("前端即可解决")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const { container } = render(
      <DiagnosisCard diagnosis={basicData} className="custom" />,
    );
    expect(container.firstChild).toHaveClass("custom");
  });
});
