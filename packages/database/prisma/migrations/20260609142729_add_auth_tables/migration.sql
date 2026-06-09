-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatar_url" VARCHAR(500),
ADD COLUMN     "password_hash" VARCHAR(255),
ADD COLUMN     "role" VARCHAR(20) NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" VARCHAR(36) NOT NULL,
    "user_id" VARCHAR(36) NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" VARCHAR(36) NOT NULL,
    "user_id" VARCHAR(36) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "key_hash" VARCHAR(255) NOT NULL,
    "last_used" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_refresh_tokens_user_id" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "ix_refresh_tokens_token_hash" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "ix_api_keys_user_id" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "ix_api_keys_key_hash" ON "api_keys"("key_hash");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
