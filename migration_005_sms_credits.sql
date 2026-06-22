-- Migration 005: sms_credits + sms_frozen on gyms table
--
-- sms_credits: how many WhatsApp sends the gym has remaining (default 860).
-- sms_frozen:  true when credits hit 0 — cron skips this gym entirely.

ALTER TABLE gyms
  ADD COLUMN IF NOT EXISTS sms_credits integer NOT NULL DEFAULT 860,
  ADD COLUMN IF NOT EXISTS sms_frozen  boolean NOT NULL DEFAULT false;
