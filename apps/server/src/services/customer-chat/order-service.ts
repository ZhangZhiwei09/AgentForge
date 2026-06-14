// OrderService —— 客服订单模拟服务
//
// 替代 customer-service-tools.ts 中的硬编码 stub 数据。
// 基于文件持久化的 JSON 存储，支持：
//   - 多订单查询（按订单号、用户、物流单号）
//   - 退换货政策查询（按类目和原因）
//   - 客服工单创建（持久化记录）
//   - 物流状态追踪（含时间线）
//
// 设计原则：
//   - 所有操作异步，模拟真实 IO
//   - 数据文件不存在时自动初始化种子数据
//   - 错误场景返回结构化错误而非抛异常
//   - 提供缓存失效接口，供测试重置状态

import { randomUUID } from "crypto";
import { logger } from "@agentforge/logger";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

// ── 类型定义 ──

export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "processing"
  | "shipped"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "refunded";

export interface OrderItem {
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  image?: string;
}

export interface ShippingInfo {
  carrier: string;
  trackingNo: string;
  origin: string;
  destination: string;
  estimatedDelivery: string;
  history: ShippingEvent[];
}

export interface ShippingEvent {
  time: string;
  location: string;
  status: string;
  description: string;
}

export interface Order {
  orderId: string;
  userId: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotal: number;
  shippingFee: number;
  discount: number;
  total: number;
  paymentMethod: string;
  shipping: ShippingInfo;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

export interface SupportTicket {
  ticketId: string;
  orderId?: string;
  userId?: string;
  priority: "normal" | "urgent";
  summary: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface ReturnPolicy {
  category: string;
  policy: string;
  conditions: string[];
  refundTimeline: string;
  returnWindow: string;
  shippingResponsibility: string;
  exceptions: string[];
}

export interface CustomerProfile {
  userId: string;
  name: string;
  membershipTier: "bronze" | "silver" | "gold" | "platinum";
  points: number;
  totalOrders: number;
  joinedAt: string;
}

// ── 种子数据 —— 12个真实感订单覆盖各种状态 ──

const SEED_ORDERS: Order[] = [
  {
    orderId: "ORD-2024-001234",
    userId: "user_demo_001",
    status: "shipped",
    items: [
      {
        name: "无线蓝牙耳机 Pro",
        sku: "SKU-A1001",
        quantity: 1,
        unitPrice: 299.0,
      },
    ],
    subtotal: 299.0,
    shippingFee: 0,
    discount: 0,
    total: 299.0,
    paymentMethod: "微信支付",
    shipping: {
      carrier: "顺丰速运",
      trackingNo: "SF1234567890",
      origin: "深圳",
      destination: "北京",
      estimatedDelivery: "2026-06-15",
      history: [
        {
          time: "2026-06-13 14:30",
          location: "上海分拣中心",
          status: "arrived_at_hub",
          description: "快件到达上海分拣中心",
        },
        {
          time: "2026-06-12 22:00",
          location: "深圳转运中心",
          status: "departed",
          description: "快件已离开深圳转运中心",
        },
        {
          time: "2026-06-12 10:15",
          location: "深圳福田网点",
          status: "picked_up",
          description: "商家已发货，快递员已揽收",
        },
      ],
    },
    createdAt: "2026-06-10",
    updatedAt: "2026-06-13",
  },
  {
    orderId: "ORD-2024-001298",
    userId: "user_demo_001",
    status: "out_for_delivery",
    items: [
      {
        name: "有机绿茶礼盒装",
        sku: "SKU-T2003",
        quantity: 2,
        unitPrice: 128.0,
      },
      { name: "陶瓷茶杯套装", sku: "SKU-H3010", quantity: 1, unitPrice: 89.0 },
    ],
    subtotal: 345.0,
    shippingFee: 15.0,
    discount: 20.0,
    total: 340.0,
    paymentMethod: "支付宝",
    shipping: {
      carrier: "中通快递",
      trackingNo: "ZTO9876543210",
      origin: "杭州",
      destination: "北京",
      estimatedDelivery: "2026-06-14",
      history: [
        {
          time: "2026-06-13 09:30",
          location: "北京朝阳配送站",
          status: "out_for_delivery",
          description: "快递员正在派送中",
        },
        {
          time: "2026-06-13 06:00",
          location: "北京分拣中心",
          status: "arrived_at_hub",
          description: "快件到达北京分拣中心",
        },
        {
          time: "2026-06-12 15:00",
          location: "杭州转运中心",
          status: "departed",
          description: "快件离开杭州",
        },
      ],
    },
    createdAt: "2026-06-09",
    updatedAt: "2026-06-13",
  },
  {
    orderId: "ORD-2024-001345",
    userId: "user_demo_001",
    status: "delivered",
    items: [
      {
        name: "夏季轻薄防晒霜 SPF50+",
        sku: "SKU-B5007",
        quantity: 1,
        unitPrice: 159.0,
      },
    ],
    subtotal: 159.0,
    shippingFee: 0,
    discount: 0,
    total: 159.0,
    paymentMethod: "微信支付",
    shipping: {
      carrier: "圆通速递",
      trackingNo: "YT5555666677",
      origin: "广州",
      destination: "北京",
      estimatedDelivery: "2026-06-11",
      history: [
        {
          time: "2026-06-11 11:20",
          location: "北京",
          status: "delivered",
          description: "快件已签收",
        },
        {
          time: "2026-06-11 08:00",
          location: "北京配送站",
          status: "out_for_delivery",
          description: "快递员派送中",
        },
        {
          time: "2026-06-10 20:00",
          location: "广州转运中心",
          status: "departed",
          description: "快件离开广州",
        },
      ],
    },
    createdAt: "2026-06-07",
    updatedAt: "2026-06-11",
  },
  {
    orderId: "ORD-2024-001402",
    userId: "user_demo_001",
    status: "processing",
    items: [
      {
        name: "机械键盘 Cherry轴",
        sku: "SKU-C6002",
        quantity: 1,
        unitPrice: 499.0,
      },
      { name: "鼠标垫超大号", sku: "SKU-C6010", quantity: 2, unitPrice: 39.0 },
    ],
    subtotal: 577.0,
    shippingFee: 0,
    discount: 50.0,
    total: 527.0,
    paymentMethod: "信用卡",
    shipping: {
      carrier: "顺丰速运",
      trackingNo: "",
      origin: "深圳",
      destination: "北京",
      estimatedDelivery: "2026-06-17",
      history: [
        {
          time: "2026-06-13 08:00",
          location: "深圳",
          status: "processing",
          description: "订单已确认，仓库配货中",
        },
      ],
    },
    createdAt: "2026-06-13",
    updatedAt: "2026-06-13",
  },
  {
    orderId: "ORD-2024-001450",
    userId: "user_demo_001",
    status: "pending_payment",
    items: [
      {
        name: "冬季羽绒服 男款",
        sku: "SKU-F8003",
        quantity: 1,
        unitPrice: 899.0,
      },
    ],
    subtotal: 899.0,
    shippingFee: 0,
    discount: 100.0,
    total: 799.0,
    paymentMethod: "",
    shipping: {
      carrier: "",
      trackingNo: "",
      origin: "",
      destination: "",
      estimatedDelivery: "",
      history: [],
    },
    createdAt: "2026-06-13",
    updatedAt: "2026-06-13",
    notes: "用户使用了100元优惠券，待支付",
  },
  {
    orderId: "ORD-2024-001490",
    userId: "user_demo_001",
    status: "cancelled",
    items: [
      {
        name: "手机壳 iPhone 15 Pro",
        sku: "SKU-M9001",
        quantity: 1,
        unitPrice: 49.0,
      },
    ],
    subtotal: 49.0,
    shippingFee: 10.0,
    discount: 0,
    total: 59.0,
    paymentMethod: "微信支付",
    shipping: {
      carrier: "中通快递",
      trackingNo: "ZTO1111111111",
      origin: "上海",
      destination: "北京",
      estimatedDelivery: "",
      history: [
        {
          time: "2026-06-08 10:00",
          location: "上海",
          status: "cancelled",
          description: "用户取消订单",
        },
      ],
    },
    createdAt: "2026-06-07",
    updatedAt: "2026-06-08",
  },
  {
    orderId: "ORD-2024-001520",
    userId: "user_demo_001",
    status: "refunded",
    items: [
      {
        name: "智能手表 运动版",
        sku: "SKU-W7001",
        quantity: 1,
        unitPrice: 1299.0,
      },
    ],
    subtotal: 1299.0,
    shippingFee: 0,
    discount: 0,
    total: 1299.0,
    paymentMethod: "支付宝",
    shipping: {
      carrier: "京东物流",
      trackingNo: "JD3333444455",
      origin: "北京",
      destination: "北京",
      estimatedDelivery: "2026-06-05",
      history: [
        {
          time: "2026-06-10",
          location: "北京",
          status: "refunded",
          description: "退款已完成，¥1299.00退回原支付方式",
        },
        {
          time: "2026-06-08",
          location: "北京仓库",
          status: "return_received",
          description: "退货商品已签收，质检中",
        },
        {
          time: "2026-06-05",
          location: "北京",
          status: "delivered",
          description: "订单已签收",
        },
      ],
    },
    createdAt: "2026-06-03",
    updatedAt: "2026-06-10",
  },
  {
    orderId: "ORD-2024-001560",
    userId: "user_demo_002",
    status: "in_transit",
    items: [
      {
        name: "家用空气炸锅 5L",
        sku: "SKU-H4005",
        quantity: 1,
        unitPrice: 399.0,
      },
    ],
    subtotal: 399.0,
    shippingFee: 0,
    discount: 0,
    total: 399.0,
    paymentMethod: "微信支付",
    shipping: {
      carrier: "韵达快递",
      trackingNo: "YD7777888899",
      origin: "佛山",
      destination: "上海",
      estimatedDelivery: "2026-06-16",
      history: [
        {
          time: "2026-06-13 12:00",
          location: "武汉中转站",
          status: "in_transit",
          description: "快件在运输中",
        },
        {
          time: "2026-06-12 18:00",
          location: "佛山转运中心",
          status: "departed",
          description: "快件离开佛山",
        },
      ],
    },
    createdAt: "2026-06-11",
    updatedAt: "2026-06-13",
  },
  {
    orderId: "ORD-2024-001600",
    userId: "user_demo_002",
    status: "delivered",
    items: [
      {
        name: "猫粮 成猫 5kg",
        sku: "SKU-P3002",
        quantity: 2,
        unitPrice: 199.0,
      },
      {
        name: "猫砂 豆腐猫砂 6L",
        sku: "SKU-P3008",
        quantity: 4,
        unitPrice: 29.0,
      },
    ],
    subtotal: 514.0,
    shippingFee: 30.0,
    discount: 30.0,
    total: 514.0,
    paymentMethod: "支付宝",
    shipping: {
      carrier: "顺丰速运",
      trackingNo: "SF2222333344",
      origin: "上海",
      destination: "上海",
      estimatedDelivery: "2026-06-12",
      history: [
        {
          time: "2026-06-12 16:00",
          location: "上海",
          status: "delivered",
          description: "快件已签收（快递柜）",
        },
        {
          time: "2026-06-12 09:00",
          location: "上海配送站",
          status: "out_for_delivery",
          description: "快递员派送中",
        },
      ],
    },
    createdAt: "2026-06-10",
    updatedAt: "2026-06-12",
  },
  {
    orderId: "ORD-2024-001650",
    userId: "user_demo_003",
    status: "processing",
    items: [
      {
        name: "办公椅 人体工学",
        sku: "SKU-O1005",
        quantity: 1,
        unitPrice: 1599.0,
      },
    ],
    subtotal: 1599.0,
    shippingFee: 50.0,
    discount: 200.0,
    total: 1449.0,
    paymentMethod: "花呗分期",
    shipping: {
      carrier: "德邦物流",
      trackingNo: "",
      origin: "佛山",
      destination: "广州",
      estimatedDelivery: "2026-06-18",
      history: [
        {
          time: "2026-06-13",
          location: "佛山仓库",
          status: "processing",
          description: "大件商品出库准备中",
        },
      ],
    },
    createdAt: "2026-06-12",
    updatedAt: "2026-06-13",
  },
  {
    orderId: "ORD-2024-001700",
    userId: "user_demo_003",
    status: "shipped",
    items: [
      {
        name: "瑜伽垫 加厚防滑 6mm",
        sku: "SKU-Y2001",
        quantity: 1,
        unitPrice: 89.0,
      },
    ],
    subtotal: 89.0,
    shippingFee: 0,
    discount: 0,
    total: 89.0,
    paymentMethod: "微信支付",
    shipping: {
      carrier: "中通快递",
      trackingNo: "ZTO0000111122",
      origin: "义乌",
      destination: "广州",
      estimatedDelivery: "2026-06-14",
      history: [
        {
          time: "2026-06-13 06:00",
          location: "金华转运中心",
          status: "departed",
          description: "快件离开金华",
        },
        {
          time: "2026-06-12 20:00",
          location: "义乌网点",
          status: "picked_up",
          description: "商家已发货",
        },
      ],
    },
    createdAt: "2026-06-12",
    updatedAt: "2026-06-13",
  },
  {
    orderId: "ORD-2024-001750",
    userId: "user_demo_001",
    status: "delivered",
    items: [
      {
        name: "螺蛳粉 正宗柳州味 300g×6袋",
        sku: "SKU-F1006",
        quantity: 1,
        unitPrice: 59.0,
      },
      {
        name: "酸辣粉 重庆口味 240g×4袋",
        sku: "SKU-F1010",
        quantity: 1,
        unitPrice: 39.0,
      },
    ],
    subtotal: 98.0,
    shippingFee: 0,
    discount: 0,
    total: 98.0,
    paymentMethod: "微信支付",
    shipping: {
      carrier: "圆通速递",
      trackingNo: "YT1111000022",
      origin: "柳州",
      destination: "北京",
      estimatedDelivery: "2026-06-09",
      history: [
        {
          time: "2026-06-09 14:00",
          location: "北京",
          status: "delivered",
          description: "快件已签收",
        },
        {
          time: "2026-06-08 08:00",
          location: "柳州转运中心",
          status: "departed",
          description: "快件离开柳州",
        },
      ],
    },
    createdAt: "2026-06-06",
    updatedAt: "2026-06-09",
  },
];

const SEED_POLICIES: ReturnPolicy[] = [
  {
    category: "通用",
    policy: "7天无理由退货",
    conditions: [
      "自签收之日起7天内申请",
      "商品完好，不影响二次销售",
      "保留原包装和配件",
      "非特殊商品（食品、内衣等开封后不可退）",
    ],
    refundTimeline: "收到退货商品并质检通过后，1-3个工作日退款到原支付方式",
    returnWindow: "7天",
    shippingResponsibility:
      "非质量问题退货，退回运费由买方承担；质量问题退货，运费由卖方承担",
    exceptions: [
      "食品（开封后）",
      "内衣/泳衣（卫生原因）",
      "定制商品",
      "虚拟商品/充值",
    ],
  },
  {
    category: "电子产品",
    policy: "15天质量问题换货 + 7天无理由退货",
    conditions: [
      "自签收之日起15天内出现非人为质量故障可换货",
      "7天内无理由退货需保证商品完好",
      "需保留发票和保修卡",
      "激活后不支持无理由退货（手机、平板等需联网激活的设备）",
    ],
    refundTimeline: "质检通过后1-3个工作日退款",
    returnWindow: "7天（无理由）/ 15天（质量换货）",
    shippingResponsibility: "质量问题免运费，非质量问题买方承担",
    exceptions: [
      "已激活的手机/平板",
      "已拆封的耳机（卫生原因）",
      "软件/游戏激活码",
    ],
  },
  {
    category: "服装",
    policy: "7天无理由退换",
    conditions: [
      "自签收之日起7天内申请",
      "未被穿着/洗涤，保留吊牌和原包装",
      "试穿时请注意避免化妆品沾染",
    ],
    refundTimeline: "收到退货后1-3个工作日退款",
    returnWindow: "7天",
    shippingResponsibility: "赠送退换运费险，首重免费",
    exceptions: ["内衣/泳衣", "已修改的服装（如改裤长）", "定制尺寸"],
  },
  {
    category: "食品",
    policy: "不支持无理由退货，质量问题可退款",
    conditions: [
      "食品类商品不支持7天无理由退货",
      "如收到商品过期、变质、与描述不符，可申请退款",
      "需提供问题商品照片作为凭证",
      "签收时发现破损，应拒收并联系客服",
    ],
    refundTimeline: "核实后1-3个工作日退款",
    returnWindow: "质量问题48小时内申请",
    shippingResponsibility: "质量问题退款由卖方承担",
    exceptions: ["生鲜/冷冻食品", "已开封的食品", "临期商品（已在详情页标注）"],
  },
];

// ── 持久化路径 ──

const DATA_DIR = path.join(process.cwd(), "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");

// ═══════════════════════════════════════════════════════
// OrderService
// ═══════════════════════════════════════════════════════

export class OrderService {
  private orders: Order[] = [];
  private tickets: SupportTicket[] = [];
  private policies: ReturnPolicy[] = SEED_POLICIES;
  private loaded = false;

