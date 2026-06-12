// Conversation ownership guard — shared validation utility
// Eliminates 6 duplicate prisma.conversation.findFirst() ownership checks across routes
import { prisma } from "../db.js";

/**
 * Verify that a conversation exists and belongs to the given user.
 * Returns true if the conversation exists and is owned by the user, false otherwise.
 *
 * Usage in route handlers:
 *   if (!(await verifyConversationOwnership(conversationId, user.id))) {
 *     return c.json({ detail: "Conversation not found or access denied" }, 404);
 *   }
 */
export async function verifyConversationOwnership(
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true }, // only need existence check
  });
  return conversation !== null;
}
