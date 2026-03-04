-- Migration: 0002_add_uid.sql
-- Add uid column to profiles table

ALTER TABLE profiles ADD COLUMN uid TEXT;
