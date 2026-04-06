-- Migration number: 0016   2026-04-06T00:00:00.000Z

ALTER TABLE pages ADD COLUMN onecard_enabled INTEGER DEFAULT 0;
ALTER TABLE pages ADD COLUMN onecard_link_mode TEXT DEFAULT 'shopee';
ALTER TABLE pages ADD COLUMN onecard_cta TEXT DEFAULT 'SHOP_NOW';
