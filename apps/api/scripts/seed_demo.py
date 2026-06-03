"""
Seed demo memories for V2 Memory System demonstration.

This script simulates a customer service scenario where a customer
has interacted multiple times, and the AI should remember them.

Run: python scripts/seed_demo.py
"""

import asyncio
import sys
import os
import logging

# Force UTF-8 output on Windows
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Redirect all logging to stdout so stderr is clean for PowerShell
logging.basicConfig(
    stream=sys.stdout,
    level=logging.WARNING,
    format="%(levelname)s: %(message)s",
)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy.ext.asyncio import AsyncSession
from app.database.session import async_session_factory
from app.services.memory_engine import MemoryEngine
from app.schemas.memory import MemoryCreate

DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001"

DEMO_MEMORIES = [
    # Customer identity
    MemoryCreate(
        type="semantic",
        content="Customer name: Zhang Wei (张伟), user ID: ZW-8842",
        importance=0.9,
    ),
    # Account info
    MemoryCreate(
        type="semantic",
        content="Zhang Wei is a VIP Gold member since March 2025",
        importance=0.85,
    ),
    # Contact
    MemoryCreate(
        type="semantic",
        content="Contact email: zhangwei@example.com, phone: 138-xxxx-5678",
        importance=0.8,
    ),
    # Order history
    MemoryCreate(
        type="episodic",
        content="Order #ORD-11209: iPhone 16 Pro Max 256GB Black, ordered on May 15, status: Delivered",
        importance=0.7,
    ),
    MemoryCreate(
        type="episodic",
        content="Order #ORD-11845: AirPods Pro 2, ordered on May 28, status: Shipping (tracking: SF1234567890)",
        importance=0.85,
    ),
    # Past issues
    MemoryCreate(
        type="episodic",
        content="May 20: Reported screen flicker on iPhone 16 Pro Max, exchanged unit, resolved on May 22",
        importance=0.75,
    ),
    MemoryCreate(
        type="episodic",
        content="June 1: Asked about AirPods delivery ETA, informed it would arrive by June 5",
        importance=0.6,
    ),
    # Preferences
    MemoryCreate(
        type="preference",
        content="Customer prefers communication via email rather than phone calls",
        importance=0.7,
    ),
    MemoryCreate(
        type="preference",
        content="Customer is sensitive to delivery delays, always asks for tracking updates",
        importance=0.65,
    ),
    # Additional context
    MemoryCreate(
        type="semantic",
        content="Shipping address: Room 1201, Building 3, Tech Tower, Haidian, Beijing 100080",
        importance=0.8,
    ),
]


async def seed():
    async with async_session_factory() as db:
        # Check if already seeded
        from sqlalchemy import select, func
        from app.models.memory import MemoryModel

        result = await db.execute(
            select(func.count()).select_from(MemoryModel)
            .where(MemoryModel.user_id == DEFAULT_USER_ID)
        )
        count = result.scalar()
        if count > 0:
            print(f"[SKIP] Already have {count} memories in database. Clear them first if you want to re-seed.")
            print("  To clear: DELETE FROM memories WHERE user_id = '00000000-0000-0000-0000-000000000001';")
            return

        engine = MemoryEngine(db)
        stored_count = 0

        for memory in DEMO_MEMORIES:
            try:
                result = await engine.store(memory, user_id=DEFAULT_USER_ID)
                print(f"  [OK] Stored: {result.content[:60]}...")
                stored_count += 1
            except Exception as e:
                # Fallback: store directly to PG without vector
                print(f"  [WARN] Vector store failed ({e}), storing metadata only...")
                import uuid as _uuid
                from app.models.memory import MemoryModel as MM, MemoryType as MT

                db_memory = MM(
                    id=str(_uuid.uuid4()),
                    user_id=DEFAULT_USER_ID,
                    type=MT(memory.type),
                    content=memory.content,
                    importance=memory.importance,
                    conversation_id=memory.conversation_id,
                )
                db.add(db_memory)
                await db.commit()
                print(f"  [OK] Stored (PG only): {memory.content[:60]}...")
                stored_count += 1

        print(f"\nDone! Seeded {stored_count} demo memories.")


if __name__ == "__main__":
    print("=== AgentForge V2 Memory Demo - Seeding Customer Service Data ===\n")
    asyncio.run(seed())
    print("\nNow go to the AgentForge UI and:")
    print("  1. Click the 'Memory' tab in the right panel to see stored memories")
    print("  2. Start a new conversation and ask: 'What's my latest order status?'")
    print("  3. The AI should recall Zhang Wei's order history from memory!")
