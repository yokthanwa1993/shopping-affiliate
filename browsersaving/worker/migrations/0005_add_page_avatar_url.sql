-- Migration: Add page_avatar_url column to profiles table
ALTER TABLE profiles ADD COLUMN page_avatar_url TEXT;
