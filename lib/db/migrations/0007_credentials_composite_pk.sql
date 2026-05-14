ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "credentials_pkey";--> statement-breakpoint
ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "credentials_user_exchange";--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_pkey" PRIMARY KEY ("user_id", "exchange");