  // ── 数据加载 ──

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
    } catch {
      /* directory exists */
    }

    // 加载订单
    try {
      const orderData = await fs.readFile(ORDERS_FILE, "utf-8");
      this.orders = JSON.parse(orderData);
      logger.info(
        { count: this.orders.length },
        "OrderService: loaded orders from file",
      );
    } catch {
      this.orders = SEED_ORDERS;
      await this.persistOrders();
      logger.info(
        { count: this.orders.length },
        "OrderService: initialized seed orders",
      );
    }

    // 加载工单
    try {
      const ticketData = await fs.readFile(TICKETS_FILE, "utf-8");
      this.tickets = JSON.parse(ticketData);
    } catch {
      this.tickets = [];
    }

    this.loaded = true;
  }

  private async persistOrders(): Promise<void> {
    try {
      await fs.writeFile(
        ORDERS_FILE,
        JSON.stringify(this.orders, null, 2),
        "utf-8",
      );
    } catch (e) {
      logger.warn(e, "OrderService: failed to persist orders");
    }
  }

  private async persistTickets(): Promise<void> {
    try {
      await fs.writeFile(
        TICKETS_FILE,
        JSON.stringify(this.tickets, null, 2),
        "utf-8",
      );
    } catch (e) {
      logger.warn(e, "OrderService: failed to persist tickets");
    }
  }

