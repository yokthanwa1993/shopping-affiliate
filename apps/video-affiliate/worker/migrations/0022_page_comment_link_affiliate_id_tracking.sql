-- Affiliate account-id tracking for the page-comment link rewrite workflow.
-- Distinct from sub1..sub5 campaign ids: this is the customlink/CHEARB affiliate
-- ACCOUNT id carried by the link. old_* = id parsed off the existing shortlink,
-- target_* = id the rewrite should mint with, new_* = id read back off the minted
-- shortlink, affiliate_verify_status = '' | verified | mismatch | missing
-- | error, affiliate_id_match = 1 only when new === target. Added to BOTH tables.
ALTER TABLE page_comment_link_registry ADD COLUMN old_affiliate_id TEXT NOT NULL DEFAULT '';
ALTER TABLE page_comment_link_registry ADD COLUMN target_affiliate_id TEXT NOT NULL DEFAULT '';
ALTER TABLE page_comment_link_registry ADD COLUMN new_affiliate_id TEXT NOT NULL DEFAULT '';
ALTER TABLE page_comment_link_registry ADD COLUMN affiliate_verify_status TEXT NOT NULL DEFAULT '';
ALTER TABLE page_comment_link_registry ADD COLUMN affiliate_id_match INTEGER NOT NULL DEFAULT 0;

ALTER TABLE page_comment_link_job_items ADD COLUMN old_affiliate_id TEXT NOT NULL DEFAULT '';
ALTER TABLE page_comment_link_job_items ADD COLUMN target_affiliate_id TEXT NOT NULL DEFAULT '';
ALTER TABLE page_comment_link_job_items ADD COLUMN new_affiliate_id TEXT NOT NULL DEFAULT '';
ALTER TABLE page_comment_link_job_items ADD COLUMN affiliate_verify_status TEXT NOT NULL DEFAULT '';
ALTER TABLE page_comment_link_job_items ADD COLUMN affiliate_id_match INTEGER NOT NULL DEFAULT 0;
