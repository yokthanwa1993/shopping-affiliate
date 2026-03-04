-- Migration: 0003_add_page_name.sql
-- Add page_name column to store Facebook Page name

ALTER TABLE profiles ADD COLUMN page_name TEXT;