  // ── 订单查询 ──

  /**
   * 按订单号查询订单
   * @returns 订单对象或 null
   */
  async lookupOrder(orderId: string): Promise<Order | null> {
    await this.ensureLoaded();
    const order = this.orders.find(
      (o) => o.orderId.toLowerCase() === orderId.toLowerCase(),
    );
    return order || null;
  }

  /**
   * 按用户 ID 查询所有订单（按创建时间倒序）
   */
  async getUserOrders(userId: string): Promise<Order[]> {
    await this.ensureLoaded();
    return this.orders
      .filter((o) => o.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 按物流单号查询
   */
  async lookupByTracking(trackingNo: string): Promise<Order | null> {
    await this.ensureLoaded();
    const order = this.orders.find(
      (o) => o.shipping.trackingNo.toLowerCase() === trackingNo.toLowerCase(),
    );
    return order || null;
  }

  // ── 物流查询 ──

  /**
   * 查询物流状态，返回格式化的物流详情
   */
  async getShippingStatus(trackingNoOrOrderId: string): Promise<{
    found: boolean;
    orderId?: string;
    carrier?: string;
    trackingNo?: string;
    status?: string;
    estimatedDelivery?: string;
    history?: ShippingEvent[];
    message?: string;
  }> {
    await this.ensureLoaded();

    // 先尝试按物流单号查
    let order = await this.lookupByTracking(trackingNoOrOrderId);
    // 再按订单号查
    if (!order) {
      order = await this.lookupOrder(trackingNoOrOrderId);
    }

    if (!order) {
      return {
        found: false,
        message: `未找到物流信息。请检查运单号或订单号是否正确。提示：格式为运单号如 SF1234567890，或订单号如 ORD-2024-001234。`,
      };
    }

    if (!order.shipping.trackingNo) {
      return {
        found: true,
        orderId: order.orderId,
        status: order.status,
        message: `订单 ${order.orderId} 尚未发货，暂无物流信息。当前状态：${this.statusLabel(order.status)}。`,
      };
    }

    return {
      found: true,
      orderId: order.orderId,
      carrier: order.shipping.carrier,
      trackingNo: order.shipping.trackingNo,
      status: order.shipping.history[0]?.status || order.status,
      estimatedDelivery: order.shipping.estimatedDelivery,
      history: order.shipping.history,
    };
  }

  // ── 退换货政策 ──

  /**
   * 查询退换货政策
   */
  async getReturnPolicy(
    productCategory?: string,
    reason?: string,
  ): Promise<ReturnPolicy & { reasonNote: string }> {
    await this.ensureLoaded();

    const category = productCategory || "通用";
    const policy =
      this.policies.find((p) => p.category === category) || this.policies[0];

    let reasonNote = "";
    if (reason === "质量问题") {
      reasonNote =
        "质量问题退货免运费，请保留问题商品照片作为凭证。符合质量问题的商品可申请换货或退款。";
    } else if (reason === "发错货") {
      reasonNote =
        "发错货由我方承担全部运费，请提供收到的商品照片。我们将安排正确的商品补发或全额退款。";
    } else if (reason === "不喜欢" || reason === "不想要了") {
      reasonNote =
        "非质量问题的退货需自行承担退回运费。购买时赠送的退换运费险可报销首重费用。";
    } else if (reason) {
      reasonNote = `关于"${reason}"的退货申请，将根据具体情况进行审核。`;
    } else {
      reasonNote = "如需退货，请在退货窗口期内提交申请。";
    }

    return { ...policy, reasonNote };
  }

  // ── 客服工单 ──

  /**
   * 创建客服工单
   */
  async createTicket(params: {
    summary: string;
    priority?: "normal" | "urgent";
    orderId?: string;
    userId?: string;
  }): Promise<SupportTicket> {
    await this.ensureLoaded();

    const ticket: SupportTicket = {
      ticketId: `TK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      orderId: params.orderId,
      userId: params.userId,
      priority: params.priority || "normal",
      summary: params.summary,
      status: "open",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.tickets.push(ticket);
    await this.persistTickets();

    logger.info(
      { ticketId: ticket.ticketId, priority: ticket.priority },
      "OrderService: support ticket created",
    );

    return ticket;
  }

  /**
   * 获取工单列表
   */
  async getTickets(userId?: string): Promise<SupportTicket[]> {
    await this.ensureLoaded();
    if (userId) {
      return this.tickets
        .filter((t) => t.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return [...this.tickets].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  // ── 工具方法 ──

  /** 状态中文标签 */
  statusLabel(status: OrderStatus): string {
    const labels: Record<OrderStatus, string> = {
      pending_payment: "待支付",
      paid: "已支付",
      processing: "处理中",
      shipped: "已发货",
      in_transit: "运输中",
      out_for_delivery: "派送中",
      delivered: "已签收",
      cancelled: "已取消",
      refunded: "已退款",
    };
    return labels[status] || status;
  }

  /** 枚举所有可用订单号（供 LLM 提示使用） */
  async getSampleOrderIds(): Promise<string[]> {
    await this.ensureLoaded();
    return this.orders.slice(0, 5).map((o) => o.orderId);
  }

  /** 重置数据到种子状态（测试用） */
  async reset(): Promise<void> {
    this.orders = [...SEED_ORDERS];
    this.tickets = [];
    this.loaded = true;
    await this.persistOrders();
    await this.persistTickets();
    logger.info("OrderService: data reset to seed state");
  }
}

// ── 单例 ──

let _defaultService: OrderService | null = null;

export function getOrderService(): OrderService {
  if (!_defaultService) {
    _defaultService = new OrderService();
  }
  return _defaultService;
}
