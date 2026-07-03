import path from 'node:path';
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js';

const mediaExtensions = new Set([
  '.av1', '.gif', '.jpeg', '.jpg', '.m4v',
  '.mov', '.mp4', '.png', '.webm', '.webp',
]);

export function isMediaAttachment(attachment) {
  const contentType = attachment.contentType || '';
  const extension = path.extname(attachment.name || '').toLowerCase();
  return contentType.startsWith('image/')
    || contentType.startsWith('video/')
    || mediaExtensions.has(extension);
}

export function isMediaUpload(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  return String(file.mimetype || '').startsWith('image/')
    || String(file.mimetype || '').startsWith('video/')
    || mediaExtensions.has(extension);
}

export function sanitizeCaption(value) {
  return String(value || '').trim().slice(0, 1900);
}

/**
 * Thin wrapper around a discord.js Client. Keeps connection state and exposes
 * the read/upload helpers the server needs. Never logs the bot token.
 */
export class DiscordService {
  constructor({ botToken, guildId, defaultChannelId }) {
    this.botToken = botToken;
    this.guildId = guildId;
    this.defaultChannelId = defaultChannelId;
    this.ready = false;
    this.error = '';
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    });
  }

  get configured() {
    return Boolean(this.botToken && this.guildId);
  }

  async connect() {
    if (!this.configured) {
      this.error = 'Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID';
      return false;
    }
    try {
      await this.client.login(this.botToken);
      await new Promise((resolve) => {
        if (this.client.isReady()) return resolve();
        this.client.once(Events.ClientReady, resolve);
      });
      this.ready = true;
      this.error = '';
      return true;
    } catch (error) {
      // Only surface the message, never the token or full error object.
      this.error = error?.message || 'Discord login failed';
      return false;
    }
  }

  get user() {
    return this.client.user;
  }

  async getGuild() {
    return this.client.guilds.fetch(this.guildId);
  }

  async getTextChannels() {
    const guild = await this.getGuild();
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const channels = await guild.channels.fetch();

    return Array.from(channels.values())
      .filter((channel) => channel && channel.type === ChannelType.GuildText)
      .map((channel) => {
        const permissions = me ? channel.permissionsFor(me) : null;
        const canUpload = Boolean(permissions?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
        ]));
        return {
          id: channel.id,
          name: channel.name,
          isDefault: channel.id === this.defaultChannelId,
          canUpload,
        };
      })
      .sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        if (a.canUpload !== b.canUpload) return a.canUpload ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  async fetchMediaItems(channelId, limit = 50) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error('Invalid text channel');
    }
    const messages = await channel.messages.fetch({
      limit: Math.min(Number(limit) || 50, 100),
    });
    const items = [];
    for (const message of messages.values()) {
      for (const attachment of message.attachments.values()) {
        if (!isMediaAttachment(attachment)) continue;
        items.push(this.describeAttachment(channel, message, attachment));
      }
    }
    return items;
  }

  describeAttachment(channel, message, attachment) {
    return {
      id: attachment.id,
      messageId: message.id,
      channelId: channel.id,
      guildId: channel.guildId,
      filename: attachment.name,
      size: attachment.size,
      contentType: attachment.contentType,
      url: attachment.url,
      proxyUrl: `/api/media/${channel.id}/${message.id}/${attachment.id}`,
      jumpUrl: `https://discord.com/channels/${channel.guildId}/${channel.id}/${message.id}`,
      createdAt: message.createdAt.toISOString(),
    };
  }

  /** Resolve a fresh (non-expired) CDN url for an attachment. */
  async resolveFreshUrl(channelId, messageId, attachmentId) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      const err = new Error('Channel not found');
      err.status = 404;
      throw err;
    }
    const message = await channel.messages.fetch(messageId);
    const attachment = message.attachments.get(attachmentId);
    if (!attachment) {
      const err = new Error('Attachment not found');
      err.status = 404;
      throw err;
    }
    return attachment.url;
  }

  async uploadFile({ channelId, buffer, filePath, filename, mimetype, caption }) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      const err = new Error('Selected channel is not a text channel');
      err.status = 400;
      throw err;
    }
    const source = buffer ?? filePath;
    if (!source) {
      throw new Error('No upload source provided');
    }
    const attachment = new AttachmentBuilder(source, {
      name: filename,
      description: mimetype,
    });
    const message = await channel.send({
      content: sanitizeCaption(caption) || undefined,
      files: [attachment],
      allowedMentions: { parse: [] },
    });
    const uploaded = message.attachments.first();
    if (!uploaded) {
      throw new Error('Discord did not return an attachment');
    }
    return this.describeAttachment(channel, message, uploaded);
  }
}

export { ChannelType };
