-- Add indexes for customer service feedback and analytics queries
-- See: satisfaction_ratings feedback query, 7-day trend, analytics aggregation

-- Conversation: type + createdAt for analytics queries (total/today conversations by type)
CREATE INDEX IF NOT EXISTS "ix_conversations_type_created" ON "conversations" ("type", "created_at");

-- SatisfactionRating: createdAt for date-range scans (7-day trend, paginated feedback)
CREATE INDEX IF NOT EXISTS "ix_satisfaction_ratings_created_at" ON "satisfaction_ratings" ("created_at");

-- SatisfactionRating: rating for filtered queries (positive/negative aggregation)
CREATE INDEX IF NOT EXISTS "ix_satisfaction_ratings_rating" ON "satisfaction_ratings" ("rating");
