-- Preserve preview-computed log_id/target_sub4 through page comment link jobs.
-- Production tables from 0020 stored target_sub1/2/3 but not target_sub4, so
-- real runs could mint customlinks without sub4 even when preview had log_id.
ALTER TABLE page_comment_link_job_items ADD COLUMN log_id TEXT NOT NULL DEFAULT '';
ALTER TABLE page_comment_link_job_items ADD COLUMN target_sub4 TEXT NOT NULL DEFAULT '';
