import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function str(value, fallback) {
  const trimmed = String(value ?? '').trim();
  return trimmed || fallback;
}

export const config = {
  port: num(process.env.PORT, 3100),
  // Always loopback-only. Not configurable on purpose (see README safety notes).
  host: '127.0.0.1',
  maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
  discord: {
    botToken: str(process.env.DISCORD_BOT_TOKEN, ''),
    guildId: str(process.env.DISCORD_GUILD_ID, ''),
    defaultChannelId: str(process.env.DEFAULT_CHANNEL_ID, ''),
  },
  namespaceId: str(process.env.NAMESPACE_ID, 'admin'),
  mediaRoot: path.resolve(str(
    process.env.MEDIA_ROOT,
    path.join(home, 'AffiliateMedia', 'admin-media-drive'),
  )),
  dbPath: path.resolve(str(
    process.env.DB_PATH,
    path.join(home, 'Library', 'Application Support', 'AffiliateAdmin', 'admin-media-drive.sqlite'),
  )),
};

export default config;
