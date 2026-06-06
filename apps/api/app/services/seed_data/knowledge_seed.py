"""知识库种子数据：示例 FAQ 知识库。

提供默认的客服知识库及示例 FAQ 文档，用于快速验证 RAG 功能。
"""

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

import logging

logger = logging.getLogger(__name__)

DEFAULT_KB_ID = "kb-a00000-0000-0000-0000-00000000001"

SAMPLE_FAQS = [
    {
        "title": "退换货政策",
        "content": (
            "退换货政策说明：\n\n"
            "1. 自收到商品之日起7天内，可以申请无理由退货。商品需保持原包装完整，配件齐全，不影响二次销售。\n\n"
            "2. 如商品存在质量问题，自收到商品之日起15天内可以申请换货或退货。需提供清晰的问题照片或视频作为凭证。\n\n"
            "3. 退货运费承担规则：因商品质量问题导致的退货，运费由商家承担。因个人原因退货，运费由买家承担。\n\n"
            "4. 退款处理时间：收到退回商品并确认无误后，1-3个工作日内原路退款到支付账户。\n\n"
            "5. 以下情况不支持退换货：已使用影响二次销售的商品、超过退换货期限、缺少原包装或配件。"
        ),
    },
    {
        "title": "物流配送说明",
        "content": (
            "物流配送说明：\n\n"
            "1. 全国包邮（港澳台及偏远地区除外），默认使用中通快递发货。偏远地区可能需要补运费差价。\n\n"
            "2. 下单后48小时内发货，节假日顺延。预售商品以商品页面标注的发货时间为准。\n\n"
            "3. 配送时效：一线城市1-2天，二线城市2-3天，三四线城市3-5天。具体以快递公司为准。\n\n"
            "4. 物流查询：发货后会短信通知快递单号，也可在订单详情页查看物流信息。\n\n"
            "5. 如遇到包裹丢失或破损，请在签收前检查，如有问题当场拒收并联系客服处理。"
        ),
    },
    {
        "title": "售后服务流程",
        "content": (
            "售后服务流程：\n\n"
            "1. 在线客服时间：工作日 9:00-18:00，周末 10:00-17:00。非工作时间可留言，客服上线后第一时间回复。\n\n"
            "2. 电话客服热线：400-123-4567，服务时间同在线客服。\n\n"
            "3. 售后问题处理流程：提交问题 → 客服审核（1小时内响应） → 确定解决方案 → 执行处理。\n\n"
            "4. 投诉建议：如对服务不满意，可发送邮件至 feedback@example.com，我们会在24小时内回复。\n\n"
            "5. 常见问题可先查阅帮助中心，大部分问题都可以自助解决，无需等待客服。"
        ),
    },
    {
        "title": "会员权益说明",
        "content": (
            "会员权益说明：\n\n"
            "普通会员：注册即享，享受积分累积（消费1元=1积分），积分可兑换优惠券。\n\n"
            "银卡会员：年消费满2000元自动升级，享受9.5折优惠、专属客服通道、生日双倍积分。\n\n"
            "金卡会员：年消费满5000元自动升级，享受9折优惠、免运费、优先发货、专属礼品包装。\n\n"
            "钻石会员：年消费满10000元自动升级，享受8.5折优惠、专属顾问1对1服务、新品优先体验、线下活动邀请。\n\n"
            "会员等级有效期为1年，到期后根据上一年消费重新评定等级。"
        ),
    },
    {
        "title": "支付方式说明",
        "content": (
            "支付方式说明：\n\n"
            "1. 支持的支付方式：微信支付、支付宝、银行卡（储蓄卡/信用卡）、Apple Pay。\n\n"
            "2. 分期付款：单笔订单满500元可申请分期，支持3期、6期、12期，部分银行支持免息分期。\n\n"
            "3. 优惠券使用：在下单页面选择可用优惠券，可与部分促销活动叠加使用。部分限时折扣商品不支持优惠券。\n\n"
            "4. 支付安全：所有支付均通过PCI-DSS认证的第三方支付平台处理，我们不会保存您的银行卡信息。\n\n"
            "5. 支付遇到问题：如支付失败，请检查银行卡余额和限额，或尝试更换支付方式。仍无法解决请联系客服。"
        ),
    },
]


async def seed_knowledge_base(db: AsyncSession) -> str:
    """创建默认知识库和示例 FAQ 文档。

    如果知识库已存在则跳过，返回已有 KB ID。
    文档插入走 KnowledgeIngestionService 完成向量化入库。
    """
    # 检查是否已有数据
    result = await db.execute(
        text("SELECT 1 FROM knowledge_bases WHERE id = :id"),
        {"id": DEFAULT_KB_ID},
    )
    if result.fetchone() is not None:
        logger.info("知识库种子数据已存在，跳过")
        return DEFAULT_KB_ID

    # 创建知识库
    await db.execute(
        text(
            "INSERT INTO knowledge_bases (id, name, description) VALUES (:id, :name, :desc)"
        ),
        {
            "id": DEFAULT_KB_ID,
            "name": "客服FAQ知识库",
            "desc": "默认客服常见问题知识库，包含退换货、物流、售后、会员、支付等FAQ",
        },
    )
    await db.commit()

    # 检查是否有 Embedding Provider
    from app.services.embeddings.registry import get_default_embedding_provider

    provider = get_default_embedding_provider()
    if provider is None:
        logger.info("未配置 Embedding Provider，跳过文档向量化，仅创建知识库元数据")
        return DEFAULT_KB_ID

    # 向量化入库文档
    logger.info(f"开始摄入 {len(SAMPLE_FAQS)} 篇示例FAQ文档...")
    try:
        from app.services.knowledge_ingestion import KnowledgeIngestionService

        ingestion = KnowledgeIngestionService(db)
        await ingestion.batch_ingest(DEFAULT_KB_ID, SAMPLE_FAQS)
        logger.info(f"种子数据创建完成: KB={DEFAULT_KB_ID}, 文档数={len(SAMPLE_FAQS)}")
    except Exception as e:
        logger.warning(f"种子数据向量化失败（可能 Milvus 未启动）: {e}")

    return DEFAULT_KB_ID
