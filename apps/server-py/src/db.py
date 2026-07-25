"""数据库连接 —— SQLAlchemy 异步引擎 + 会话工厂。

核心概念：

1. Engine（引擎）= 连接池管理器
   - 数据库连接（TCP + 认证 + 会话）创建很贵，每次请求都新建/销毁不可行
   - Engine 启动时预建一批连接（池），请求来时分发，用完回收，循环复用
   - 类比：餐厅的"服务员团队"——不是来一个客人招一个，而是预先雇好，轮流服务
   - echo=True 会在控制台打印每条 SQL，debug 时开启

2. Session（会话）= 一次业务操作的上下文
   - 一个请求里可能执行多条 SQL（查用户 → 查订单 → 更新库存）
   - Session 把它们绑在一起，最后统一 commit 或 rollback
   - 类比：购物车的"一次结账过程"——选商品、填地址、付款，要么全成功要么全回滚
   - async_sessionmaker 是会话工厂，每次调用返回一个新会话
   - expire_on_commit=False：commit 后不自动 expire，避免后续访问时再多查一次数据库

3. get_db() = FastAPI 依赖注入的会话提供者
   - 用 async generator（yield）而非 return，因为 yield 之后的代码会在请求结束时执行
   - async with 保证请求结束后会话自动 close，无论正常返回还是抛异常
   - 类比：Express 中间件中 req.db = prisma，请求结束自动释放
"""

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.config import settings

# Engine —— 连接池管理器，进程启动时创建，全局复用
# echo=settings.debug：开发时可开 DEBUG=true 看每条 SQL
engine = create_async_engine(settings.database_url, echo=settings.debug)

# Session 工厂 —— 每次调用生成一个独立的数据库会话
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    """FastAPI 依赖注入用：每个请求进来时分配一个会话，请求结束时回收。

    用法：router 中写 db: AsyncSession = Depends(get_db)
    """
    async with async_session() as session:
        yield session
