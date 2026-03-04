-- Migration: split legacy facebook_token into dedicated token slots
ALTER TABLE profiles ADD COLUMN postcron_token TEXT;
ALTER TABLE profiles ADD COLUMN comment_token TEXT;

