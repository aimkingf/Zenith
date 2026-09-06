const fs = require("fs");
const path = require("path");
const ffmpeg = require("ffmpeg-static");
if (ffmpeg && fs.existsSync(ffmpeg)) {
  process.env.FFMPEG_PATH = ffmpeg;
}

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AuditLogEvent,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
} = require("@discordjs/voice");
const play = require("play-dl");
const {
  db,
  save,
  guild: getGuild,
  user: getUser,
  bump,
  setAfk,
  getAfk,
  removeAfk,
  saveTicket,
  getTicket,
  updateTicket,
  getGuildTickets,
  saveRating,
  recordInviteJoin,
  recordInviteLeave,
  getUserInvites,
  getGuildInviteLeaderboard,
  addBonusInvites,
  resetUserInvites,
  TRANSCRIPTS_DIR,
} = require("./store");

const queues = new Map();
const recentActionHistory = new Map();
const FALLBACK_SC_CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID || "Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo";
let scInitialized = false;
let scInitPromise = null;

async function getSCClient(forceRefresh = false) {
  if (scInitialized && !forceRefresh) return true;
  if (scInitPromise && !forceRefresh) return scInitPromise;

  scInitPromise = (async () => {
    // 1. First ensure static reliable token is fully set
    try {
      await play.setToken({ soundcloud: { client_id: FALLBACK_SC_CLIENT_ID } });
      scInitialized = true;
      console.log("[Zenith Music] Initialized default SoundCloud Client ID:", FALLBACK_SC_CLIENT_ID);
    } catch (e) {
      console.warn("[Zenith Music] Static SC Token init notice:", e.message);
    }

    // 2. If force refresh or static failed, attempt dynamic fetch
    if (forceRefresh || !scInitialized) {
      try {
        const id = await play.getFreeClientID();
        if (id) {
          await play.setToken({ soundcloud: { client_id: id } });
          scInitialized = true;
          console.log("[Zenith Music] Updated dynamic SoundCloud Client ID:", id);
        }
      } catch (e) {
        console.warn("[Zenith Music] getFreeClientID notice:", e.message);
      }
    }

    return scInitialized;
  })();

  const res = await scInitPromise;
  scInitPromise = null;
  return res;
}
getSCClient().catch(() => {});

function logEmbed(title, description, color = 0x5865f2) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
}

async function sendLog(guild, payload) {
  const cfg = getGuild(guild.id);
  const targetChId = (cfg.antiNuke && cfg.antiNuke.logChannelId) || cfg.logChannelId;
  if (!targetChId) return;
  const ch = guild.channels.cache.get(targetChId);
  if (ch) await ch.send(payload).catch(() => {});
}

function levelFromXp(xp) {
  return Math.floor(Math.sqrt(xp / 50));
}

function formatDuration(ms) {
  if (!ms || isNaN(ms)) return "3:00";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatTpl(text, extra) {
  if (!text) return "";
  let res = String(text);
  const server = extra.server || extra.server_name || "";
  const count = String(extra.count ?? extra.memberCount ?? extra.server_membercount ?? "");
  const user = extra.user || "";
  const username = extra.username || extra.user_name || "";
  const tag = extra.tag || username;
  const userId = extra.user_id || extra.userId || "";

  return res
    .replaceAll("{@user}", user)
    .replaceAll("{user}", user)
    .replaceAll("{username}", username)
    .replaceAll("{user_name}", username)
    .replaceAll("{user.username}", username)
    .replaceAll("{tag}", tag)
    .replaceAll("{user.tag}", tag)
    .replaceAll("{user_id}", userId)
    .replaceAll("{user.id}", userId)
    .replaceAll("{server}", server)
    .replaceAll("{server_name}", server)
    .replaceAll("{server.name}", server)
    .replaceAll("{count}", count)
    .replaceAll("{memberCount}", count)
    .replaceAll("{member_count}", count)
    .replaceAll("{server_membercount}", count)
    .replaceAll("{server.memberCount}", count);
}

/* =========================================================
   TEMP VOICE (JOIN TO CREATE VC) SYSTEM
========================================================= */

const inviteCache = new Map(); // Map<guildId, Map<code, uses>>

async function initInviteTracker(client) {
  for (const [, guild] of client.guilds.cache) {
    try {
      const me = guild.members.me;
      if (me && me.permissions.has(PermissionFlagsBits.ManageGuild)) {
        const invites = await guild.invites.fetch().catch(() => null);
        if (invites) {
          inviteCache.set(guild.id, new Map(invites.map((inv) => [inv.code, inv.uses])));
        }
      }
    } catch (e) {}
  }
  console.log(`[InviteTracker] Initialized invite caches.`);
}

function onInviteCreate(invite) {
  try {
    if (!invite.guild) return;
    const current = inviteCache.get(invite.guild.id) || new Map();
    current.set(invite.code, invite.uses || 0);
    inviteCache.set(invite.guild.id, current);
  } catch (e) {}
}

function onInviteDelete(invite) {
  try {
    if (!invite.guild) return;
    const current = inviteCache.get(invite.guild.id);
    if (current) current.delete(invite.code);
  } catch (e) {}
}

async function setupTempVoice(guild, customChannelId = null, options = {}) {
  const cfg = getGuild(guild.id);
  const me = guild.members.me;
  if (!me.permissions.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers])) {
    throw new Error("Bot lacks Manage Channels or Move Members permissions. Please grant Zenith Administrator or Manage Channels + Move Members role permissions.");
  }

  const categoryName = options.categoryName || cfg.tempVoice?.categoryName || "ZENITH VOICE";
  const channelName = options.channelName || cfg.tempVoice?.channelName || "+ Join to Create";
  const roomPattern = options.roomPattern || cfg.tempVoice?.roomPattern || "[VC] {user}'s Room";

  if (customChannelId) {
    const existingCh = guild.channels.cache.get(customChannelId) || await guild.channels.fetch(customChannelId).catch(() => null);
    if (!existingCh) throw new Error("Selected voice channel not found in server.");
    cfg.tempVoice = {
      enabled: true,
      categoryId: existingCh.parentId || null,
      channelId: existingCh.id,
      categoryName,
      channelName: existingCh.name,
      roomPattern,
      activeRooms: cfg.tempVoice?.activeRooms || {},
    };
    save();
    return { success: true, message: `Zenith Voice linked to #${existingCh.name}!`, channel: existingCh };
  }

  let category = cfg.tempVoice?.categoryId ? guild.channels.cache.get(cfg.tempVoice.categoryId) : null;
  if (!category) {
    category = await guild.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory,
    });
  }

  const jtcChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: category.id,
    userLimit: 1,
    permissionOverwrites: [
      { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    ],
  });

  cfg.tempVoice = {
    enabled: true,
    categoryId: category.id,
    channelId: jtcChannel.id,
    categoryName,
    channelName,
    roomPattern,
    activeRooms: {},
  };
  save();
  return { success: true, message: `Zenith Voice hub created: #${jtcChannel.name}!`, channel: jtcChannel };
}

async function disableTempVoice(guild) {
  const cfg = getGuild(guild.id);
  if (!cfg.tempVoice) return { success: true, message: "Zenith Voice is already disabled." };

  if (cfg.tempVoice.channelId) {
    const ch = guild.channels.cache.get(cfg.tempVoice.channelId);
    if (ch) await ch.delete().catch(() => {});
  }
  if (cfg.tempVoice.categoryId) {
    const cat = guild.channels.cache.get(cfg.tempVoice.categoryId);
    if (cat) await cat.delete().catch(() => {});
  }

  if (cfg.tempVoice.activeRooms) {
    for (const rid of Object.keys(cfg.tempVoice.activeRooms)) {
      const roomCh = guild.channels.cache.get(rid);
      if (roomCh) await roomCh.delete().catch(() => {});
    }
  }

  cfg.tempVoice = { enabled: false, categoryId: null, channelId: null, activeRooms: {} };
  save();
  return { success: true, message: "Zenith Voice disabled and channels cleaned." };
}

function isTempVoiceChannel(channel, guild, cfg) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  if (!cfg && guild) cfg = getGuild(guild.id);
  const tv = cfg?.tempVoice;

  // Never consider the Join to Create channel itself as a temporary room
  if (tv?.channelId && channel.id === tv.channelId) return false;

  // 1. Explicitly registered in activeRooms
  if (tv?.activeRooms && tv.activeRooms[channel.id]) return true;

  // 2. Belongs to the configured Zenith Voice category
  if (tv?.categoryId && channel.parentId === tv.categoryId) return true;

  // 3. Belongs to a category named "ZENITH VOICE"
  if (channel.parent && channel.parent.name.toUpperCase().includes("ZENITH VOICE")) return true;

  // 4. Room name pattern check
  if (channel.name.includes("'s Room") || channel.name.includes("’s Room") || channel.name.startsWith("[VC] ")) return true;

  return false;
}

function getTempVoiceRoom(channel, guild, cfg) {
  if (!isTempVoiceChannel(channel, guild, cfg)) return null;
  if (!cfg && guild) cfg = getGuild(guild.id);
  if (!cfg.tempVoice) cfg.tempVoice = { enabled: true, activeRooms: {} };
  if (!cfg.tempVoice.activeRooms) cfg.tempVoice.activeRooms = {};

  let room = cfg.tempVoice.activeRooms[channel.id];
  if (!room) {
    // Auto-recover room if missing from memory (e.g. after bot restart or long session)
    let ownerId = null;
    if (channel.permissionOverwrites?.cache) {
      for (const [id, overwrite] of channel.permissionOverwrites.cache) {
        if (id !== guild.id && id !== guild.client.user.id && overwrite.type === 1) {
          if (overwrite.allow.has(PermissionFlagsBits.PrioritySpeaker) || overwrite.allow.has(PermissionFlagsBits.ManageMessages)) {
            ownerId = id;
            break;
          }
        }
      }
    }
    if (!ownerId && channel.members) {
      const firstNonBot = channel.members.find((m) => !m.user.bot);
      if (firstNonBot) ownerId = firstNonBot.id;
    }

    room = {
      ownerId: ownerId || null,
      locked: false,
      created: channel.createdTimestamp || Date.now(),
    };
    cfg.tempVoice.activeRooms[channel.id] = room;
    save();
  }
  return room;
}

async function cleanOrphanTempRooms(guild) {
  try {
    const cfg = getGuild(guild.id);
    const tv = cfg.tempVoice;
    if (!tv || !tv.enabled) return;

    const voiceChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice);
    for (const [, ch] of voiceChannels) {
      if (isTempVoiceChannel(ch, guild, cfg)) {
        if (ch.members.size === 0) {
          if (tv.activeRooms && tv.activeRooms[ch.id]) {
            delete tv.activeRooms[ch.id];
          }
          await ch.delete().catch(() => {});
        }
      }
    }
    save();
  } catch (err) {
    // ignore
  }
}

async function cleanAllOrphanTempRooms(client) {
  if (!client || !client.guilds) return;
  for (const guild of client.guilds.cache.values()) {
    await cleanOrphanTempRooms(guild).catch(() => {});
  }
}

async function onVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;
  const cfg = getGuild(guild.id);
  if (!cfg.tempVoice) cfg.tempVoice = { enabled: false, activeRooms: {} };
  if (!cfg.tempVoice.activeRooms) cfg.tempVoice.activeRooms = {};

  // Resolve joined channel safely
  let joinedChannel = newState.channel;
  if (!joinedChannel && newState.channelId) {
    joinedChannel = guild.channels.cache.get(newState.channelId) || await guild.channels.fetch(newState.channelId).catch(() => null);
  }

  const isJTC = Boolean(
    joinedChannel && (
      (cfg.tempVoice?.enabled && newState.channelId === cfg.tempVoice.channelId) ||
      joinedChannel.name.toLowerCase().includes("join to create") ||
      joinedChannel.name.toLowerCase().includes("join 2 create") ||
      joinedChannel.name.toLowerCase().includes("jtc") ||
      joinedChannel.name.toLowerCase().startsWith("+ create") ||
      joinedChannel.name.toLowerCase().startsWith("+ create")
    )
  );

  if (isJTC) {
    const member = newState.member;
    if (!member || member.user.bot) return;

    cfg.tempVoice.enabled = true;
    cfg.tempVoice.channelId = joinedChannel.id;

    try {
      const me = guild.members.me;
      if (!me || !me.permissions.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers])) {
        console.error("[ZenithVoice Error] Bot lacks Manage Channels or Move Members permissions.");
        return;
      }

      let parentCategory = null;
      if (joinedChannel.parentId && guild.channels.cache.has(joinedChannel.parentId)) {
        parentCategory = joinedChannel.parentId;
      } else if (cfg.tempVoice.categoryId && guild.channels.cache.has(cfg.tempVoice.categoryId)) {
        parentCategory = cfg.tempVoice.categoryId;
      }
      cfg.tempVoice.categoryId = parentCategory;
      save();

      const pattern = cfg.tempVoice?.roomPattern || "[VC] {user}'s Room";
      const roomName = pattern.replaceAll("{user}", member.user.username).replaceAll("{username}", member.user.username).slice(0, 95);
      const tempChannel = await guild.channels.create({
        name: roomName,
        type: ChannelType.GuildVoice,
        parent: parentCategory || null,
        permissionOverwrites: [
          {
            id: guild.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
              PermissionFlagsBits.Stream,
              PermissionFlagsBits.UseVAD,
            ],
          },
          {
            id: member.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
              PermissionFlagsBits.Stream,
              PermissionFlagsBits.UseVAD,
              PermissionFlagsBits.PrioritySpeaker,
              PermissionFlagsBits.MuteMembers,
              PermissionFlagsBits.DeafenMembers,
              PermissionFlagsBits.MoveMembers,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ManageMessages,
            ],
          },
          {
            id: guild.client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.MoveMembers,
              PermissionFlagsBits.MuteMembers,
              PermissionFlagsBits.DeafenMembers,
              PermissionFlagsBits.SendMessages,
            ],
          },
        ],
      });

      // If user already disconnected while channel created
      if (!member.voice.channelId) {
        await tempChannel.delete().catch(() => {});
        return;
      }

      // Move member to new room
      try {
        await member.voice.setChannel(tempChannel);
      } catch (e) {
        await new Promise((r) => setTimeout(r, 250));
        await member.voice.setChannel(tempChannel).catch((err) => console.error("Move retry failed:", err.message));
      }

      // Register room
      cfg.tempVoice.activeRooms[tempChannel.id] = {
        ownerId: member.id,
        locked: false,
        created: Date.now(),
      };
      save();

      // Send TempVoice Interface card
      const interfaceEmbed = new EmbedBuilder()
        .setTitle("Zenith Voice")
        .setColor(0x5865f2)
        .setDescription(
          `Welcome to your custom VC, ${member}!\n\n` +
          `You have full control over this channel. Use the buttons below or **/voice** commands.\n\n` +
          `**Control Options:**\n` +
          `- **Name:** Rename your voice channel (Modal popup)\n` +
          `- **Limit:** Set user capacity (0 for unlimited, or 1-99)\n` +
          `- **Privacy:** 1-Click Lock or Unlock your room\n` +
          `- **Claim:** Take ownership if creator leaves\n` +
          `- **Delete:** Delete this voice channel immediately\n\n` +
          `*Click any button below to manage:*`
        )
        .setFooter({ text: "Powered by Zenith Voice" });

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("voice_btn_name").setLabel("Name").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("voice_btn_limit").setLabel("Limit").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("voice_btn_privacy").setLabel("Privacy").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("voice_btn_transfer").setLabel("Transfer").setStyle(ButtonStyle.Primary)
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("voice_btn_claim").setLabel("Claim").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("voice_btn_delete").setLabel("Delete").setStyle(ButtonStyle.Danger)
      );

      await tempChannel.send({ content: `${member}`, embeds: [interfaceEmbed], components: [row1, row2] }).catch((e) => console.error("Send interface error:", e.message));
    } catch (err) {
      console.error("[ZenithVoice Error] Join to create error:", err);
    }
  }

  // 2. User left a channel (Auto-delete temporary room when empty)
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    const leftId = oldState.channelId;
    const leftChannel = oldState.channel || guild.channels.cache.get(leftId) || await guild.channels.fetch(leftId).catch(() => null);

    if (leftChannel && isTempVoiceChannel(leftChannel, guild, cfg)) {
      setTimeout(async () => {
        try {
          const freshChannel = guild.channels.cache.get(leftId) || await guild.channels.fetch(leftId).catch(() => null);
          if (freshChannel && freshChannel.members.size === 0) {
            console.log(`[Zenith Voice] Auto-deleting empty room: #${freshChannel.name} (${leftId})`);
            if (cfg.tempVoice?.activeRooms) {
              delete cfg.tempVoice.activeRooms[leftId];
              save();
            }
            await freshChannel.delete().catch(() => {});
          }
        } catch (e) {
          // ignore
        }
      }, 1000);
    }
  }
}

/* =========================================================
   HTML TRANSCRIPT GENERATOR
========================================================= */

async function generateTranscript(channel, ticket) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => []);
    const msgArray = Array.from(messages.values()).reverse();

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Transcript - #${channel.name}</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1e1f22; color: #dbdee1; margin: 0; padding: 24px; }
  .header { border-bottom: 2px solid #2b2d31; padding-bottom: 16px; margin-bottom: 24px; }
  .header h1 { margin: 0; color: #fff; font-size: 24px; }
  .header p { margin: 6px 0 0; color: #949ba4; font-size: 14px; }
  .msg { display: flex; margin-bottom: 18px; padding: 4px 8px; border-radius: 6px; }
  .msg:hover { background: #2b2d31; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; margin-right: 14px; flex-shrink: 0; }
  .body { flex-grow: 1; }
  .author { font-weight: 600; color: #f2f3f5; margin-right: 8px; font-size: 15px; }
  .time { font-size: 12px; color: #949ba4; }
  .text { margin-top: 4px; line-height: 1.4; color: #dbdee1; white-space: pre-wrap; word-break: break-word; }
  .embed-box { border-left: 4px solid #5865f2; background: #2b2d31; padding: 10px 14px; border-radius: 4px; margin-top: 6px; max-width: 520px; }
  .badge { background: #5865f2; color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-left: 6px; }
</style>
</head>
<body>
<div class="header">
  <h1>Transcript: #${channel.name}</h1>
  <p>Server: <strong>${channel.guild.name}</strong> | Category: <strong>${ticket?.category || "General"}</strong> | Date: <strong>${new Date().toLocaleString()}</strong></p>
</div>
`;

    for (const m of msgArray) {
      const avatarUrl = m.author.displayAvatarURL({ extension: "png", size: 64 });
      const timeStr = m.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
      const dateStr = m.createdAt.toLocaleDateString();
      const botBadge = m.author.bot ? '<span class="badge">BOT</span>' : "";

      html += `<div class="msg">
  <img src="${avatarUrl}" class="avatar" alt="">
  <div class="body">
    <span class="author">${m.author.username}</span>${botBadge}
    <span class="time">${dateStr} ${timeStr}</span>
    <div class="text">${escapeHtml(m.content || "")}</div>`;

      if (m.embeds && m.embeds.length > 0) {
        for (const emb of m.embeds) {
          html += `<div class="embed-box">
            ${emb.title ? `<strong>${escapeHtml(emb.title)}</strong><br>` : ""}
            ${emb.description ? `<span>${escapeHtml(emb.description)}</span>` : ""}
          </div>`;
        }
      }

      html += `  </div>
</div>`;
    }

    html += `</body></html>`;

    const filePath = path.join(TRANSCRIPTS_DIR, `${channel.id}.html`);
    fs.writeFileSync(filePath, html, "utf8");
    return filePath;
  } catch (err) {
    console.error("Transcript generation error:", err);
    return null;
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* =========================================================
   ANTI-NUKE & ENTERPRISE SECURITY SYSTEM
========================================================= */

async function checkAntiNuke(guild, actionType, limitKey, defaultLimit = 2) {
  const cfg = getGuild(guild.id);
  if (!cfg.antiNuke || !cfg.antiNuke.enabled) return;

  const me = guild.members.me;
  if (!me || !me.permissions.has(PermissionFlagsBits.ViewAuditLog)) return;

  try {
    const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: actionType }).catch(() => null);
    if (!auditLogs) return;
    const entry = auditLogs.entries.first();
    if (!entry) return;

    if (Date.now() - entry.createdTimestamp > 8000) return;

    const executor = entry.executor;
    if (!executor || executor.id === guild.client.user.id) return;
    if (executor.id === guild.ownerId) return;
    if (process.env.OWNER_ID && executor.id === process.env.OWNER_ID) return;
    if (cfg.antiNuke.whitelist && cfg.antiNuke.whitelist.includes(executor.id)) return;
    const memberExec = await guild.members.fetch(executor.id).catch(() => null);
    if (memberExec && cfg.antiNuke.whitelist && memberExec.roles.cache.some((r) => cfg.antiNuke.whitelist.includes(r.id))) return;

    const key = `${guild.id}:${executor.id}:${limitKey}`;
    const now = Date.now();
    let history = recentActionHistory.get(key) || [];
    history = history.filter((t) => now - t < 10000);
    history.push(now);
    recentActionHistory.set(key, history);

    const limit = (cfg.antiNuke.limits && cfg.antiNuke.limits[limitKey]) || defaultLimit;
    if (history.length >= limit) {
      const member = await guild.members.fetch(executor.id).catch(() => null);
      let punished = false;
      const action = cfg.antiNuke.action || "strip_roles";

      if (member && member.manageable) {
        if (action === "ban" && member.bannable) {
          await member.ban({ reason: `[ANTI-NUKE] Exceeded ${limitKey} limit (${history.length}/${limit} in 10s)` }).catch(() => {});
          punished = true;
        } else if (action === "kick" && member.kickable) {
          await member.kick(`[ANTI-NUKE] Exceeded ${limitKey} limit (${history.length}/${limit} in 10s)`).catch(() => {});
          punished = true;
        } else {
          const rolesToRemove = member.roles.cache.filter((r) => r.id !== guild.id && r.editable);
          if (rolesToRemove.size > 0) {
            await member.roles.remove(rolesToRemove, `[ANTI-NUKE] Exceeded ${limitKey} limit`).catch(() => {});
            punished = true;
          }
        }
      }

      const alert = new EmbedBuilder()
        .setTitle("[ANTI-NUKE] Security Action Triggered")
        .setColor(0xed4245)
        .setDescription(
          `**Executor:** <@${executor.id}> (${executor.tag || executor.id})\n` +
          `**Violation:** Exceeded \`${limitKey}\` limit (${history.length}/${limit} actions in 10s)\n` +
          `**Punishment:** \`${action.toUpperCase()}\` ${punished ? "Applied" : "Role hierarchy too high"}`
        )
        .setTimestamp();

      await sendLog(guild, { embeds: [alert] });

      const owner = await guild.fetchOwner().catch(() => null);
      if (owner) await owner.send({ embeds: [alert] }).catch(() => {});
    }
  } catch (err) {
    console.error("Anti-nuke verification error:", err);
  }
}

async function onChannelDelete(channel) {
  if (!channel.guild) return;
  await checkAntiNuke(channel.guild, AuditLogEvent.ChannelDelete, "channelDelete", 2);
}

async function onChannelCreate(channel) {
  if (!channel.guild) return;
  await checkAntiNuke(channel.guild, AuditLogEvent.ChannelCreate, "channelCreate", 3);
}

async function onRoleDelete(role) {
  if (!role.guild) return;
  await checkAntiNuke(role.guild, AuditLogEvent.RoleDelete, "roleDelete", 2);
}

async function onRoleCreate(role) {
  if (!role.guild) return;
  await checkAntiNuke(role.guild, AuditLogEvent.RoleCreate, "roleCreate", 3);
}

async function onBanAdd(ban) {
  if (!ban.guild) return;
  await checkAntiNuke(ban.guild, AuditLogEvent.MemberBanAdd, "ban", 2);
}

async function onWebhookUpdate(channel) {
  if (!channel.guild) return;
  await checkAntiNuke(channel.guild, AuditLogEvent.WebhookCreate, "webhook", 2);
}

async function onGuildUpdate(oldGuild, newGuild) {
  if (oldGuild.name !== newGuild.name || oldGuild.icon !== newGuild.icon) {
    await checkAntiNuke(newGuild, AuditLogEvent.GuildUpdate, "guild", 1);
  }
}

/* =========================================================
   MEMBER COUNTERS
========================================================= */

async function setupMemberCounters(guild) {
  const cfg = getGuild(guild.id);
  const me = guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("Bot lacks Manage Channels permission.");
  }

  await guild.members.fetch().catch(() => {});
  const total = guild.memberCount;
  const bots = guild.members.cache.filter((m) => m.user.bot).size;
  const humans = total - bots;

  const category = await guild.channels.create({
    name: "SERVER STATS",
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.Connect], allow: [PermissionFlagsBits.ViewChannel] },
    ],
  });

  const totalCh = await guild.channels.create({
    name: `Total Members: ${total}`,
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.Connect], allow: [PermissionFlagsBits.ViewChannel] },
    ],
  });

  const humansCh = await guild.channels.create({
    name: `Humans: ${humans}`,
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.Connect], allow: [PermissionFlagsBits.ViewChannel] },
    ],
  });

  const botsCh = await guild.channels.create({
    name: `Bots: ${bots}`,
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.Connect], allow: [PermissionFlagsBits.ViewChannel] },
    ],
  });

  cfg.counters = {
    enabled: true,
    categoryId: category.id,
    totalId: totalCh.id,
    humansId: humansCh.id,
    botsId: botsCh.id,
    lastUpdated: Date.now(),
  };
  save();
  return { total, humans, bots };
}

async function disableMemberCounters(guild) {
  const cfg = getGuild(guild.id);
  if (!cfg.counters) return;

  const ids = [cfg.counters.totalId, cfg.counters.humansId, cfg.counters.botsId, cfg.counters.categoryId];
  for (const id of ids) {
    if (id) {
      const ch = guild.channels.cache.get(id);
      if (ch) await ch.delete().catch(() => {});
    }
  }
  cfg.counters = { enabled: false, categoryId: null, totalId: null, humansId: null, botsId: null, lastUpdated: 0 };
  save();
}

async function updateMemberCounters(guild, force = false) {
  const cfg = getGuild(guild.id);
  if (!cfg.counters || !cfg.counters.enabled) return;

  const now = Date.now();
  if (!force && now - (cfg.counters.lastUpdated || 0) < 300000) return;

  try {
    const total = guild.memberCount;
    const bots = guild.members.cache.filter((m) => m.user.bot).size;
    const humans = total - bots;

    cfg.counters.lastUpdated = now;
    save();

    if (cfg.counters.categoryId) {
      const cat = guild.channels.cache.get(cfg.counters.categoryId);
      if (cat && cat.name !== "SERVER STATS") await cat.setName("SERVER STATS").catch(() => {});
    }
    if (cfg.counters.totalId) {
      const ch = guild.channels.cache.get(cfg.counters.totalId);
      if (ch) await ch.setName(`Total Members: ${total}`).catch(() => {});
    }
    if (cfg.counters.humansId) {
      const ch = guild.channels.cache.get(cfg.counters.humansId);
      if (ch) await ch.setName(`Humans: ${humans}`).catch(() => {});
    }
    if (cfg.counters.botsId) {
      const ch = guild.channels.cache.get(cfg.counters.botsId);
      if (ch) await ch.setName(`Bots: ${bots}`).catch(() => {});
    }
  } catch (err) {
    console.error("Counter update error:", err.message);
  }
}

/* =========================================================
   MEMBER ADD & SECURITY DEFENSE (Anti-Bot & Anti-Fake Member)
========================================================= */

async function onMemberAdd(member) {
  const guild = member.guild;
  const cfg = getGuild(guild.id);

  // 0. INVITE TRACKING
  try {
    const me = guild.members.me;
    if (me && me.permissions.has(PermissionFlagsBits.ManageGuild)) {
      const newInvites = await guild.invites.fetch().catch(() => null);
      const cached = inviteCache.get(guild.id);

      if (newInvites && cached) {
        let usedInvite = null;
        for (const [, inv] of newInvites) {
          const prevUses = cached.get(inv.code) || 0;
          if (inv.uses > prevUses) {
            usedInvite = inv;
            break;
          }
        }

        inviteCache.set(guild.id, new Map(newInvites.map((inv) => [inv.code, inv.uses])));

        if (usedInvite && usedInvite.inviter) {
          const accountAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24));
          const isFake = accountAgeDays < 3;
          recordInviteJoin(guild.id, usedInvite.inviter.id, member.id, isFake, usedInvite.code);
          console.log(`[InviteTracker] ${member.user.tag} joined using invite ${usedInvite.code} from ${usedInvite.inviter.tag} (Fake: ${isFake})`);
        }
      } else if (newInvites) {
        inviteCache.set(guild.id, new Map(newInvites.map((inv) => [inv.code, inv.uses])));
      }
    }
  } catch (err) {
    console.error("[InviteTracker Join Error]", err.message);
  }

  // 1. ANTI-BOT DEFENSE
  if (member.user.bot) {
    if (cfg.antiNuke && cfg.antiNuke.enabled) {
      const audit = await guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd }).catch(() => null);
      const entry = audit?.entries.first();
      const inviterMember = executor ? await guild.members.fetch(executor.id).catch(() => null) : null;
      const isWhitelisted = executor && (
        executor.id === guild.ownerId ||
        executor.id === process.env.OWNER_ID ||
        (cfg.antiNuke.whitelist && (
          cfg.antiNuke.whitelist.includes(executor.id) ||
          (inviterMember && inviterMember.roles.cache.some((r) => cfg.antiNuke.whitelist.includes(r.id)))
        ))
      );

      if (!isWhitelisted) {
        if (member.kickable) {
          await member.kick("[ANTI-BOT] Unauthorized bot addition").catch(() => {});
        }
        if (executor) {
          await checkAntiNuke(guild, AuditLogEvent.BotAdd, "botAdd", 1);
        }
        const alert = new EmbedBuilder()
          .setTitle("[ANTI-BOT] Unauthorized Bot Quarantined")
          .setColor(0xed4245)
          .setDescription(`**Bot:** ${member.user.tag} (\`${member.id}\`)\n**Invited by:** <@${executor?.id || "Unknown"}>\n**Action:** Unauthorized bot kicked immediately.`)
          .setTimestamp();
        await sendLog(guild, { embeds: [alert] });
        return;
      }
    }
  }

  // 2. ANTI-FAKE MEMBER / ANTI-ALT ACCOUNT DEFENSE
  if (!member.user.bot && cfg.antiNuke && cfg.antiNuke.enabled && cfg.antiNuke.antiAlt) {
    const minDays = cfg.antiNuke.minAccountAgeDays || 3;
    const accountAgeMs = Date.now() - member.user.createdTimestamp;
    const accountAgeDays = Math.floor(accountAgeMs / (1000 * 60 * 60 * 24));

    if (accountAgeDays < minDays) {
      if (member.kickable) {
        await member.kick(`[ANTI-FAKE-MEMBER] Account is only ${accountAgeDays} days old (Requires minimum ${minDays} days)`).catch(() => {});
        const alert = new EmbedBuilder()
          .setTitle("[SECURITY] Fake / Alt Account Blocked")
          .setColor(0xfee75c)
          .setDescription(
            `**User:** ${member.user.tag} (\`${member.id}\`)\n` +
            `**Account Age:** ${accountAgeDays} days old\n` +
            `**Action:** Kicked from server (Minimum required: \`${minDays} days\`)`
          )
          .setTimestamp();
        await sendLog(guild, { embeds: [alert] });
        return;
      }
    }
  }

  // 3. ANTI-RAID MASS JOIN DEFENSE
  if (!member.user.bot && cfg.antiNuke && cfg.antiNuke.enabled) {
    const key = `${guild.id}:joins`;
    const now = Date.now();
    let joins = recentActionHistory.get(key) || [];
    joins = joins.filter((t) => now - t < 10000);
    joins.push(now);
    recentActionHistory.set(key, joins);

    if (joins.length >= 6) {
      if (member.kickable) {
        await member.kick("[ANTI-RAID] Mass join raid detected").catch(() => {});
      }
      return;
    }
  }

  // 4. AUTO-ROLE (Supports multiple human and bot roles)
  let autoRoles = [];
  if (member.user.bot) {
    autoRoles = Array.isArray(cfg.botAutoRoleIds) ? cfg.botAutoRoleIds : [];
  } else {
    if (Array.isArray(cfg.humanAutoRoleIds) && cfg.humanAutoRoleIds.length > 0) {
      autoRoles = [...cfg.humanAutoRoleIds];
    } else if (Array.isArray(cfg.autoRoleIds) && cfg.autoRoleIds.length > 0) {
      autoRoles = [...cfg.autoRoleIds];
    } else if (cfg.autoRoleId) {
      autoRoles = [cfg.autoRoleId];
    }
  }

  if (autoRoles.length > 0 && guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    for (const rid of autoRoles) {
      const role = guild.roles.cache.get(rid);
      if (role && role.editable) {
        await member.roles.add(role).catch((err) => console.error(`AutoRole [${role.name}] error:`, err.message));
      }
    }
  }

  // 5. WELCOME CARD
  if (cfg.welcomeChannelId) {
    const ch = guild.channels.cache.get(cfg.welcomeChannelId);
    if (ch) {
      await sendZenithWelcome(ch, member, cfg, guild);
    }
  }

  updateMemberCounters(guild).catch(() => {});
}

async function resolveMediaUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const url = rawUrl.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;

  if (url.match(/\.(gif|png|jpe?g|webp)(\?.*)?$/i)) return { type: "image", url };
  if (url.match(/\.(mp4|webm|mov)(\?.*)?$/i)) return { type: "video", url };

  // Auto-scrape Tenor GIF/MP4 from webpage URL
  if (url.includes("tenor.com")) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" },
        signal: AbortSignal.timeout(5000),
      });
      const html = await res.text();
      const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
      if (ogMatch && ogMatch[1]) return { type: "image", url: ogMatch[1] };

      const gifMatch = html.match(/https:\/\/(?:media[0-9]*|c)\.tenor\.com\/[^"'\s<>]+\.gif/i);
      if (gifMatch) return { type: "image", url: gifMatch[0] };

      const mp4Match = html.match(/https:\/\/(?:media[0-9]*|c)\.tenor\.com\/[^"'\s<>]+\.mp4/i);
      if (mp4Match) return { type: "video", url: mp4Match[0] };
    } catch (e) {
      console.error("[Tenor Resolver] Error:", e.message);
    }
  }

  // Auto-scrape Giphy GIF
  if (url.includes("giphy.com")) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(5000),
      });
      const html = await res.text();
      const ogMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
      if (ogMatch && ogMatch[1]) return { type: "image", url: ogMatch[1] };

      const gifMatch = html.match(/https:\/\/media[0-9]*\.giphy\.com\/media\/[^"'\s<>]+\.gif/i);
      if (gifMatch) return { type: "image", url: gifMatch[0] };
    } catch (e) {}
  }

  return { type: "image", url };
}

async function sendZenithWelcome(ch, member, cfg, guild) {
  if (cfg.welcomeEnabled === false) return;

  const serverName = guild.name || "Zenith Dev";
  const userMention = `${member}`;
  const username = member.user.username;
  const avatar = member.user.displayAvatarURL({ dynamic: true, size: 512 });
  const botAvatar = guild.client.user.displayAvatarURL({ dynamic: true, size: 256 });

  const vars = {
    user: userMention,
    username: username,
    tag: member.user.tag || username,
    server: serverName,
    count: guild.memberCount,
    memberCount: guild.memberCount,
    server_name: serverName,
    server_membercount: guild.memberCount,
    user_id: member.id,
    userId: member.id,
    user_avatar: avatar,
    server_icon: guild.iconURL({ dynamic: true }) || avatar,
  };

  // 1. Content message outside embed
  let contentText = null;
  if (cfg.welcomeMessage && cfg.welcomeMessage.trim()) {
    contentText = formatTpl(cfg.welcomeMessage, vars);
  }

  // 2. If message type is plain text only
  if (cfg.welcomeMessageType === "text") {
    if (!contentText) contentText = `Welcome ${member} to **${serverName}**!`;
    const sentMsg = await ch.send({ content: contentText }).catch((e) => {
      console.error("[Welcome Text Send Error]:", e.message);
    });
    if (sentMsg && cfg.welcomeAutoDelete && cfg.welcomeAutoDelete > 0) {
      setTimeout(() => sentMsg.delete().catch(() => {}), cfg.welcomeAutoDelete * 1000);
    }
    return sentMsg;
  }

  // 3. Bot Identity Customization
  let customBotAvatar = botAvatar;
  if (cfg.welcomeBotAvatar) {
    const wba = cfg.welcomeBotAvatar.trim();
    if (wba === "server") {
      customBotAvatar = guild.iconURL({ dynamic: true }) || botAvatar;
    } else if (wba.startsWith("http")) {
      customBotAvatar = wba;
    }
  }

  // 4. Purely custom Discord Embed
  const embedColor = cfg.welcomeColor
    ? parseInt(cfg.welcomeColor.replace("#", ""), 16)
    : 0x3b82f6;

  const embed = new EmbedBuilder().setColor(embedColor);

  // Author (only if configured)
  if (cfg.welcomeAuthorName && cfg.welcomeAuthorName.trim()) {
    const aName = formatTpl(cfg.welcomeAuthorName, vars);
    let aIcon = undefined;
    if (cfg.welcomeAuthorIcon && cfg.welcomeAuthorIcon.trim()) {
      const ai = cfg.welcomeAuthorIcon.trim();
      if (ai === "server" || ai === "{server_icon}") aIcon = guild.iconURL({ dynamic: true }) || undefined;
      else if (ai === "bot") aIcon = customBotAvatar;
      else if (ai === "user" || ai === "{user_avatar}") aIcon = avatar;
      else if (ai.startsWith("http")) aIcon = ai;
    }
    embed.setAuthor({ name: aName, iconURL: aIcon });
  }

  // Title (only if configured)
  if (cfg.welcomeTitle && cfg.welcomeTitle.trim()) {
    embed.setTitle(formatTpl(cfg.welcomeTitle, vars));
  }

  // Description (only if configured)
  if (cfg.welcomeDescription && cfg.welcomeDescription.trim()) {
    embed.setDescription(formatTpl(cfg.welcomeDescription, vars));
  }

  // Thumbnail (only if configured)
  let thumbUrl = null;
  if (cfg.welcomeThumb && cfg.welcomeThumb.trim()) {
    const wt = cfg.welcomeThumb.trim();
    if (wt === "server" || wt === "{server_icon}") {
      thumbUrl = guild.iconURL({ dynamic: true }) || null;
    } else if (wt === "bot") {
      thumbUrl = customBotAvatar;
    } else if (wt === "user" || wt === "{user_avatar}") {
      thumbUrl = avatar;
    } else if (wt.startsWith("http")) {
      thumbUrl = wt;
    }
  }
  if (thumbUrl) {
    embed.setThumbnail(thumbUrl);
  }

  // Footer (only if configured)
  if (cfg.welcomeFooter && cfg.welcomeFooter.trim()) {
    const fText = formatTpl(cfg.welcomeFooter, vars);
    let fIcon = undefined;
    if (cfg.welcomeFooterIcon && cfg.welcomeFooterIcon.trim()) {
      const fi = cfg.welcomeFooterIcon.trim();
      if (fi === "server" || fi === "{server_icon}") fIcon = guild.iconURL({ dynamic: true }) || undefined;
      else if (fi === "user" || fi === "{user_avatar}") fIcon = avatar;
      else if (fi === "bot") fIcon = customBotAvatar;
      else if (fi.startsWith("http")) fIcon = fi;
    }
    embed.setFooter({ text: fText, iconURL: fIcon });
    embed.setTimestamp();
  }

  // 8. Main Image / Banner (Image Slot 2: Bottom Wide Banner)
  const files = [];
  if (cfg.welcomeImage && typeof cfg.welcomeImage === "string" && cfg.welcomeImage.trim()) {
    const resolved = await resolveMediaUrl(cfg.welcomeImage.trim());
    if (resolved) {
      if (resolved.type === "video") {
        files.push(new AttachmentBuilder(resolved.url, { name: "welcome.mp4" }));
      } else {
        embed.setImage(resolved.url);
      }
    }
  }

  // Safety: Discord requires at least one element in embed or contentText
  const hasEmbedContent = embed.data.title || embed.data.description || embed.data.thumbnail || embed.data.image || embed.data.author || embed.data.footer;
  if (!contentText && !hasEmbedContent) {
    embed.setDescription(`Welcome to **${serverName}**!`);
  }

  const payload = { embeds: [embed], files };
  if (contentText && contentText.trim()) {
    payload.content = contentText;
  }

  const sentMsg = await ch.send(payload).catch((e) => {
    console.error("[Welcome Send Error]:", e.message);
    return null;
  });

  if (sentMsg && cfg.welcomeAutoDelete && cfg.welcomeAutoDelete > 0) {
    setTimeout(() => sentMsg.delete().catch(() => {}), cfg.welcomeAutoDelete * 1000);
  }
  return sentMsg;
}

async function onMemberRemove(member) {
  const guild = member.guild;
  const cfg = getGuild(guild.id);

  // Record Invite Leave
  recordInviteLeave(guild.id, member.id);

  if (cfg.antiNuke && cfg.antiNuke.enabled) {
    await checkAntiNuke(guild, AuditLogEvent.MemberKick, "kick", 2);
  }

  if (cfg.leaveChannelId) {
    const ch = guild.channels.cache.get(cfg.leaveChannelId);
    if (ch) {
      const text = formatTpl(cfg.leaveMessage || "{user} left {server}.", {
        user: member.user?.tag || "A member",
        username: member.user?.username || "A member",
        tag: member.user?.tag || "A member",
        server: guild.name,
        count: guild.memberCount,
      });

      if (cfg.leaveEmbed !== false) {
        const embed = new EmbedBuilder()
          .setTitle("Goodbye")
          .setDescription(text)
          .setColor(0xed4245)
          .setFooter({ text: `${guild.memberCount} members remaining` })
          .setTimestamp();
        await ch.send({ embeds: [embed] }).catch(() => {});
      } else {
        await ch.send(text).catch(() => {});
      }
    }
  }

  updateMemberCounters(guild).catch(() => {});
}

/* =========================================================
   MUSIC ENGINE & PROFESSIONAL CONTROLLER PANEL
========================================================= */

function buildMusicController(guild, track, q) {
  const isPaused = q ? q.paused : false;
  const loopMode = q?.loop || "off";
  const autoPlay = q?.autoplay || false;
  const botIcon = guild?.client?.user?.displayAvatarURL({ dynamic: true }) || "https://cdn.discordapp.com/embed/avatars/0.png";

  const embed = new EmbedBuilder()
    .setAuthor({
      name: "MUSIC PANEL",
      iconURL: botIcon,
    })
    .setColor(0x5865f2)
    .setDescription(` \`${(track.title || "Unknown Track").slice(0, 200)}\``)
    .addFields(
      {
        name: " Requested By",
        value: track.requesterId ? `<@${track.requesterId}>` : `@${track.requester || "aimbot.xd"}`,
        inline: true,
      },
      {
        name: "⏱️ Music Duration",
        value: `\`${track.duration || "3:30"}\``,
        inline: true,
      },
      {
        name: " Music Author",
        value: `\`${(track.author || "Zenith Audio").slice(0, 30)}\``,
        inline: true,
      }
    );

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  // Row 1: Down, Back, Pause/Resume, Skip, Up
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_down")
      .setLabel("Down")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music_back")
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music_pause")
      .setLabel(isPaused ? "Resume" : "Pause")
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("music_skip")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music_up")
      .setLabel("Up")
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 2: Shuffle, Loop, Stop, AutoPlay, Playlist
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_shuffle")
      .setLabel("Shuffle")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music_loop")
      .setLabel(loopMode === "off" ? "Loop" : `Loop: ${loopMode}`)
      .setStyle(loopMode !== "off" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music_stop")
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("music_autoplay")
      .setLabel(autoPlay ? "AutoPlay: ON" : "AutoPlay")
      .setStyle(autoPlay ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("music_playlist")
      .setLabel("Playlist")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

function cleanMusicTitle(raw) {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/\([^)]*(official|video|audio|lyrics|lyrical|remix|full song|hd|4k|cover|prod|feat|ft\.)[^)]*\)/gi, " ");
  s = s.replace(/\b(official music video|official video|official audio|full video song|lyrical video|audio song|video song)\b/gi, " ");
  s = s.replace(/\|.*$/g, " ");
  s = s.replace(/[-–—]\s*$/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\s+song$/gi, "");
  return s.trim();
}

let dynamicScClientId = process.env.SOUNDCLOUD_CLIENT_ID || "Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo";

async function getWorkingSCClientId() {
  if (dynamicScClientId) return dynamicScClientId;
  try {
    const res = await fetch("https://soundcloud.com");
    const html = await res.text();
    const regex = /<script[^>]+src="([^"]+)"/g;
    let match;
    const scripts = [];
    while ((match = regex.exec(html)) !== null) scripts.push(match[1]);
    for (const sc of scripts.slice(-8)) {
      const scRes = await fetch(sc);
      const scText = await scRes.text();
      const idMatch = scText.match(/client_id:"([a-zA-Z0-9]{32})"/);
      if (idMatch) {
        dynamicScClientId = idMatch[1];
        return dynamicScClientId;
      }
    }
  } catch (e) {}
  return "Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo";
}

async function searchSoundCloudDirect(query) {
  try {
    const clientId = await getWorkingSCClientId();
    const isUrl = typeof query === "string" && (query.startsWith("http://") || query.startsWith("https://"));

    let tracks = [];
    if (isUrl && query.includes("soundcloud.com")) {
      const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(query)}&client_id=${clientId}`;
      const res = await fetch(resolveUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
        },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.media && data.media.transcodings) {
          tracks = [data];
        } else if (data.tracks && Array.isArray(data.tracks)) {
          tracks = data.tracks;
        }
      }
    } else {
      const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=6`;
      const res = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
        },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          dynamicScClientId = null;
        }
        return null;
      }

      const data = await res.json();
      tracks = data.collection || [];
    }

    if (!tracks || tracks.length === 0) return null;

    for (const track of tracks) {
      if (!track.media || !track.media.transcodings) continue;
      const transcodings = track.media.transcodings;
      const prog = transcodings.find((t) => t.format && t.format.protocol === "progressive") || transcodings[0];
      if (!prog || !prog.url) continue;

      try {
        const mediaRes = await fetch(`${prog.url}?client_id=${clientId}`, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!mediaRes.ok) continue;
        const mediaData = await mediaRes.json();
        if (mediaData.url) {
          return {
            title: track.title,
            author: track.user?.username || track.user?.name || "SoundCloud Artist",
            url: track.permalink_url || (isUrl ? query : `https://soundcloud.com/${track.id}`),
            streamUrl: mediaData.url,
            duration: formatDuration(track.duration),
            thumbnail: track.artwork_url || track.user?.avatar_url || null,
          };
        }
      } catch (e) {}
    }
  } catch (err) {
    console.warn("[Zenith Music] Direct SC search error:", err.message);
  }
  return null;
}

async function searchJioSaavnDirect(query) {
  try {
    const isUrl = typeof query === "string" && (query.startsWith("http://") || query.startsWith("https://"));
    if (isUrl) return null;

    const searchUrl = `https://jiosaavn-api.vercel.app/search?query=${encodeURIComponent(query)}`;
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const songs = data.results || [];
    if (songs.length === 0) return null;

    const first = songs[0];
    const songRes = await fetch(`https://jiosaavn-api.vercel.app/song?id=${first.id}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!songRes.ok) return null;
    const songData = await songRes.json();
    if (songData.media_url) {
      return {
        title: songData.song || first.title,
        author: songData.singers || songData.primary_artists || "Artist",
        url: songData.perma_url || first.perma_url || `https://www.jiosaavn.com/song/${first.id}`,
        streamUrl: songData.media_url,
        duration: "4:30",
        thumbnail: songData.image || first.image || null,
      };
    }
  } catch (err) {
    console.warn("[Zenith Music] Saavn direct search notice:", err.message);
  }
  return null;
}

async function resolvePlayableTrack(rawQuery, requester = "aimbot.xd", requesterId = null) {
  const q = (rawQuery || "").trim();
  if (!q) return null;

  const isUrl = q.startsWith("http://") || q.startsWith("https://");

  // Priority 1: High-Speed Saavn Studio CDN (Direct 160kbps AAC without rate limits)
  if (!isUrl) {
    try {
      const cleanQ = cleanMusicTitle(q);
      const saavnTrack = (await searchJioSaavnDirect(q)) || (cleanQ ? await searchJioSaavnDirect(cleanQ) : null);
      if (saavnTrack && saavnTrack.streamUrl) {
        return {
          ...saavnTrack,
          requester,
          requesterId,
        };
      }
    } catch (saavnErr) {
      console.warn("[Zenith Music] Saavn search attempt notice:", saavnErr.message);
    }
  }

  // Priority 2: Direct SoundCloud resolution (Search or URL)
  try {
    const cleanQ = cleanMusicTitle(q);
    const scDirect = (await searchSoundCloudDirect(q)) || (cleanQ ? await searchSoundCloudDirect(cleanQ) : null);
    if (scDirect && scDirect.streamUrl) {
      return {
        ...scDirect,
        requester,
        requesterId,
      };
    }
  } catch (scDirectErr) {
    console.warn("[Zenith Music] Direct SC search attempt error:", scDirectErr.message);
  }

  // Priority 2: If YouTube URL, extract title and resolve via SoundCloud CDN
  let searchTerms = [];
  let fallbackThumbnail = null;
  let fallbackDuration = "3:30";

  if (isUrl && (q.includes("youtube.com") || q.includes("youtu.be"))) {
    let ytTitle = "";
    let ytAuthor = "";
    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(q)}&format=json`);
      if (oembedRes.ok) {
        const data = await oembedRes.json();
        ytTitle = data.title || "";
        ytAuthor = data.author_name || "";
        fallbackThumbnail = data.thumbnail_url || null;
      }
    } catch (_) {}

    if (!ytTitle) {
      try {
        const info = await play.video_basic_info(q);
        ytTitle = info.video_details?.title || "";
        ytAuthor = info.video_details?.channel?.name || "";
        fallbackDuration = info.video_details?.durationRaw || "3:30";
        fallbackThumbnail = info.video_details?.thumbnails?.[0]?.url || fallbackThumbnail;
      } catch (_) {}
    }

    if (ytTitle) {
      const cleanT = cleanMusicTitle(ytTitle);
      searchTerms = [cleanT, ytTitle, `${ytAuthor} ${cleanT}`.trim()].filter(Boolean);
    } else {
      searchTerms = [q];
    }
  } else {
    // Normal query (e.g. song title or artist)
    const cleanT = cleanMusicTitle(q);
    searchTerms = [];
    if (cleanT) searchTerms.push(cleanT);
    if (q !== cleanT) searchTerms.push(q);
  }

  // Priority 3: Try Direct SoundCloud on cleaned search terms
  for (const term of searchTerms) {
    try {
      const scMatch = await searchSoundCloudDirect(term);
      if (scMatch && scMatch.streamUrl) {
        return {
          ...scMatch,
          requester,
          requesterId,
          thumbnail: scMatch.thumbnail || fallbackThumbnail,
          duration: scMatch.duration || fallbackDuration,
        };
      }
    } catch (_) {}
  }

  // Priority 4: Fallback to play-dl search if direct SC CDN resolution had no matches
  await getSCClient();
  for (const term of searchTerms) {
    try {
      let results = await play.search(term, { limit: 6, source: { soundcloud: "tracks" } }).catch(() => []);
      if (!results || results.length === 0) {
        await getSCClient(true);
        results = await play.search(term, { limit: 6, source: { soundcloud: "tracks" } }).catch(() => []);
      }
      if (!results || results.length === 0) continue;

      for (const item of results) {
        try {
          let stream = null;
          try {
            stream = await play.stream(item.url);
          } catch (_) {
            await getSCClient(true);
            stream = await play.stream(item.url).catch(() => null);
          }
          if (stream && stream.stream) {
            return {
              title: item.name || term,
              author: item.user?.name || "SoundCloud Artist",
              url: item.url,
              duration: formatDuration(item.durationInMs) || fallbackDuration,
              thumbnail: item.thumbnail || fallbackThumbnail,
              requester,
              requesterId,
              preloadedStream: stream,
            };
          }
        } catch (_) {}
      }
    } catch (searchErr) {
      console.warn(`[Zenith Music] SC search error for "${term}":`, searchErr.message);
    }
  }

  // Priority 5: Fallback to YouTube
  try {
    const ytResults = await play.search(q, { limit: 3, source: { youtube: "video" } }).catch(() => []);
    if (ytResults && ytResults.length > 0) {
      for (const ytItem of ytResults) {
        const cleanYt = cleanMusicTitle(ytItem.title);
        if (cleanYt) {
          const directMatch = await searchSoundCloudDirect(cleanYt);
          if (directMatch && directMatch.streamUrl) {
            return {
              ...directMatch,
              requester,
              requesterId,
              thumbnail: directMatch.thumbnail || ytItem.thumbnails?.[0]?.url || fallbackThumbnail,
            };
          }
        }

        try {
          const ytStream = await play.stream(ytItem.url).catch(() => null);
          if (ytStream && ytStream.stream) {
            return {
              title: ytItem.title,
              author: ytItem.channel?.name || "YouTube Creator",
              url: ytItem.url,
              duration: ytItem.durationRaw || fallbackDuration,
              thumbnail: ytItem.thumbnails?.[0]?.url || fallbackThumbnail,
              requester,
              requesterId,
              preloadedStream: ytStream,
            };
          }
        } catch (_) {}
      }
    }
  } catch (ytErr) {
    console.warn("[Zenith Music] YouTube fallback search notice:", ytErr.message);
  }

  return null;
}

const music = {
  async play(interaction, query) {
    const member = interaction.member;
    const voice = member.voice?.channel;
    if (!voice) return interaction.reply({ content: "[X] You must join a voice channel first to play music!", flags: 64 });

    const botPermissions = voice.permissionsFor(interaction.guild.members.me);
    if (botPermissions && (!botPermissions.has(PermissionFlagsBits.Connect) || !botPermissions.has(PermissionFlagsBits.Speak))) {
      return interaction.reply({
        content: "[X] I need **Connect** and **Speak** permissions in your voice channel!",
        flags: 64,
      });
    }

    await interaction.deferReply();
    try {
      const trackInfo = await resolvePlayableTrack(query, interaction.user.tag, interaction.user.id);
      if (!trackInfo) {
        return interaction.editReply(`[X] No playable music track found for **"${(query || "").slice(0, 100)}"**. Please try another song title or artist name.`);
      }

      let q = queues.get(interaction.guildId);
      const isConnectionDead =
        !q ||
        !q.connection ||
        q.connection.state.status === VoiceConnectionStatus.Destroyed ||
        q.connection.state.status === VoiceConnectionStatus.Disconnected;

      if (isConnectionDead) {
        if (q?.connection) {
          try {
            q.connection.destroy();
          } catch (e) {}
        }

        const connection = joinVoiceChannel({
          channelId: voice.id,
          guildId: interaction.guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });

        try {
          await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        } catch (connErr) {
          console.warn("[Zenith Music] Voice connection ready state timeout:", connErr.message);
        }

        connection.on(VoiceConnectionStatus.Disconnected, () => {
          try {
            connection.destroy();
          } catch (e) {}
          queues.delete(interaction.guildId);
        });

        connection.on(VoiceConnectionStatus.Destroyed, () => {
          queues.delete(interaction.guildId);
        });

        const player = createAudioPlayer({
          behaviors: {
            noSubscriber: NoSubscriberBehavior.Play,
          },
        });

        player.on("stateChange", (oldState, newState) => {
          console.log(`[Zenith Music ${interaction.guildId}] Player: ${oldState.status} -> ${newState.status}`);
        });

        player.on("error", (err) => {
          console.error(`[Zenith AudioPlayer Error]:`, err.message);
          const currentQueue = queues.get(interaction.guildId);
          if (currentQueue && currentQueue.tracks.length > 0) {
            const next = currentQueue.tracks.shift();
            music.startTrack(interaction.guildId, next, true);
          } else if (currentQueue) {
            currentQueue.playing = false;
            currentQueue.current = null;
          }
        });

        player.on(AudioPlayerStatus.Idle, async () => {
          const currentQueue = queues.get(interaction.guildId);
          if (!currentQueue) return;

          // 1. Loop Track
          if (currentQueue.loop === "track" && currentQueue.current) {
            return music.startTrack(interaction.guildId, currentQueue.current, true);
          }

          // 2. Next in queue
          if (currentQueue.tracks.length > 0) {
            const nextTrack = currentQueue.tracks.shift();
            return music.startTrack(interaction.guildId, nextTrack, true);
          }

          // 3. Loop Queue
          if (currentQueue.loop === "queue" && currentQueue.history?.length > 0) {
            currentQueue.tracks = [...currentQueue.history];
            currentQueue.history = [];
            const nextTrack = currentQueue.tracks.shift();
            return music.startTrack(interaction.guildId, nextTrack, true);
          }

          // 4. AutoPlay
          if (currentQueue.autoplay && currentQueue.current) {
            try {
              const searchSeed = currentQueue.current.author || currentQueue.current.title.split("-")[0] || "popular songs";
              const related = await play.search(searchSeed, { limit: 5, source: { soundcloud: "tracks" } }).catch(() => []);
              const candidate = related.find((r) => r.url !== currentQueue.current.url);
              if (candidate) {
                const autoTrack = {
                  title: candidate.name,
                  author: candidate.user?.name || "AutoPlay",
                  url: candidate.url,
                  duration: formatDuration(candidate.durationInMs),
                  thumbnail: candidate.thumbnail || null,
                  requester: "AutoPlay",
                  requesterId: interaction.client.user.id,
                };
                return music.startTrack(interaction.guildId, autoTrack, true);
              }
            } catch (apErr) {
              console.warn("[Zenith Music AutoPlay Error]", apErr.message);
            }
          }

          currentQueue.playing = false;
          currentQueue.current = null;
        });

        connection.subscribe(player);

        q = {
          connection,
          player,
          tracks: [],
          history: [],
          current: null,
          playing: false,
          paused: false,
          volume: 100,
          loop: "off",
          autoplay: false,
          textChannel: interaction.channel,
          panelMessage: null,
        };
        queues.set(interaction.guildId, q);
      } else {
        if (q.connection.joinConfig.channelId !== voice.id) {
          q.connection.rejoin({ channelId: voice.id, selfDeaf: false, selfMute: false });
        }
      }

      q.textChannel = interaction.channel;

      if (!q.playing) {
        q.playing = true;
        await music.startTrack(interaction.guildId, trackInfo);
        const panel = buildMusicController(interaction.guild, trackInfo, q);
        const panelMsg = await interaction.editReply(panel);
        q.panelMessage = panelMsg;
        return panelMsg;
      } else {
        q.tracks.push(trackInfo);
        const queueEmbed = new EmbedBuilder()
          .setTitle("Added to Queue")
          .setDescription(` **${trackInfo.title}**`)
          .setColor(0x5865f2)
          .addFields(
            { name: "Position", value: `#${q.tracks.length}`, inline: true },
            { name: "Duration", value: `\`${trackInfo.duration || "3:30"}\``, inline: true },
            { name: "Requested by", value: `<@${interaction.user.id}>`, inline: true }
          );
        if (trackInfo.thumbnail) queueEmbed.setThumbnail(trackInfo.thumbnail);
        return interaction.editReply({ embeds: [queueEmbed] });
      }
    } catch (err) {
      console.error("[Zenith Music Play Error Details]:", err);
      const errMsg = (err && err.message) ? err.message : "Unknown music playback error";
      return interaction.editReply(`Music error: ${errMsg}`);
    }
  },

  async startTrack(guildId, track, isAutoAdvance = false) {
    const q = queues.get(guildId);
    if (!q) return;
    try {
      console.log(`[Zenith Music] Starting playback for: "${track.title}" (${track.url})`);

      let resource = null;
      if (track.streamUrl && typeof track.streamUrl === "string") {
        resource = createAudioResource(track.streamUrl, {
          inlineVolume: true,
        });
      } else if (track.preloadedStream && track.preloadedStream.stream) {
        const stream = track.preloadedStream;
        delete track.preloadedStream;
        resource = createAudioResource(stream.stream, {
          inputType: stream.type,
          inlineVolume: true,
        });
      } else {
        const directTrack = (await searchJioSaavnDirect(track.title || track.url)) || (await searchSoundCloudDirect(track.title || track.url));
        if (directTrack && directTrack.streamUrl) {
          track.streamUrl = directTrack.streamUrl;
          resource = createAudioResource(directTrack.streamUrl, {
            inlineVolume: true,
          });
        } else if (track.url) {
          await getSCClient();
          let stream = null;
          try {
            stream = await play.stream(track.url);
          } catch (streamErr) {
            console.warn("[Zenith Music] Primary stream failed, refreshing client token:", streamErr.message);
            await getSCClient(true);
            stream = await play.stream(track.url).catch(() => null);
          }
          if (stream && stream.stream) {
            resource = createAudioResource(stream.stream, {
              inputType: stream.type,
              inlineVolume: true,
            });
          }
        }
      }

      if (!resource) {
        const fallbackTrack = (await searchJioSaavnDirect(track.title || "popular hindi songs")) || (await searchSoundCloudDirect(track.title || "popular songs"));
        if (fallbackTrack && fallbackTrack.streamUrl) {
          track.streamUrl = fallbackTrack.streamUrl;
          resource = createAudioResource(fallbackTrack.streamUrl, {
            inlineVolume: true,
          });
        }
      }

      if (!resource) {
        throw new Error(`Unable to extract audio stream for "${track.title || "this song"}". Please try another track.`);
      }

      if (resource.volume) {
        resource.volume.setVolume((q.volume || 100) / 100);
      }
      q.currentResource = resource;

      if (resource.playStream) {
        resource.playStream.on("error", (err) => {
          console.error("[Zenith Music Resource Stream Error]:", err.message);
          const currentQueue = queues.get(guildId);
          if (currentQueue && currentQueue.tracks.length > 0) {
            const next = currentQueue.tracks.shift();
            music.startTrack(guildId, next, true);
          } else if (currentQueue) {
            currentQueue.playing = false;
            currentQueue.current = null;
          }
        });
      }

      if (q.current && q.current.url !== track.url) {
        if (!q.history) q.history = [];
        q.history.push(q.current);
        if (q.history.length > 25) q.history.shift();
      }

      q.current = track;
      q.playing = true;
      q.paused = false;
      q.player.play(resource);
      console.log(`[Zenith Music] Audio resource dispatched to player: "${track.title}"`);

      // If auto-advanced to next track from idle, post updated music controller in channel
      if (isAutoAdvance && q.textChannel) {
        const guild = q.textChannel.guild;
        const panel = buildMusicController(guild, track, q);
        q.textChannel.send(panel).then((msg) => {
          q.panelMessage = msg;
        }).catch(() => {});
      }
    } catch (err) {
      console.error("[Zenith Music] Failed to stream track:", err.message);
      if (q.tracks.length > 0) {
        const next = q.tracks.shift();
        await music.startTrack(guildId, next, true);
      } else {
        q.playing = false;
        q.current = null;
      }
    }
  },
};

/* =========================================================
   COMMANDS DEFINITION (TempVoice, Zenith Ticket & Security)
========================================================= */

function commands() {
  return [
    new SlashCommandBuilder().setName("help").setDescription("Show all bot commands and setup instructions"),
    new SlashCommandBuilder().setName("ping").setDescription("Check bot latency and gateway ping"),
    new SlashCommandBuilder().setName("invite").setDescription("Get official bot invite link to add Zenith to your server"),

    // TempVoice / Join to Create
    new SlashCommandBuilder()
      .setName("tempvoice")
      .setDescription("Manage automatic Join to Create temporary voice channels")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addSubcommand((s) => s.setName("setup").setDescription("Create Join to Create voice category and channel"))
      .addSubcommand((s) => s.setName("disable").setDescription("Disable Join to Create voice system")),

    new SlashCommandBuilder()
      .setName("voice")
      .setDescription("Manage your temporary custom voice channel")
      .addSubcommand((s) => s.setName("lock").setDescription("Lock your voice channel for everyone"))
      .addSubcommand((s) => s.setName("unlock").setDescription("Unlock your voice channel for everyone"))
      .addSubcommand((s) =>
        s
          .setName("name")
          .setDescription("Change the name of your voice channel")
          .addStringOption((o) => o.setName("title").setDescription("New name").setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName("limit")
          .setDescription("Set the user capacity limit for your voice channel")
          .addIntegerOption((o) => o.setName("count").setDescription("0 for unlimited, or 1-99").setRequired(true).setMinValue(0).setMaxValue(99))
      )
      .addSubcommand((s) => s.setName("claim").setDescription("Claim ownership of this temporary voice channel"))
      .addSubcommand((s) =>
        s
          .setName("transfer")
          .setDescription("Transfer ownership to another member currently in this voice channel")
          .addUserOption((o) => o.setName("user").setDescription("Member in this VC").setRequired(true))
      )
      .addSubcommand((s) => s.setName("delete").setDescription("Delete your temporary voice channel")),

    // Anti-Nuke Suite
    new SlashCommandBuilder()
      .setName("antinuke")
      .setDescription("Enterprise server protection, anti-bot, and anti-raid system")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName("enable").setDescription("Enable all anti-nuke protection modules"))
      .addSubcommand((s) => s.setName("disable").setDescription("Disable anti-nuke protection"))
      .addSubcommand((s) => s.setName("status").setDescription("View current anti-nuke configuration and active shields"))
      .addSubcommand((s) =>
        s
          .setName("whitelist_add")
          .setDescription("Whitelist a trusted admin from security triggers")
          .addUserOption((o) => o.setName("user").setDescription("Trusted user").setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName("whitelist_remove")
          .setDescription("Remove a user from security whitelist")
          .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName("action")
          .setDescription("Choose punishment action when an attack is detected")
          .addStringOption((o) =>
            o
              .setName("type")
              .setDescription("Punishment")
              .setRequired(true)
              .addChoices(
                { name: "Strip All Roles (Quarantine)", value: "strip_roles" },
                { name: "Ban Offender", value: "ban" },
                { name: "Kick Offender", value: "kick" }
              )
          )
      )
      .addSubcommand((s) =>
        s
          .setName("anti_alt")
          .setDescription("Block fake/alt accounts with fresh account creation age")
          .addBooleanOption((o) => o.setName("enabled").setDescription("Enable or disable fake member blocker").setRequired(true))
          .addIntegerOption((o) => o.setName("min_days").setDescription("Minimum account age in days (e.g. 3, 7, 14)").setMinValue(1).setMaxValue(90))
      )
      .addSubcommand((s) =>
        s
          .setName("anti_invite")
          .setDescription("Block unauthorized Discord invite links")
          .addBooleanOption((o) => o.setName("enabled").setDescription("Enable or disable invite link blocker").setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName("anti_spam")
          .setDescription("Block mass-mentions and spam attacks")
          .addBooleanOption((o) => o.setName("enabled").setDescription("Enable or disable mass-mention spam protection").setRequired(true))
      ),

    // Emergency Lockdown
    new SlashCommandBuilder()
      .setName("lockdown")
      .setDescription("Server emergency lockdown during active raid")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName("on").setDescription("Lock all channels across the entire server"))
      .addSubcommand((s) => s.setName("off").setDescription("Restore channels back to normal")),

    // Zenith Ticket Suite
    new SlashCommandBuilder()
      .setName("ticket")
      .setDescription("Zenith Ticket support ticket management suite")
      .addSubcommand((s) =>
        s
          .setName("panel")
          .setDescription("Deploy an interactive multi-category ticket panel")
          .addStringOption((o) => o.setName("title").setDescription("Panel header title"))
          .addStringOption((o) => o.setName("description").setDescription("Panel instructions"))
          .addRoleOption((o) => o.setName("support_role").setDescription("Staff role to ping on new tickets"))
      )
      .addSubcommand((s) =>
        s
          .setName("priority")
          .setDescription("Set ticket priority level")
          .addStringOption((o) =>
            o
              .setName("level")
              .setDescription("Priority")
              .setRequired(true)
              .addChoices(
                { name: "Low Priority", value: "Low" },
                { name: "Medium Priority", value: "Medium" },
                { name: "High Priority", value: "High" },
                { name: "Urgent Priority", value: "Urgent" }
              )
          )
      )
      .addSubcommand((s) => s.setName("claim").setDescription("Claim this ticket as the active staff member"))
      .addSubcommand((s) => s.setName("closerequest").setDescription("Send a close approval request to ticket author"))
      .addSubcommand((s) => s.setName("close").setDescription("Close ticket and generate HTML transcript"))
      .addSubcommand((s) => s.setName("transcript").setDescription("Export HTML transcript of this ticket channel")),

    // Welcome & Leave
    new SlashCommandBuilder()
      .setName("welcome")
      .setDescription("Configure welcome greeting card, banner image, and auto-role")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) =>
        s
          .setName("setup")
          .setDescription("Set welcome channel and style")
          .addChannelOption((o) => o.setName("channel").setDescription("Welcome channel").setRequired(true))
          .addBooleanOption((o) => o.setName("embed").setDescription("Use styled embed card?"))
      )
      .addSubcommand((s) =>
        s
          .setName("message")
          .setDescription("Outer ping text ({user}, {username}, {server}, {count})")
          .addStringOption((o) => o.setName("text").setDescription("Welcome message").setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName("title")
          .setDescription("Embed card header (e.g. Wlcm To Zenith Dev)")
          .addStringOption((o) => o.setName("text").setDescription("Title text").setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName("tagline")
          .setDescription("Embed tagline (e.g. Welcome to server)")
          .addStringOption((o) => o.setName("text").setDescription("Tagline text").setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName("subtext")
          .setDescription("Embed bottom channels/subtext line")
          .addStringOption((o) => o.setName("text").setDescription("Subtext line").setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName("description")
          .setDescription("Set full card description text in one go (overrides title & tagline)")
          .addStringOption((o) => o.setName("text").setDescription("Description text").setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName("clear")
          .setDescription("Clear a custom welcome field")
          .addStringOption((o) =>
            o
              .setName("field")
              .setDescription("Field to clear")
              .setRequired(true)
              .addChoices(
                { name: "title", value: "title" },
                { name: "tagline", value: "tagline" },
                { name: "subtext", value: "subtext" },
                { name: "description", value: "description" },
                { name: "image", value: "image" }
              )
          )
      )
      .addSubcommand((s) =>
        s
          .setName("image")
          .setDescription("Custom welcome banner / divider image URL")
          .addStringOption((o) => o.setName("url").setDescription("Direct image URL (png/jpg/gif)").setRequired(true))
      )
      .addSubcommand((s) => s.setName("image_remove").setDescription("Remove welcome banner image"))
      .addSubcommand((s) =>
        s
          .setName("autorole")
          .setDescription("Assign a role automatically to new joining members")
          .addRoleOption((o) => o.setName("role").setDescription("Role to assign").setRequired(true))
      )
      .addSubcommand((s) => s.setName("disable").setDescription("Disable welcome messages"))
      .addSubcommand((s) => s.setName("test").setDescription("Send a test welcome message in this channel")),

    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Configure leave / goodbye message")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) =>
        s
          .setName("setup")
          .setDescription("Set leave channel")
          .addChannelOption((o) => o.setName("channel").setDescription("Leave channel").setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName("message")
          .setDescription("Set leave text")
          .addStringOption((o) => o.setName("text").setDescription("Leave message").setRequired(true))
      )
      .addSubcommand((s) => s.setName("disable").setDescription("Disable leave messages")),

    new SlashCommandBuilder()
      .setName("afk")
      .setDescription("Set your AFK status with an optional reason")
      .addStringOption((o) => o.setName("reason").setDescription("Why are you AFK?")),

    new SlashCommandBuilder().setName("membercount").setDescription("Show live server member counts"),

    new SlashCommandBuilder()
      .setName("counter")
      .setDescription("Manage automatic voice channel member counters")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addSubcommand((s) => s.setName("setup").setDescription("Create voice counter channels (Total, Humans, Bots)"))
      .addSubcommand((s) => s.setName("disable").setDescription("Remove voice counter channels")),

    // Music commands
    new SlashCommandBuilder()
      .setName("play")
      .setDescription("Play a song in your voice channel")
      .addStringOption((o) => o.setName("query").setDescription("Song name or URL").setRequired(true)),
    new SlashCommandBuilder().setName("pause").setDescription("Pause current music"),
    new SlashCommandBuilder().setName("resume").setDescription("Resume paused music"),
    new SlashCommandBuilder().setName("skip").setDescription("Skip the current song"),
    new SlashCommandBuilder().setName("stop").setDescription("Stop music and disconnect"),
    new SlashCommandBuilder().setName("queue").setDescription("Show the music queue"),
    new SlashCommandBuilder().setName("nowplaying").setDescription("Show current song info"),
    new SlashCommandBuilder()
      .setName("volume")
      .setDescription("Set playback volume (1-100)")
      .addIntegerOption((o) => o.setName("level").setDescription("1 to 100").setRequired(true).setMinValue(1).setMaxValue(100)),

    // Channel Locks
    new SlashCommandBuilder()
      .setName("lock")
      .setDescription("Lock current channel for @everyone")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    new SlashCommandBuilder()
      .setName("unlock")
      .setDescription("Unlock current channel for @everyone")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    // Utility & Info
    new SlashCommandBuilder().setName("serverinfo").setDescription("Display detailed information about this server"),
    new SlashCommandBuilder()
      .setName("userinfo")
      .setDescription("Display detailed information about a user")
      .addUserOption((o) => o.setName("user").setDescription("Target user")),
    new SlashCommandBuilder()
      .setName("avatar")
      .setDescription("View full resolution avatar of a user")
      .addUserOption((o) => o.setName("user").setDescription("Target user")),
    new SlashCommandBuilder().setName("botinfo").setDescription("Display bot statistics, host specs, and ping"),

    // Moderation
    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("Ban a member")
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    new SlashCommandBuilder()
      .setName("kick")
      .setDescription("Kick a member")
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    new SlashCommandBuilder()
      .setName("timeout")
      .setDescription("Timeout a member")
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addIntegerOption((o) => o.setName("minutes").setDescription("Minutes").setRequired(true).setMinValue(1).setMaxValue(40320))
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("Warn a member")
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    new SlashCommandBuilder()
      .setName("warnings")
      .setDescription("List warnings for a member")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
    new SlashCommandBuilder()
      .setName("purge")
      .setDescription("Bulk delete recent messages")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addIntegerOption((o) => o.setName("count").setDescription("1-100").setRequired(true).setMinValue(1).setMaxValue(100)),

    // Economy
    new SlashCommandBuilder().setName("balance").setDescription("Show coins and level").addUserOption((o) => o.setName("user").setDescription("User")),
    new SlashCommandBuilder().setName("daily").setDescription("Claim daily coins"),
    new SlashCommandBuilder()
      .setName("pay")
      .setDescription("Pay coins to another user")
      .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
      .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),
    new SlashCommandBuilder().setName("leaderboard").setDescription("XP and coins leaderboard"),

    // Custom commands
    new SlashCommandBuilder()
      .setName("custom")
      .setDescription("Custom prefix text commands")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Add a custom command")
          .addStringOption((o) => o.setName("name").setDescription("Trigger name").setRequired(true))
          .addStringOption((o) => o.setName("response").setDescription("Reply text").setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName("remove").setDescription("Remove a custom command").addStringOption((o) => o.setName("name").setDescription("Name").setRequired(true))
      )
      .addSubcommand((s) => s.setName("list").setDescription("List custom commands")),

    new SlashCommandBuilder().setName("stats").setDescription("Bot, guild, and counter stats"),

    // Server Announcements
    new SlashCommandBuilder()
      .setName("announce")
      .setDescription("Post a styled server announcement embed")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addChannelOption((o) => o.setName("channel").setDescription("Target channel").setRequired(true))
      .addStringOption((o) => o.setName("title").setDescription("Announcement title").setRequired(true))
      .addStringOption((o) => o.setName("message").setDescription("Announcement text").setRequired(true))
      .addStringOption((o) => o.setName("image").setDescription("Optional banner image or GIF URL"))
      .addStringOption((o) => o.setName("ping").setDescription("Ping audience").addChoices(
        { name: "None", value: "none" },
        { name: "@everyone", value: "everyone" },
        { name: "@here", value: "here" }
      )),

    // Server Rules
    new SlashCommandBuilder()
      .setName("rules")
      .setDescription("Post server rules embed")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((o) => o.setName("channel").setDescription("Target channel").setRequired(true))
      .addStringOption((o) => o.setName("title").setDescription("Rules title").setRequired(false))
      .addStringOption((o) => o.setName("text").setDescription("Custom rules text (leave blank for standard rules)").setRequired(false))
      .addStringOption((o) => o.setName("image").setDescription("Optional header image URL")),

    // Invite Tracking System
    new SlashCommandBuilder()
      .setName("invites")
      .setDescription("Display invite statistics for yourself or a target member")
      .addUserOption((o) => o.setName("user").setDescription("Target member").setRequired(false)),
    new SlashCommandBuilder()
      .setName("guildinvites")
      .setDescription("Track all server invites with total uses and effective members")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("addinvites")
      .setDescription("Add or remove bonus invites for a user")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName("user").setDescription("Target member").setRequired(true))
      .addIntegerOption((o) => o.setName("amount").setDescription("Number of bonus invites to add (or negative to remove)").setRequired(true)),
    new SlashCommandBuilder()
      .setName("invitereset")
      .setDescription("Reset invite counts for a user or entire guild")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((o) => o.setName("target").setDescription("Scope of reset").setRequired(true).addChoices(
        { name: "User", value: "user" },
        { name: "Entire Guild", value: "guild" }
      ))
      .addUserOption((o) => o.setName("user").setDescription("Target member (required if resetting User)").setRequired(false)),
  ].map((c) => c.toJSON());
}

/* =========================================================
   EMERGENCY SERVER LOCKDOWN HELPER
========================================================= */

async function executeLockdown(guild, isLock) {
  let count = 0;
  for (const channel of guild.channels.cache.values()) {
    if (channel.type === ChannelType.GuildText) {
      await channel.permissionOverwrites.edit(guild.id, {
        SendMessages: isLock ? false : null,
      }).catch(() => {});
      count++;
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(isLock ? "SERVER EMERGENCY LOCKDOWN ACTIVATED" : "SERVER LOCKDOWN LIFTED")
    .setColor(isLock ? 0xed4245 : 0x57f287)
    .setDescription(
      isLock
        ? `All ${count} text channels have been **LOCKED** for @everyone due to an active security emergency.`
        : `All ${count} text channels have been **UNLOCKED**. Normal server permissions restored.`
    )
    .setTimestamp();

  await sendLog(guild, { embeds: [embed] }).catch(() => {});
  return { isLock, count, embed };
}

/* =========================================================
   SLASH COMMAND DISPATCHER
========================================================= */

async function handleSlash(interaction) {
  bump("commands");
  const name = interaction.commandName;

  // Guard: All slash commands require a guild context — block DM usage
  if (!interaction.guild || !interaction.member) {
    return interaction.reply({
      content: "This command can only be used inside a server.",
      flags: 64, // EPHEMERAL
    }).catch(() => {});
  }

  const guildCfg = getGuild(interaction.guildId);

  // /announce
  if (name === "announce") {
    const ch = interaction.options.getChannel("channel");
    const title = interaction.options.getString("title");
    const message = interaction.options.getString("message");
    const image = interaction.options.getString("image");
    const ping = interaction.options.getString("ping") || "none";

    await sendServerAnnouncement(interaction.guild, ch, { title, message, image, ping });
    return interaction.reply({ content: `Announcement posted to ${ch}!`, flags: 64 });
  }

  // /rules
  if (name === "rules") {
    const ch = interaction.options.getChannel("channel");
    const title = interaction.options.getString("title");
    const text = interaction.options.getString("text");
    const image = interaction.options.getString("image");

    await sendServerRules(interaction.guild, ch, { title, text, image });
    return interaction.reply({ content: `Server rules posted to ${ch}!`, flags: 64 });
  }

  // /dmjoin (Permanently disabled to comply with Discord Developer Terms of Service)
  if (name === "dmjoin") {
    return interaction.reply({
      content: "[X] **Command Disabled:** Mass DM broadcasting violates Discord Developer Policy and has been permanently removed to protect bot integrity.",
      flags: 64,
    });
  }

  // /ping (Ultra-Fast Dual Ping Benchmark)
  if (name === "ping") {
    const sent = await interaction.reply({ content: "Testing latency...", fetchReply: true });
    const roundTrip = sent.createdTimestamp - interaction.createdTimestamp;
    const wsPing = interaction.client.ws.ping;
    return interaction.editReply(`Gateway Ping: **${wsPing}ms** | REST API Latency: **${roundTrip}ms** | Status: **Optimal**`);
  }

  // /invite
  if (name === "invite") {
    const inviteUrl = "https://tinyurl.com/zenith-bot-app";
    const supportUrl = process.env.SUPPORT_SERVER || "https://discord.gg/RmV56QrpPg";
    const dashUrl = process.env.DASHBOARD_URL || "https://zenith.apps.bot-hosting.cloud/";
    const embed = new EmbedBuilder()
      .setTitle("Zenith – Unbreakable Server Defense & All-in-One Community Management")
      .setColor(0x5865f2)
      .setDescription(
        `[SHIELD] **Zenith – Unbreakable Server Defense & All-in-One Community Management.**\n\n` +
        `> **Dashboard :** [${dashUrl}](${dashUrl})\n` +
        `> **Server :** [${supportUrl}](${supportUrl})\n` +
        `> **Invite :** [${inviteUrl}](${inviteUrl})\n` +
        `> **Commands :** \`/help\``
      )
      .setFooter({ text: "Zenith Public Bot • Unbreakable Security" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Invite Zenith").setStyle(ButtonStyle.Link).setURL(inviteUrl),
      new ButtonBuilder().setLabel("Support Server").setStyle(ButtonStyle.Link).setURL(supportUrl),
      new ButtonBuilder().setLabel("Web Dashboard").setStyle(ButtonStyle.Link).setURL(dashUrl)
    );
    return interaction.reply({ embeds: [embed], components: [row] });
  }

  // /invites
  if (name === "invites") {
    const targetUser = interaction.options.getUser("user") || interaction.user;
    const inv = getUserInvites(interaction.guildId, targetUser.id);

    const embed = new EmbedBuilder()
      .setTitle(`Invite Statistics: ${targetUser.username}`)
      .setColor(0x5865f2)
      .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
      .addFields(
        { name: "Total", value: `${inv.total}`, inline: true },
        { name: "Real", value: `${inv.real}`, inline: true },
        { name: "Leaves", value: `${inv.left}`, inline: true },
        { name: "Fake", value: `${inv.fake}`, inline: true },
        { name: "Bonus", value: `${inv.bonus >= 0 ? "+" + inv.bonus : inv.bonus}`, inline: true },
        { name: "Effective", value: `**${inv.effective}**`, inline: true }
      )
      .setFooter({ text: `${interaction.guild.name} • Zenith Invite Tracker`, iconURL: interaction.guild.iconURL() || undefined })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  // /guildinvites
  if (name === "guildinvites") {
    const me = interaction.guild.members.me;
    if (!me || !me.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: "Zenith requires **Manage Server** permission to read and track guild invites.",
        flags: 64,
      });
    }

    await interaction.deferReply();
    try {
      const invites = await interaction.guild.invites.fetch().catch(() => null);
      if (!invites || invites.size === 0) {
        return interaction.editReply("No active invites found for this server.");
      }

      const sorted = [...invites.values()].sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 15);

      const embed = new EmbedBuilder()
        .setTitle(`Active Guild Invites — ${interaction.guild.name}`)
        .setColor(0x5865f2)
        .setDescription(
          sorted.map((inv, idx) => {
            const inviter = inv.inviter ? `<@${inv.inviter.id}>` : "Unknown";
            const code = inv.code;
            const uses = inv.uses || 0;
            const stats = inv.inviter ? getUserInvites(interaction.guildId, inv.inviter.id) : null;
            const effective = stats ? stats.real : uses;
            return `\`${code}\` by ${inviter} — **${uses}** total uses (${effective} effective)`;
          }).join("\n\n") || "No invites tracked."
        )
        .setFooter({ text: `Total Active Invites: ${invites.size}` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply(`Failed to fetch server invites: ${err.message}`);
    }
  }

  // /addinvites
  if (name === "addinvites") {
    const target = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");
    if (!target) return interaction.reply({ content: "Please specify a target user.", flags: 64 });

    const updated = addBonusInvites(interaction.guildId, target.id, amount);
    const sign = amount >= 0 ? `+${amount}` : `${amount}`;

    const embed = new EmbedBuilder()
      .setTitle("Bonus Invites Adjusted")
      .setColor(0x5865f2)
      .setDescription(
        `Adjusted bonus invites for ${target}:\n\n` +
        `• Adjustment: **${sign}**\n` +
        `• Current Bonus: **${updated.bonus}**\n` +
        `• Real: **${updated.real}** | Leaves: **${updated.left}** | Fake: **${updated.fake}**\n` +
        `• Total Uses: **${updated.total}**\n` +
        `• Net Effective: **${updated.effective}**`
      )
      .setFooter({ text: "Zenith Invite Tracker" })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  // /invitereset
  if (name === "invitereset") {
    const target = interaction.options.getString("target");
    const targetUser = interaction.options.getUser("user");

    if (target === "user") {
      if (!targetUser) {
        return interaction.reply({ content: "Please select a target user when resetting user invites.", flags: 64 });
      }
      resetUserInvites(interaction.guildId, targetUser.id);
      return interaction.reply({
        content: `Successfully reset all invite statistics for ${targetUser}.`,
        flags: 64,
      });
    } else {
      resetUserInvites(interaction.guildId, "all");
      return interaction.reply({
        content: `Successfully reset all invite records for **${interaction.guild.name}**.`,
        flags: 64,
      });
    }
  }

  // /tempvoice
  if (name === "tempvoice") {
    const sub = interaction.options.getSubcommand();
    if (sub === "setup") {
      await interaction.deferReply();
      try {
        const jtc = await setupTempVoice(interaction.guild);
        return interaction.editReply({
          embeds: [
            logEmbed(
              "TempVoice Enabled",
              `Join-to-Create voice system is ready!\n\n` +
              `• Voice Channel: ${jtc}\n` +
              `• When any member joins, their private custom voice channel is created automatically.\n` +
              `• Channels are automatically deleted when empty.`,
              0x57f287
            ),
          ],
        });
      } catch (err) {
        return interaction.editReply(`Failed to setup TempVoice: ${err.message}`);
      }
    }
    if (sub === "disable") {
      await disableTempVoice(interaction.guild);
      return interaction.reply("Join to Create voice system disabled and channels cleaned.");
    }
  }

  // /voice
  // /voice (Restricted to room creator only)
  if (name === "voice") {
    const sub = interaction.options.getSubcommand();
    const voiceState = interaction.member.voice;
    const channel = voiceState?.channel;
    if (!channel) {
      return interaction.reply({ content: "You must be connected to your custom voice channel to use /voice commands.", flags: 64 });
    }

    const room = getTempVoiceRoom(channel, interaction.guild, guildCfg);
    if (!room) {
      return interaction.reply({ content: "This is not an active temporary custom voice channel.", flags: 64 });
    }

    const activeRooms = guildCfg.tempVoice?.activeRooms || {};

    // Strict Access Control: User must be the creator of the room or Administrator (except for claiming)
    if (sub !== "claim" && room.ownerId && room.ownerId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "Access Denied: You can only use /voice commands for your own temporary voice channel that you created.",
        flags: 64,
      });
    }

    if (sub === "lock") {
      room.locked = true;
      guildCfg.tempVoice.activeRooms = activeRooms;
      save();
      await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: false }).catch(() => {});
      return interaction.reply({ content: "Voice channel is now **LOCKED** for others.", flags: 64 });
    }

    if (sub === "unlock") {
      room.locked = false;
      guildCfg.tempVoice.activeRooms = activeRooms;
      save();
      await channel.permissionOverwrites.edit(interaction.guild.id, { Connect: null }).catch(() => {});
      return interaction.reply({ content: "Voice channel is now **UNLOCKED** for everyone.", flags: 64 });
    }

    if (sub === "name") {
      const newTitle = interaction.options.getString("title");
      await channel.setName(newTitle.slice(0, 95)).catch(() => {});
      return interaction.reply({ content: `Voice channel renamed to **${newTitle}**`, flags: 64 });
    }

    if (sub === "limit") {
      const limit = interaction.options.getInteger("count");
      await channel.setUserLimit(limit).catch(() => {});
      return interaction.reply({ content: `User capacity set to **${limit === 0 ? "Unlimited" : limit}**`, flags: 64 });
    }

    if (sub === "delete") {
      delete activeRooms[channel.id];
      guildCfg.tempVoice.activeRooms = activeRooms;
      save();
      await interaction.reply({ content: "Deleting your temporary voice channel...", flags: 64 });
      return channel.delete().catch(() => {});
    }

    if (sub === "claim") {
      const currentOwnerInVC = channel.members.has(room.ownerId);
      if (currentOwnerInVC && room.ownerId !== interaction.user.id) {
        return interaction.reply({ content: "[X] The current owner is still inside this voice channel.", flags: 64 });
      }
      if (room.ownerId === interaction.user.id) {
        return interaction.reply({ content: "You are already the owner of this voice channel.", flags: 64 });
      }

      room.ownerId = interaction.user.id;
      guildCfg.tempVoice.activeRooms = activeRooms;
      save();

      await channel.permissionOverwrites.edit(interaction.user.id, {
        ManageChannels: true,
        MoveMembers: true,
        MuteMembers: true,
        DeafenMembers: true,
        PrioritySpeaker: true,
      }).catch(() => {});

      return interaction.reply(`[OWNER] Ownership of this temporary room transferred to ${interaction.user}!`);
    }

    if (sub === "transfer") {
      const targetUser = interaction.options.getUser("user");
      if (targetUser.id === interaction.user.id) {
        return interaction.reply({ content: "You are already the owner of this voice channel.", flags: 64 });
      }
      if (targetUser.bot) {
        return interaction.reply({ content: "You cannot transfer ownership to a bot.", flags: 64 });
      }
      if (!channel.members.has(targetUser.id)) {
        return interaction.reply({
          content: `[X] **Failed:** <@${targetUser.id}> is not connected to this voice channel! You can only transfer ownership to someone who is currently in your VC.`,
          flags: 64,
        });
      }

      room.ownerId = targetUser.id;
      guildCfg.tempVoice.activeRooms = activeRooms;
      save();

      await channel.permissionOverwrites.edit(targetUser.id, {
        ManageChannels: true,
        MoveMembers: true,
        MuteMembers: true,
        DeafenMembers: true,
        PrioritySpeaker: true,
      }).catch(() => {});

      await interaction.reply({ content: `Ownership successfully transferred to <@${targetUser.id}>!`, flags: 64 });
      return channel.send(`[OWNER] **New Host:** Ownership of this voice channel has been transferred to <@${targetUser.id}>!`).catch(() => {});
    }
  }

  // /help (Role-Aware: Separates Normal Member vs Administrator)
  if (name === "help") {
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
                    interaction.guild.ownerId === interaction.user.id;

    if (!isAdmin) {
      // 1. NORMAL USER / MEMBER VIEW (100% Censored from Admin/Nuke/Mod Commands)
      const userEmbed = new EmbedBuilder()
        .setTitle("Zenith - Member Command Guide")
        .setColor(0x5865f2)
        .setDescription(
          `Welcome, ${interaction.user}!\n\n` +
          `**Zenith – Unbreakable Server Defense & All-in-One Community Management.**\n\n` +
          `> **Lead Developer :** **Aimbot** (\`aimbot.xd\`) • <@1407070875039301713>\n` +
          `> **Dev Bio :** \`</> Dev : C++ | Python\`\n` +
          `> **Dashboard :** https://zenith.apps.bot-hosting.cloud/\n` +
          `> **Server :** https://discord.gg/RmV56QrpPg\n` +
          `> **Invite :** https://tinyurl.com/zenith-bot-app\n` +
          `> **Commands :** \`/help\``
        )
        .addFields(
          {
            name: "TempVoice - Custom Voice Channels",
            value:
              "**How to Use:**\n" +
              "Join the `Join to Create` voice channel. Zenith will create your personal voice room and move you in.\n\n" +
              "**Your Room Controls (When you create a VC):**\n" +
              "- `/voice lock` - Lock your room so others cannot join\n" +
              "- `/voice unlock` - Unlock your room for everyone\n" +
              "- `/voice name title:<name>` - Rename your voice room\n" +
              "- `/voice limit count:<0-99>` - Set member capacity (0 = Unlimited)\n" +
              "- `/voice claim` - Take ownership if host left the room\n" +
              "- `/voice delete` - Close and delete your custom room\n\n" +
              "*Or use the 5 interactive buttons (Name, Limit, Privacy, Claim, Delete) in the voice text chat!*",
          },
          {
            name: "Music & Entertainment (24/7 Audio)",
            value:
              "- `/play [song/url]` - Stream music from YouTube/SoundCloud in your VC\n" +
              "- `/pause` & `/resume` - Pause or resume playback\n" +
              "- `/skip` - Jump to next track in queue\n" +
              "- `/stop` - Stop music and disconnect bot\n" +
              "- `/queue` - View upcoming tracks\n" +
              "- `/nowplaying` - Inspect current song info\n" +
              "- `/volume <1-100>` - Adjust audio volume",
          },
          {
            name: "Support & Help Desk",
            value:
              "Click any button on the server's **Support Panel** to open a private ticket with staff.\n" +
              "- `/ticket close` - Close your support ticket when resolved",
          },
          {
            name: "Coins, Activity & Leveling",
            value:
              "- `/daily` - Claim free daily coins every 24 hours\n" +
              "- `/balance` - View your coins and chat XP level\n" +
              "- `/pay user:<@user> amount:<coins>` - Send coins to a friend\n" +
              "- `/leaderboard` - Server XP and coin rankings\n" +
              "- `/afk reason:<reason>` - Set away status with auto-responder",
          },
          {
            name: "Profile & Utility",
            value:
              "- `/avatar [user]` - View and download full HD avatars\n" +
              "- `/membercount` - Live member statistics\n" +
              "- `/ping` - Real-time bot speed and latency\n" +
              "- `/warnings` - View your own warning record",
          }
        )
        .setFooter({ text: "Zenith Public Bot • Crafted & Engineered by Aimbot" });

      return interaction.reply({ embeds: [userEmbed], flags: 64 });
    }

    // 2. ADMINISTRATOR & SERVER OWNER VIEW (Full Master Control)
    const adminEmbed = new EmbedBuilder()
      .setTitle("Zenith - Executive Admin Command Center")
      .setColor(0xed4245)
      .setDescription(
        "**Master Administrator Access Detected.**\n\n" +
        "**Zenith – Unbreakable Server Defense & All-in-One Community Management.**\n\n" +
        "> **Lead Developer :** **Aimbot** (`aimbot.xd`) • <@1407070875039301713>\n" +
        "> **Dev Bio :** `</> Dev : C++ | Python`\n" +
        "> **Dashboard :** https://zenith.apps.bot-hosting.cloud/\n" +
        "> **Server :** https://discord.gg/RmV56QrpPg\n" +
        "> **Invite :** https://tinyurl.com/zenith-bot-app\n" +
        "> **Commands :** `/help`"
      )
      .addFields(
        {
          name: "Enterprise Anti-Nuke & Server Shield",
          value:
            "- `/antinuke enable / disable / status` - Master protection toggles\n" +
            "- `/antinuke anti_alt` - Block burner/alt accounts younger than X days\n" +
            "- `/antinuke anti_invite` - Block unauthorized Discord invite links\n" +
            "- `/antinuke anti_spam` - Timeout mass-mention attackers (>5 pings)\n" +
            "- `/antinuke action` - Set punishment (`strip_roles`, `ban`, `kick`)\n" +
            "- `/antinuke whitelist_add / remove` - Exempt trusted co-owners\n" +
            "- `/lockdown on / off` - Emergency server-wide channels lockdown\n" +
            "- `/lock / /unlock` - Lock or unlock current text channel",
        },
        {
          name: "TempVoice Management",
          value:
            "- `/tempvoice setup` - Deploy automated Join to Create voice hub\n" +
            "- `/tempvoice disable` - Remove and clean up TempVoice channels",
        },
        {
          name: "Zenith Ticket Support Desk",
          value:
            "- `/ticket panel` - Deploy multi-category interactive button panel\n" +
            "- `/ticket priority` - Set ticket urgency (Low, Medium, High, Urgent)\n" +
            "- `/ticket claim` - Assign staff member to handle ticket\n" +
            "- `/ticket closerequest` - Request member confirmation before closing\n" +
            "- `/ticket close` - Close ticket, archive HTML transcript & send DM rating\n" +
            "- `/ticket add / remove` - Manage participants in ticket channel",
        },
        {
          name: "Automated Staff Moderation & Logs",
          value:
            "- Moderation: `/warn`, `/timeout`, `/kick`, `/ban`, `/purge`\n" +
            "- Security Logging: `/logging setup / test / disable`\n" +
            "- Leveling Setup: `/leveling enable / disable / channel / multiplier`\n" +
            "- Reaction Roles: `/reactionrole create / remove / list`\n" +
            "- Giveaways: `/giveaway start / reroll / end`",
        },
        {
          name: "Community Welcomer & Leave Alerts",
          value:
            "- `/welcome setup / message / image / autorole / test` - Dyno-style welcome card\n" +
            "- `/leave setup / message / disable` - Departure farewell messages\n" +
            "- `/counter setup / disable` - Automatic voice member statistics\n" +
            "- `/custom add / remove / list` - Custom prefix text commands",
        },
        {
          name: "Music, XP & General Tools",
          value:
            "- Music: `/play`, `/pause`, `/resume`, `/skip`, `/stop`, `/queue`, `/volume`\n" +
            "- Economy: `/daily`, `/balance`, `/pay`, `/leaderboard`\n" +
            "- Info: `/botinfo`, `/serverinfo`, `/userinfo`, `/stats`, `/ping`",
        }
      )
      .setFooter({ text: "Zenith Master Admin Console • Crafted & Engineered by Aimbot" });

    return interaction.reply({ embeds: [adminEmbed], flags: 64 });
  }

  // /antinuke
  if (name === "antinuke") {
    const sub = interaction.options.getSubcommand();
    if (sub === "enable") {
      guildCfg.antiNuke.enabled = true;
      save();
      return interaction.reply({
        embeds: [logEmbed("Anti-Nuke Enabled", "Server protection is now active. Mass channel/role deletes, mass bans, unauthorized bot additions, and webhooks are protected.", 0x57f287)],
      });
    }
    if (sub === "disable") {
      guildCfg.antiNuke.enabled = false;
      save();
      return interaction.reply({
        embeds: [logEmbed("Anti-Nuke Disabled", "Server protection is now inactive.", 0xed4245)],
      });
    }
    if (sub === "status") {
      const an = guildCfg.antiNuke;
      const wl = an.whitelist?.length ? an.whitelist.map((id) => `<@${id}>`).join(", ") : "None";
      const embed = new EmbedBuilder()
        .setTitle("Security & Anti-Nuke Status")
        .setColor(an.enabled ? 0x57f287 : 0xed4245)
        .addFields(
          { name: "Shield Status", value: an.enabled ? "ACTIVE" : "DISABLED", inline: true },
          { name: "Punishment Action", value: `\`${(an.action || "STRIP_ROLES").toUpperCase()}\``, inline: true },
          { name: "Anti-Fake Member", value: an.antiAlt ? `Active (${an.minAccountAgeDays || 3}d min)` : "Disabled", inline: true },
          { name: "Anti-Invite Blocker", value: an.antiInvite ? "Enabled" : "Disabled", inline: true },
          { name: "Anti-Spam Filter", value: an.antiSpam ? "Enabled" : "Disabled", inline: true },
          { name: "Whitelisted Admins", value: wl }
        )
        .setDescription(
          `**Rate Limits (10-second threshold):**\n` +
          `Channel Deletions: \`${an.limits?.channelDelete || 2}\`\n` +
          `Channel Creations: \`${an.limits?.channelCreate || 3}\`\n` +
          `Role Deletions: \`${an.limits?.roleDelete || 2}\`\n` +
          `Role Creations: \`${an.limits?.roleCreate || 3}\`\n` +
          `Bans / Kicks: \`${an.limits?.ban || 2}\`\n` +
          `Webhook Creations: \`${an.limits?.webhook || 2}\`\n` +
          `Unauthorized Bot Additions: \`${an.limits?.botAdd || 1}\``
        );
      return interaction.reply({ embeds: [embed] });
    }
    if (sub === "whitelist_add") {
      const u = interaction.options.getUser("user");
      if (!guildCfg.antiNuke.whitelist) guildCfg.antiNuke.whitelist = [];
      if (!guildCfg.antiNuke.whitelist.includes(u.id)) {
        guildCfg.antiNuke.whitelist.push(u.id);
        save();
      }
      return interaction.reply({ content: `Added ${u} to security whitelist.`, flags: 64 });
    }
    if (sub === "whitelist_remove") {
      const u = interaction.options.getUser("user");
      guildCfg.antiNuke.whitelist = (guildCfg.antiNuke.whitelist || []).filter((id) => id !== u.id);
      save();
      return interaction.reply({ content: `Removed ${u} from security whitelist.`, flags: 64 });
    }
    if (sub === "action") {
      const act = interaction.options.getString("type");
      guildCfg.antiNuke.action = act;
      save();
      return interaction.reply(`Anti-Nuke punishment set to: **${act.toUpperCase()}**`);
    }
    if (sub === "anti_alt") {
      const state = interaction.options.getBoolean("enabled");
      const days = interaction.options.getInteger("min_days") || 3;
      guildCfg.antiNuke.antiAlt = state;
      guildCfg.antiNuke.minAccountAgeDays = days;
      save();
      return interaction.reply(`Anti-Fake Member protection is now **${state ? `ENABLED (Minimum account age: ${days} days)` : "DISABLED"}**.`);
    }
    if (sub === "anti_invite") {
      const state = interaction.options.getBoolean("enabled");
      guildCfg.antiNuke.antiInvite = state;
      save();
      return interaction.reply(`Anti-Invite link protection has been **${state ? "ENABLED" : "DISABLED"}**.`);
    }
    if (sub === "anti_spam") {
      const state = interaction.options.getBoolean("enabled");
      guildCfg.antiNuke.antiSpam = state;
      save();
      return interaction.reply(`Anti-Spam & Mass-mention protection has been **${state ? "ENABLED" : "DISABLED"}**.`);
    }
  }

  // /lockdown on / off
  if (name === "lockdown") {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply();
    const isLock = sub === "on";
    const result = await executeLockdown(interaction.guild, isLock);
    return interaction.editReply({ embeds: [result.embed] });
  }

  // /ticket
  if (name === "ticket") {
    const sub = interaction.options.getSubcommand();

    // /ticket panel
    if (sub === "panel") {
      const title = interaction.options.getString("title") || "Support Tickets - Zenith Ticket";
      const desc = interaction.options.getString("description") || "Select a ticket category below to open a private support inquiry with our staff team.";
      const supportRole = interaction.options.getRole("support_role");
      if (supportRole) {
        guildCfg.supportRoleId = supportRole.id;
        save();
      }

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(`${desc}\n\n**Categories:**\n• General Support\n• Billing & Orders\n• Staff Applications\n• Bug & Technical Reports`)
        .setColor(0x5865f2)
        .setFooter({ text: "Zenith Ticket | Powered by Zenith" });

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket_open:general").setLabel("General Support").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ticket_open:billing").setLabel("Billing & Orders").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ticket_open:staff").setLabel("Staff Application").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ticket_open:bug").setLabel("Report Bug").setStyle(ButtonStyle.Danger)
      );

      return interaction.reply({ embeds: [embed], components: [row1] });
    }

    const ticket = getTicket(interaction.channelId);

    // /ticket priority
    if (sub === "priority") {
      if (!ticket) return interaction.reply({ content: "This is not a support ticket channel.", flags: 64 });
      const lvl = interaction.options.getString("level");
      updateTicket(interaction.channelId, { priority: lvl });

      const colorMap = { Low: 0x57f287, Medium: 0xfee75c, High: 0xe67e22, Urgent: 0xed4245 };
      await interaction.channel.setTopic(`Ticket #${ticket.ticketNum} | Priority: ${lvl} | Handled by: ${ticket.claimedBy ? `<@${ticket.claimedBy}>` : "Unclaimed"}`).catch(() => {});

      const embed = new EmbedBuilder()
        .setTitle("Ticket Priority Updated")
        .setDescription(`Ticket priority has been marked as **${lvl.toUpperCase()}** by ${interaction.user}.`)
        .setColor(colorMap[lvl] || 0x5865f2);

      return interaction.reply({ embeds: [embed] });
    }

    // /ticket claim
    if (sub === "claim") {
      if (!ticket) return interaction.reply({ content: "This is not a support ticket channel.", flags: 64 });
      if (ticket.claimedBy) {
        return interaction.reply({ content: `This ticket is already claimed by <@${ticket.claimedBy}>.`, flags: 64 });
      }
      updateTicket(interaction.channelId, { claimedBy: interaction.user.id });
      await interaction.channel.setTopic(`Ticket #${ticket.ticketNum} | Claimed by: ${interaction.user.tag}`).catch(() => {});

      const embed = new EmbedBuilder()
        .setTitle("Ticket Claimed")
        .setDescription(`This ticket is now being handled by **${interaction.user}**. Other staff members may spectate.`)
        .setColor(0x57f287);

      return interaction.reply({ embeds: [embed] });
    }

    // /ticket closerequest
    if (sub === "closerequest") {
      if (!ticket) return interaction.reply({ content: "This is not a support ticket channel.", flags: 64 });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket_close_accept").setLabel("Accept Close").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("ticket_close_deny").setLabel("Keep Open").setStyle(ButtonStyle.Secondary)
      );
      const embed = new EmbedBuilder()
        .setTitle("Close Request")
        .setDescription(`<@${ticket.userId}>, staff member ${interaction.user} has requested to close this ticket. Please confirm if your inquiry has been resolved.`)
        .setColor(0xfee75c);

      return interaction.reply({ embeds: [embed], components: [row] });
    }

    // /ticket close
    if (sub === "close") {
      if (!ticket) return interaction.reply({ content: "This is not a support ticket channel.", flags: 64 });
      await closeTicketChannel(interaction.channel, interaction.user);
      return interaction.reply({ content: "Closing ticket and exporting transcript...", flags: 64 });
    }

    // /ticket transcript
    if (sub === "transcript") {
      if (!ticket) return interaction.reply({ content: "This is not a support ticket channel.", flags: 64 });
      await interaction.deferReply();
      const filePath = await generateTranscript(interaction.channel, ticket);
      const appUrl = process.env.PUBLIC_URL || "https://zenith.apps.bot-hosting.cloud";
      if (filePath && fs.existsSync(filePath)) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("View Transcript Online")
            .setStyle(ButtonStyle.Link)
            .setURL(`${appUrl}/transcript/${interaction.channel.id}`)
        );
        return interaction.editReply({
          content: `Transcript generated for **#${interaction.channel.name}**:`,
          components: [row],
        });
      }
      return interaction.editReply("Could not generate transcript.");
    }
  }

  // /welcome
  if (name === "welcome") {
    const sub = interaction.options.getSubcommand();
    if (sub === "setup") {
      const ch = interaction.options.getChannel("channel");
      const useEmbed = interaction.options.getBoolean("embed") ?? true;
      guildCfg.welcomeChannelId = ch.id;
      guildCfg.welcomeEmbed = useEmbed;
      save();
      return interaction.reply(`Welcome channel set to ${ch} (Embed: ${useEmbed ? "Yes" : "No"})`);
    }
    if (sub === "message") {
      const text = interaction.options.getString("text");
      guildCfg.welcomeMessage = text;
      save();
      return interaction.reply(`Welcome message template updated.\nPreview: ${text}`);
    }
    if (sub === "title") {
      const text = interaction.options.getString("text");
      guildCfg.welcomeTitle = text;
      save();
      return interaction.reply(`[OK] Welcome card title updated to:\n${text}`);
    }
    if (sub === "tagline") {
      const text = interaction.options.getString("text");
      guildCfg.welcomeTagline = text;
      save();
      return interaction.reply(`[OK] Welcome card tagline updated to:\n${text}`);
    }
    if (sub === "subtext") {
      const text = interaction.options.getString("text");
      guildCfg.welcomeSubtext = text;
      save();
      return interaction.reply(`[OK] Welcome card subtext updated to:\n${text}`);
    }
    if (sub === "description") {
      const text = interaction.options.getString("text");
      guildCfg.welcomeDescription = text;
      save();
      return interaction.reply(`[OK] Welcome card description updated to:\n${text}`);
    }
    if (sub === "clear") {
      const field = interaction.options.getString("field");
      if (field === "title") guildCfg.welcomeTitle = null;
      if (field === "tagline") guildCfg.welcomeTagline = null;
      if (field === "subtext") guildCfg.welcomeSubtext = null;
      if (field === "description") guildCfg.welcomeDescription = null;
      if (field === "image") guildCfg.welcomeImage = null;
      save();
      return interaction.reply(`[OK] Cleared welcome field: **${field}**.`);
    }
    if (sub === "image") {
      const url = interaction.options.getString("url");
      guildCfg.welcomeImage = url;
      save();
      const embed = new EmbedBuilder()
        .setTitle("Welcome Banner Set")
        .setDescription(`New welcome banner set. Preview below:`)
        .setColor(0x57f287);
      const isVideo = url.includes(".mp4") || url.includes(".webm") || url.includes(".mov");
      const files = [];
      if (isVideo) {
        files.push(new AttachmentBuilder(url, { name: "welcome.mp4" }));
      } else {
        embed.setImage(url);
      }
      return interaction.reply({ embeds: [embed], files });
    }
    if (sub === "image_remove") {
      guildCfg.welcomeImage = null;
      save();
      return interaction.reply("Welcome banner image removed.");
    }
    if (sub === "autorole") {
      const role = interaction.options.getRole("role");
      guildCfg.autoRoleId = role.id;
      save();
      return interaction.reply(`Auto-role set to **${role.name}**. New members will receive this role automatically.`);
    }
    if (sub === "disable") {
      guildCfg.welcomeChannelId = null;
      save();
      return interaction.reply("Welcome messages disabled.");
    }
    if (sub === "test") {
      const targetCh = interaction.guild.channels.cache.get(guildCfg.welcomeChannelId) || interaction.channel;
      await sendZenithWelcome(targetCh, interaction.member, guildCfg, interaction.guild);
      return interaction.reply({ content: `[OK] Test welcome card sent in ${targetCh}!`, flags: 64 });
    }
  }

  // /leave
  if (name === "leave") {
    const sub = interaction.options.getSubcommand();
    if (sub === "setup") {
      const ch = interaction.options.getChannel("channel");
      guildCfg.leaveChannelId = ch.id;
      save();
      return interaction.reply(`Leave channel set to ${ch}`);
    }
    if (sub === "message") {
      const text = interaction.options.getString("text");
      guildCfg.leaveMessage = text;
      save();
      return interaction.reply("Leave message updated.");
    }
    if (sub === "disable") {
      guildCfg.leaveChannelId = null;
      save();
      return interaction.reply("Leave messages disabled.");
    }
  }

  // /afk
  if (name === "afk") {
    const reason = interaction.options.getString("reason") || "AFK";
    setAfk(interaction.user.id, reason, interaction.guildId);
    return interaction.reply({
      embeds: [
        logEmbed("AFK Status Set", `You are now AFK: **${reason}**\nWhen someone mentions you, they will be notified. Send any message to remove your AFK status.`, 0xfee75c),
      ],
    });
  }

  // /membercount
  if (name === "membercount") {
    await interaction.guild.members.fetch().catch(() => {});
    const total = interaction.guild.memberCount;
    const bots = interaction.guild.members.cache.filter((m) => m.user.bot).size;
    const humans = total - bots;
    const online = interaction.guild.members.cache.filter((m) => m.presence?.status === "online").size;
    const idle = interaction.guild.members.cache.filter((m) => m.presence?.status === "idle").size;
    const dnd = interaction.guild.members.cache.filter((m) => m.presence?.status === "dnd").size;
    const offline = total - (online + idle + dnd);

    const embed = new EmbedBuilder()
      .setTitle(`${interaction.guild.name} Member Counts`)
      .setColor(0x5865f2)
      .addFields(
        { name: "Total Members", value: `**${total}**`, inline: true },
        { name: "Humans", value: `**${humans}**`, inline: true },
        { name: "Bots", value: `**${bots}**`, inline: true },
        { name: "Online", value: `${online}`, inline: true },
        { name: "Idle", value: `${idle}`, inline: true },
        { name: "DND", value: `${dnd}`, inline: true }
      )
      .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  // /counter
  if (name === "counter") {
    const sub = interaction.options.getSubcommand();
    if (sub === "setup") {
      await interaction.deferReply();
      try {
        const stats = await setupMemberCounters(interaction.guild);
        return interaction.editReply({
          embeds: [
            logEmbed(
              "Voice Member Counters Created",
              `Voice channels created under **SERVER STATS**:\n` +
              `Total: ${stats.total}\n` +
              `Humans: ${stats.humans}\n` +
              `Bots: ${stats.bots}\n\n` +
              `*Channels will auto-update when members join or leave.*`,
              0x57f287
            ),
          ],
        });
      } catch (err) {
        return interaction.editReply(`Failed to create counters: ${err.message}`);
      }
    }
    if (sub === "disable") {
      await disableMemberCounters(interaction.guild);
      return interaction.reply("Voice member counter channels removed.");
    }
  }

  // Music Commands
  if (name === "play") {
    const q = interaction.options.getString("query");
    return music.play(interaction, q);
  }

  if (name === "pause") {
    const q = queues.get(interaction.guildId);
    if (!q || !q.player || !q.current) return interaction.reply({ content: "[X] No music is currently playing. Use `/play <song>` to start playing music!", flags: 64 });
    q.player.pause();
    q.paused = true;
    return interaction.reply("⏸️ Music paused.");
  }

  if (name === "resume") {
    const q = queues.get(interaction.guildId);
    if (!q || !q.player || !q.current) return interaction.reply({ content: "[X] No music is currently playing. Use `/play <song>` to start playing music!", flags: 64 });
    q.player.unpause();
    q.paused = false;
    return interaction.reply("▶️ Music resumed.");
  }

  if (name === "skip") {
    const q = queues.get(interaction.guildId);
    if (!q || !q.player || !q.current) return interaction.reply({ content: "[X] No music is currently playing. Use `/play <song>` to start playing music!", flags: 64 });
    if (q.tracks.length > 0) {
      const next = q.tracks.shift();
      await interaction.reply("⏭️ Skipped current track.");
      return music.startTrack(interaction.guildId, next, true);
    } else {
      q.playing = false;
      q.current = null;
      q.player.stop();
      return interaction.reply("⏭️ Skipped current track. Queue is now empty.");
    }
  }

  if (name === "stop") {
    const q = queues.get(interaction.guildId);
    if (!q) return interaction.reply({ content: "[X] No music is currently playing.", flags: 64 });
    q.tracks = [];
    q.history = [];
    q.playing = false;
    q.current = null;
    try { q.player?.stop(); } catch (e) {}
    try { q.connection?.destroy(); } catch (e) {}
    queues.delete(interaction.guildId);
    return interaction.reply("⏹️ Music stopped and disconnected from voice channel.");
  }

  if (name === "queue") {
    const q = queues.get(interaction.guildId);
    if (!q || (!q.current && q.tracks.length === 0)) {
      return interaction.reply({ content: "The music queue is currently empty. Use `/play <song>` to add tracks!", flags: 64 });
    }
    const currentSong = q.current ? ` **Now Playing:** ${q.current.title} (${q.current.duration})\n\n` : "";
    const list = q.tracks.slice(0, 10).map((t, idx) => `**${idx + 1}.** ${t.title} (${t.duration})`).join("\n");
    const embed = new EmbedBuilder()
      .setTitle("Music Queue")
      .setColor(0x5865f2)
      .setDescription(currentSong + (list ? `**Up Next:**\n${list}` : "*No upcoming tracks in queue.*"))
      .setFooter({ text: `Total queue length: ${q.tracks.length + (q.current ? 1 : 0)} songs` });
    return interaction.reply({ embeds: [embed] });
  }

  if (name === "nowplaying") {
    const q = queues.get(interaction.guildId);
    if (!q || !q.current) return interaction.reply({ content: "[X] No music is currently playing. Use `/play <song>` to start playing music in your voice channel!", flags: 64 });
    const panel = buildMusicController(interaction.guild, q.current, q);
    return interaction.reply(panel);
  }

  if (name === "volume") {
    const level = interaction.options.getInteger("level");
    const q = queues.get(interaction.guildId);
    if (!q) return interaction.reply({ content: "Nothing is currently playing.", flags: 64 });
    q.volume = level;
    if (q.player && q.player.state && q.player.state.resource && q.player.state.resource.volume) {
      q.player.state.resource.volume.setVolume(level / 100);
    }
    return interaction.reply(`[VC] Volume set to **${level}%**.`);
  }

  // /lock & /unlock
  if (name === "lock" || name === "unlock") {
    const channel = interaction.channel;
    const isLock = name === "lock";
    await channel.permissionOverwrites.edit(interaction.guild.id, {
      SendMessages: isLock ? false : null,
    });
    return interaction.reply({
      embeds: [
        logEmbed(
          isLock ? "Channel Locked" : "Channel Unlocked",
          `Channel has been ${isLock ? "locked" : "unlocked"} for @everyone by ${interaction.user}.`,
          isLock ? 0xed4245 : 0x57f287
        ),
      ],
    });
  }

  // /serverinfo (Censored & Private)
  if (name === "serverinfo") {
    const g = interaction.guild;
    const isStaff = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

    const embed = new EmbedBuilder()
      .setTitle(`${g.name} (Overview)`)
      .setThumbnail(g.iconURL({ dynamic: true, size: 256 }))
      .setColor(0x5865f2)
      .addFields(
        { name: "Owner", value: isStaff ? `<@${g.ownerId}>` : "Protected", inline: true },
        { name: "Members", value: `${g.memberCount}`, inline: true },
        { name: "Channels", value: `${g.channels.cache.size}`, inline: true },
        { name: "Roles", value: `${g.roles.cache.size}`, inline: true },
        { name: "Boosts", value: `Tier ${g.premiumTier} (${g.premiumSubscriptionCount || 0} boosts)`, inline: true },
        { name: "Created", value: `<t:${Math.floor(g.createdTimestamp / 1000)}:D>`, inline: true }
      )
      .setFooter({ text: "Server metrics (Protected & Censored)" })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  // /userinfo (Censored & Private)
  if (name === "userinfo") {
    const target = interaction.options.getMember("user") || interaction.member;
    const u = target.user;
    const isSelf = u.id === interaction.user.id;
    const isStaff = interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers);

    const displayId = (isSelf || isStaff) ? u.id : `${u.id.slice(0, 4)}••••••••••${u.id.slice(-3)}`;

    const embed = new EmbedBuilder()
      .setTitle(`${u.username} (Profile)`)
      .setThumbnail(u.displayAvatarURL({ dynamic: true, size: 256 }))
      .setColor(0x5865f2)
      .addFields(
        { name: "User ID", value: `\`${displayId}\``, inline: true },
        { name: "Nickname", value: target.nickname || "None", inline: true },
        { name: "Joined Server", value: target.joinedTimestamp ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>` : "Unknown", inline: true },
        { name: "Account Created", value: (isSelf || isStaff) ? `<t:${Math.floor(u.createdTimestamp / 1000)}:R>` : "Hidden for Privacy", inline: true },
        { name: `Roles [${target.roles.cache.size - 1}]`, value: target.roles.cache.filter((r) => r.id !== interaction.guild.id).map((r) => `${r}`).slice(0, 8).join(" ") || "None" }
      )
      .setFooter({ text: "Profile details (Protected & Censored)" })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  // /avatar (Private)
  if (name === "avatar") {
    const u = interaction.options.getUser("user") || interaction.user;
    const embed = new EmbedBuilder()
      .setTitle(`${u.username}'s Avatar`)
      .setImage(u.displayAvatarURL({ dynamic: true, size: 1024 }))
      .setColor(0x5865f2)
      .setDescription(`[PNG](${u.displayAvatarURL({ extension: "png", size: 1024 })}) | [WEBP](${u.displayAvatarURL({ extension: "webp", size: 1024 })}) | [JPG](${u.displayAvatarURL({ extension: "jpg", size: 1024 })})`);
    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  // /botinfo (Censored & Private)
  if (name === "botinfo") {
    const uptime = formatDuration(process.uptime() * 1000);
    const BOT_DEVELOPER_ID = "1407070875039301713";
    const totalAudience = interaction.client.guilds.cache.reduce((a, g) => a + (g.memberCount || 0), 0);
    const embed = new EmbedBuilder()
      .setTitle("[SHIELD] Zenith – Bot & Developer Information")
      .setColor(0xfacc15)
      .setThumbnail(interaction.client.user?.displayAvatarURL({ dynamic: true, size: 256 }) || null)
      .addFields(
        { 
          name: "[OWNER] Lead Developer", 
          value: `**Aimbot** (\`aimbot.xd\`)\n<@${BOT_DEVELOPER_ID}>\n*\`</> Dev : C++ | Python\`*`, 
          inline: false 
        },
        { name: " Gateway Ping", value: `${interaction.client.ws.ping}ms`, inline: true },
        { name: "System Uptime", value: uptime, inline: true },
        { name: "[SHIELD] Protected Servers", value: `${interaction.client.guilds.cache.size}`, inline: true },
        { name: " Live Audience", value: `${totalAudience.toLocaleString()}`, inline: true },
        { name: "Slash Commands", value: "46 Ready", inline: true },
        { name: " Environment", value: `Node.js ${process.version}`, inline: true },
        { name: " Official Links", value: "[Web Dashboard](https://zenith.apps.bot-hosting.cloud/) • [Support Server](https://discord.gg/RmV56QrpPg) • [Invite Zenith](https://tinyurl.com/zenith-bot-app)", inline: false }
      )
      .setFooter({ text: "Zenith Multi-Purpose Bot • Crafted & Engineered by Aimbot" })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  // Moderation: ban, kick, timeout
  if (name === "ban" || name === "kick" || name === "timeout") {
    const target = interaction.options.getMember("user");
    const reason = interaction.options.getString("reason") || "No reason specified";
    if (!target) return interaction.reply({ content: "Member not found in this server.", flags: 64 });

    if (name === "ban") {
      if (!target.bannable) return interaction.reply({ content: "I cannot ban this user (role hierarchy).", flags: 64 });
      await target.ban({ reason });
    }
    if (name === "kick") {
      if (!target.kickable) return interaction.reply({ content: "I cannot kick this user (role hierarchy).", flags: 64 });
      await target.kick(reason);
    }
    if (name === "timeout") {
      if (!target.moderatable) return interaction.reply({ content: "I cannot timeout this user.", flags: 64 });
      const mins = interaction.options.getInteger("minutes");
      await target.timeout(mins * 60_000, reason);
    }
    await sendLog(interaction.guild, { embeds: [logEmbed(name.toUpperCase(), `${target.user.tag} - ${reason}`, 0xed4245)] });
    return interaction.reply(`${name.toUpperCase()} applied to ${target.user.tag}`);
  }

  // /warn
  if (name === "warn") {
    const target = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason") || "No reason specified";
    const key = `${interaction.guildId}:${target.id}`;
    if (!db.warns[key]) db.warns[key] = [];
    db.warns[key].push({ reason, at: Date.now(), mod: interaction.user.id });
    save();
    await sendLog(interaction.guild, { embeds: [logEmbed("Warn", `${target.tag}: ${reason}`, 0xfee75c)] });
    return interaction.reply(`Warned ${target.tag} (Total warnings: ${db.warns[key].length})`);
  }

  // /warnings (Censored & Private)
  if (name === "warnings") {
    const target = interaction.options.getUser("user") || interaction.user;
    const isSelf = target.id === interaction.user.id;
    const isStaff = interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers);

    if (!isSelf && !isStaff) {
      return interaction.reply({
        content: "Access Denied: You can only view your own disciplinary history.",
        flags: 64,
      });
    }

    const list = db.warns[`${interaction.guildId}:${target.id}`] || [];
    return interaction.reply({
      content: list.length ? list.map((w, i) => `**${i + 1}.** ${w.reason} *(<t:${Math.floor(w.at / 1000)}:R>)*`).join("\n") : "No warnings recorded.",
      flags: 64,
    });
  }

  // /purge
  if (name === "purge") {
    const count = interaction.options.getInteger("count");
    try {
      const deleted = await interaction.channel.bulkDelete(count, true);
      return interaction.reply({ content: ` Successfully deleted **${deleted.size}** messages.`, flags: 64 });
    } catch (err) {
      return interaction.reply({ content: `[X] Failed to delete messages: ${err.message}`, flags: 64 });
    }
  }

  // /balance, /daily, /pay, /leaderboard
  if (name === "balance") {
    const u = interaction.options.getUser("user") || interaction.user;
    const row = getUser(u.id);
    return interaction.reply(`${u.username}: **${row.coins}** coins · Level **${levelFromXp(row.xp)}** (${row.xp} XP)`);
  }

  if (name === "daily") {
    const row = getUser(interaction.user.id);
    const now = Date.now();
    if (now - row.lastDaily < 86_400_000) {
      const left = Math.ceil((86_400_000 - (now - row.lastDaily)) / 3600_000);
      return interaction.reply(`Daily already claimed. Try again in ~${left}h.`);
    }
    row.lastDaily = now;
    row.coins += 250;
    save();
    return interaction.reply("Claimed 250 daily coins.");
  }

  if (name === "pay") {
    const target = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");
    if (!target) return interaction.reply({ content: "[X] Target member not found.", flags: 64 });
    if (target.id === interaction.user.id) return interaction.reply({ content: "[X] You cannot pay yourself coins.", flags: 64 });
    if (amount <= 0) return interaction.reply({ content: "[X] Transfer amount must be at least 1 coin.", flags: 64 });
    if (target.bot) return interaction.reply({ content: "[X] Cannot pay bot accounts.", flags: 64 });
    const from = getUser(interaction.user.id);
    if (from.coins < amount) return interaction.reply({ content: "[X] Not enough coins in your balance.", flags: 64 });
    from.coins -= amount;
    getUser(target.id).coins += amount;
    save();
    return interaction.reply(` Successfully transferred **${amount}** coins to ${target.username}.`);
  }

  if (name === "leaderboard") {
    const top = Object.entries(db.users)
      .sort((a, b) => b[1].xp - a[1].xp)
      .slice(0, 10)
      .map(([id, u], i) => `**${i + 1}.** <@${id}> — Lv ${levelFromXp(u.xp)} · ${u.coins} coins`);
    return interaction.reply({ embeds: [logEmbed("Leaderboard", top.join("\n") || "No data yet.")] });
  }

  // /custom
  if (name === "custom") {
    const sub = interaction.options.getSubcommand();
    if (!db.customCommands[interaction.guildId]) db.customCommands[interaction.guildId] = {};
    const map = db.customCommands[interaction.guildId];
    if (sub === "add") {
      const n = interaction.options.getString("name").toLowerCase().replace(/\s+/g, "");
      map[n] = interaction.options.getString("response");
      save();
      return interaction.reply(`Custom command \`${guildCfg.prefix}${n}\` saved.`);
    }
    if (sub === "remove") {
      const n = interaction.options.getString("name").toLowerCase();
      delete map[n];
      save();
      return interaction.reply(`Command \`${n}\` removed.`);
    }
    return interaction.reply(Object.keys(map).map((k) => `\`${guildCfg.prefix}${k}\``).join(", ") || "No custom commands configured.");
  }

  // /stats
  if (name === "stats") {
    const BOT_DEVELOPER_ID = "1407070875039301713";
    return interaction.reply({
      embeds: [
        logEmbed(
          "Live System Statistics",
          [
            `[OWNER] Lead Developer: **Aimbot** (\`aimbot.xd\`) • <@${BOT_DEVELOPER_ID}>`,
            ` Role: \`</> Dev : C++ | Python\``,
            `Servers: **${interaction.client.guilds.cache.size}**`,
            `Members: **${interaction.client.guilds.cache.reduce((a, g) => a + (g.memberCount || 0), 0)}**`,
            `Messages: **${db.stats.messages}**`,
            `Commands: **${db.stats.commands}**`,
            `Tickets Opened: **${db.stats.ticketsOpened || 0}**`,
            `Tickets Closed: **${db.stats.ticketsClosed || 0}**`,
            `Web Visits: **${db.stats.webVisits}**`,
            `Uptime: **${formatDuration(process.uptime() * 1000)}**`,
          ].join("\n")
        ),
      ],
    });
  }

  if (!interaction.replied && !interaction.deferred) {
    return interaction.reply({ content: `Command \`/${name}\` completed.`, flags: 64 }).catch(() => {});
  }
}

/* =========================================================
   BUTTON & INTERACTION HANDLER (TempVoice & Zenith Ticket)
========================================================= */

async function handleButton(interaction) {
  const id = interaction.customId;
  const cfg = getGuild(interaction.guildId);

  // 1. TEMP VOICE BUTTONS
  if (id.startsWith("voice_btn_")) {
    let channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      channel = interaction.member?.voice?.channel;
    }

    if (!channel) {
      return interaction.reply({ content: "[X] You must be connected to your voice channel to use these controls.", flags: 64 });
    }

    const room = getTempVoiceRoom(channel, interaction.guild, cfg);
    if (!room) {
      return interaction.reply({ content: "This is not an active temporary voice channel.", flags: 64 });
    }
    const activeRooms = cfg.tempVoice?.activeRooms || {};

    // Name button -> Modal
    if (id === "voice_btn_name") {
      if (room.ownerId !== interaction.user.id) {
        return interaction.reply({ content: "Only the room owner can rename this voice channel.", flags: 64 });
      }

      const modal = new ModalBuilder().setCustomId("modal_voice_name").setTitle("Rename Voice Channel");
      const nameInput = new TextInputBuilder()
        .setCustomId("input_voice_name")
        .setLabel("Channel Name")
        .setStyle(TextInputStyle.Short)
        .setValue(channel.name)
        .setMaxLength(32)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
      return interaction.showModal(modal);
    }

    // Limit button -> Modal
    if (id === "voice_btn_limit") {
      if (room.ownerId !== interaction.user.id) {
        return interaction.reply({ content: "Only the room owner can set the capacity limit.", flags: 64 });
      }

      const modal = new ModalBuilder().setCustomId("modal_voice_limit").setTitle("Set Room User Limit");
      const limitInput = new TextInputBuilder()
        .setCustomId("input_voice_limit")
        .setLabel("User Limit (0 for Unlimited, 1-99)")
        .setStyle(TextInputStyle.Short)
        .setValue(String(channel.userLimit || 0))
        .setMaxLength(2)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(limitInput));
      return interaction.showModal(modal);
    }

    // Privacy button -> Toggle Lock
    if (id === "voice_btn_privacy") {
      if (room.ownerId !== interaction.user.id) {
        return interaction.reply({ content: "Only the room owner can change room privacy.", flags: 64 });
      }

      room.locked = !room.locked;
      cfg.tempVoice.activeRooms = activeRooms;
      save();

      await channel.permissionOverwrites.edit(interaction.guild.id, {
        Connect: room.locked ? false : null,
      }).catch(() => {});

      return interaction.reply({
        content: `Voice channel is now **${room.locked ? "LOCKED" : "UNLOCKED"}** for everyone.`,
        flags: 64,
      });
    }

    // Claim button
    if (id === "voice_btn_claim") {
      const currentOwnerInVC = channel.members.has(room.ownerId);
      if (currentOwnerInVC && room.ownerId !== interaction.user.id) {
        return interaction.reply({ content: "The current owner is still inside this voice channel.", flags: 64 });
      }

      room.ownerId = interaction.user.id;
      cfg.tempVoice.activeRooms = activeRooms;
      save();

      await channel.permissionOverwrites.edit(interaction.user.id, {
        ManageChannels: true,
        MoveMembers: true,
        MuteMembers: true,
        DeafenMembers: true,
      }).catch(() => {});

      return interaction.reply(`Ownership of this temporary room transferred to ${interaction.user}!`);
    }

    // Transfer button -> Shows ONLY members currently in THIS VC
    if (id === "voice_btn_transfer") {
      if (room.ownerId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "Only the room owner can transfer ownership.", flags: 64 });
      }

      // Filter members currently in this voice channel (excluding bots and self)
      const vcMembers = channel.members.filter((m) => !m.user.bot && m.id !== interaction.user.id);

      if (vcMembers.size === 0) {
        return interaction.reply({
          content: "[X] **Koi aur banda is voice channel me nahi hai!**\nOwnership sirf usi ko di ja sakti hai jo abhi aapke VC me baitha ho. Apne dost ko bolo pehle is VC me join kare!",
          flags: 64,
        });
      }

      const options = vcMembers.map((m) => ({
        label: (m.displayName || m.user.username).slice(0, 25),
        value: m.id,
        description: `@${m.user.tag}`.slice(0, 50),
      }));

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("voice_select_transfer")
        .setPlaceholder("Select a member currently in this VC")
        .addOptions(options.slice(0, 25));

      const menuRow = new ActionRowBuilder().addComponents(selectMenu);

      return interaction.reply({
        content: "[OWNER] **Transfer Ownership:** Niche diye dropdown me se select karein ki is VC ka naya owner kisko banana hai (sirf VC ke active members):",
        components: [menuRow],
        flags: 64,
      });
    }

    // Delete button
    if (id === "voice_btn_delete") {
      const isOwner = !room.ownerId || room.ownerId === interaction.user.id;
      const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator) || interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

      if (!isOwner && !isAdmin) {
        return interaction.reply({ content: "Only the room owner or an Administrator can delete this channel.", flags: 64 });
      }

      if (cfg.tempVoice?.activeRooms) {
        delete cfg.tempVoice.activeRooms[channel.id];
        save();
      }
      await interaction.reply({ content: " Deleting temporary voice channel...", flags: 64 });
      setTimeout(() => channel.delete().catch(() => {}), 1200);
      return;
    }
  }

  // 2. TICKET RATING BUTTON: ticket_rate:<stars>:<channelId>
  if (id.startsWith("ticket_rate:")) {
    const parts = id.split(":");
    const stars = parseInt(parts[1], 10) || 5;
    const ticketId = parts[2];
    saveRating(ticketId, stars);
    return interaction.update({
      content: `Thank you for rating your experience **${stars} Stars**! Your feedback helps our staff team improve.`,
      components: [],
    });
  }

  // 3. TICKET CREATION BUTTON: ticket_open:<category>
  if (id.startsWith("ticket_open:")) {
    const categoryName = id.split(":")[1] || "general";

    const existing = interaction.guild.channels.cache.find(
      (c) => c.name.startsWith("ticket-") && c.name.includes(interaction.user.username.toLowerCase().slice(0, 15))
    );
    if (existing) {
      return interaction.reply({ content: `You already have an open ticket: ${existing}`, flags: 64 });
    }

    cfg.ticketCounter = (cfg.ticketCounter || 0) + 1;
    save();

    const formattedNum = String(cfg.ticketCounter).padStart(4, "0");
    const cleanUser = (interaction.user.username || "user").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 15);
    const naming = cfg.ticketNaming || "num-user";
    const prefix = cfg.ticketPrefix ? cfg.ticketPrefix.toLowerCase().replace(/[^a-z0-9-]/g, "") : "ticket";

    let channelName = `${prefix}-${formattedNum}-${cleanUser}`.slice(0, 95);
    if (naming === "num") {
      channelName = `${prefix}-${formattedNum}`;
    } else if (naming === "user") {
      channelName = `${prefix}-${cleanUser}`;
    } else if (naming === "support-num") {
      channelName = `support-${formattedNum}`;
    } else if (naming === "category-num") {
      channelName = `${categoryName.toLowerCase()}-${formattedNum}`;
    }

    const overwrites = [
      { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
      { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
    ];

    // Support Multiple Staff Roles
    const supportRoles = Array.isArray(cfg.supportRoleIds) && cfg.supportRoleIds.length > 0
      ? cfg.supportRoleIds
      : (cfg.supportRoleId ? [cfg.supportRoleId] : []);

    for (const rid of supportRoles) {
      overwrites.push({
        id: rid,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }

    // Clean Placement: Ensure ticket category exists so channel NEVER floats at the top
    let targetCategory = null;
    if (cfg.ticketCategoryId) {
      targetCategory = interaction.guild.channels.cache.get(cfg.ticketCategoryId);
    }
    if (!targetCategory || targetCategory.type !== ChannelType.GuildCategory) {
      targetCategory = interaction.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && (c.name.toLowerCase().includes("ticket") || c.name.toLowerCase().includes("support"))
      );
    }
    if (!targetCategory && interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      try {
        const catOverwrites = [
          { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
        ];
        for (const rid of supportRoles) {
          catOverwrites.push({
            id: rid,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles],
          });
        }
        targetCategory = await interaction.guild.channels.create({
          name: "TICKETS",
          type: ChannelType.GuildCategory,
          permissionOverwrites: catOverwrites,
        });
        cfg.ticketCategoryId = targetCategory.id;
        save();
      } catch (catErr) {
        console.warn("[Zenith Ticket] Category creation error:", catErr.message);
      }
    }

    const channel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: targetCategory ? targetCategory.id : null,
      permissionOverwrites: overwrites,
    });

    const ticketData = {
      channelId: channel.id,
      ticketNum: formattedNum,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      category: categoryName.toUpperCase(),
      priority: "Standard",
      claimedBy: null,
      openedAt: Date.now(),
      status: "open",
    };
    saveTicket(ticketData);

    const descTemplate = cfg.ticketWelcomeDesc && cfg.ticketWelcomeDesc.trim()
      ? cfg.ticketWelcomeDesc
      : `Welcome ${interaction.user}!\n\n**Category:** ${categoryName.toUpperCase()}\n**Priority:** STANDARD\n**Status:** WAITING FOR STAFF\n\nPlease describe your question or issue in detail below. Support staff will assist you shortly.`;

    const descText = descTemplate
      .replace(/\{user\}/gi, `${interaction.user}`)
      .replace(/\{category\}/gi, categoryName.toUpperCase())
      .replace(/\{num\}/gi, formattedNum);

    const headerEmbed = new EmbedBuilder()
      .setTitle(`Support Ticket #${formattedNum}`)
      .setColor(0x5865f2)
      .setDescription(descText)
      .setFooter({ text: "Zenith Ticket" })
      .setTimestamp();

    const controlsRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket_claim").setLabel("Claim Ticket").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ticket_close_req").setLabel("Request Close").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ticket_close_instant").setLabel("Close Ticket").setStyle(ButtonStyle.Danger)
    );

    const staffPings = supportRoles.map((id) => `<@&${id}>`).join(" ");
    const pingText = staffPings ? `${interaction.user} ${staffPings}` : `${interaction.user}`;
    await channel.send({ content: pingText, embeds: [headerEmbed], components: [controlsRow] });

    const replyTemplate = cfg.ticketCreatedMsg && cfg.ticketCreatedMsg.trim()
      ? cfg.ticketCreatedMsg
      : "Ticket #{num} created: {channel}";
    const replyContent = replyTemplate
      .replace(/\{num\}/gi, formattedNum)
      .replace(/\{channel\}/gi, `${channel}`)
      .replace(/\{user\}/gi, `${interaction.user}`);

    return interaction.reply({ content: replyContent, flags: 64 });
  }

  // Claim ticket
  if (id === "ticket_claim") {
    const ticket = getTicket(interaction.channelId);
    if (!ticket) return interaction.reply({ content: "This is not a support ticket.", flags: 64 });

    const supportRoles = Array.isArray(cfg.supportRoleIds) && cfg.supportRoleIds.length > 0
      ? cfg.supportRoleIds
      : (cfg.supportRoleId ? [cfg.supportRoleId] : []);

    const isSupportStaff =
      interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
      interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) ||
      supportRoles.some((rid) => interaction.member.roles.cache.has(rid)) ||
      interaction.guild.ownerId === interaction.user.id;

    if (!isSupportStaff) {
      return interaction.reply({ content: "[X] Only support staff members can claim this ticket.", flags: 64 });
    }

    if (ticket.claimedBy) {
      return interaction.reply({ content: `Already claimed by <@${ticket.claimedBy}>.`, flags: 64 });
    }

    updateTicket(interaction.channelId, { claimedBy: interaction.user.id });
    await interaction.channel.setTopic(`Ticket #${ticket.ticketNum} | Claimed by: ${interaction.user.tag}`).catch(() => {});

    const claimedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket_claimed_info").setLabel(`Claimed by @${interaction.user.username}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId("ticket_close_req").setLabel("Request Close").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ticket_close_instant").setLabel("Close Ticket").setStyle(ButtonStyle.Danger)
    );

    await interaction.message.edit({ components: [claimedRow] }).catch(() => {});
    return interaction.reply({
      embeds: [logEmbed("Ticket Claimed", `${interaction.user} is now handling this ticket.`, 0x57f287)],
    });
  }

  // Request Close
  if (id === "ticket_close_req") {
    const ticket = getTicket(interaction.channelId);
    if (!ticket) return interaction.reply({ content: "This is not a support ticket.", flags: 64 });

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket_close_accept").setLabel("Accept & Close").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("ticket_close_deny").setLabel("Keep Open").setStyle(ButtonStyle.Secondary)
    );

    return interaction.reply({
      content: `<@${ticket.userId}> Support staff ${interaction.user} has requested to close this ticket. Is your issue resolved?`,
      components: [confirmRow],
    });
  }

  // Close Denied
  if (id === "ticket_close_deny") {
    await interaction.message.delete().catch(() => {});
    return interaction.reply({ content: "Close request was cancelled. Ticket remains open.", flags: 64 });
  }

  // Close Accepted or Instant Close
  if (id === "ticket_close_accept" || id === "ticket_close_instant") {
    const ticket = getTicket(interaction.channelId);
    if (!ticket) return interaction.reply({ content: "This is not a support ticket.", flags: 64 });

    const supportRoles = Array.isArray(cfg.supportRoleIds) && cfg.supportRoleIds.length > 0
      ? cfg.supportRoleIds
      : (cfg.supportRoleId ? [cfg.supportRoleId] : []);

    const isAuthor = ticket.userId === interaction.user.id;
    const isSupportStaff =
      interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
      interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) ||
      supportRoles.some((rid) => interaction.member.roles.cache.has(rid)) ||
      interaction.guild.ownerId === interaction.user.id;

    if (!isAuthor && !isSupportStaff) {
      return interaction.reply({ content: "[X] Only support staff or the ticket creator can close this ticket.", flags: 64 });
    }

    await interaction.reply("Closing ticket and exporting transcript in 3 seconds...");
    await closeTicketChannel(interaction.channel, interaction.user);
  }

  // 4. MUSIC CONTROLLER BUTTONS: music_*
  if (id.startsWith("music_")) {
    const q = queues.get(interaction.guildId);
    if (!q || !q.current) {
      return interaction.reply({
        content: "[X] No music is currently playing. Use `/play <song>` to start playing music in your voice channel!",
        flags: 64
      });
    }

    const memberVoice = interaction.member?.voice?.channel;
    const botVoice = q.connection?.joinConfig?.channelId;
    if (!memberVoice || memberVoice.id !== botVoice) {
      return interaction.reply({ content: "[X] You must be in the same voice channel as the bot to use music controls.", flags: 64 });
    }

    // Down (Volume Down by 10%)
    if (id === "music_down") {
      q.volume = Math.max(10, (q.volume || 100) - 10);
      if (q.currentResource?.volume) {
        q.currentResource.volume.setVolume(q.volume / 100);
      }
      return interaction.reply({ content: `[VC] Volume decreased to **${q.volume}%**`, flags: 64 });
    }

    // Up (Volume Up by 10%)
    if (id === "music_up") {
      q.volume = Math.min(150, (q.volume || 100) + 10);
      if (q.currentResource?.volume) {
        q.currentResource.volume.setVolume(q.volume / 100);
      }
      return interaction.reply({ content: `[VC] Volume increased to **${q.volume}%**`, flags: 64 });
    }

    // Back (Previous song from history)
    if (id === "music_back") {
      if (q.history && q.history.length > 0) {
        const prev = q.history.pop();
        if (q.current) q.tracks.unshift(q.current);
        await interaction.reply({ content: `⏮️ Playing previous track: **${prev.title}**`, flags: 64 });
        return music.startTrack(interaction.guildId, prev, true);
      } else {
        return interaction.reply({ content: "ℹ️ No previous track found in history.", flags: 64 });
      }
    }

    // Pause / Resume toggle
    if (id === "music_pause") {
      if (!q.paused) {
        q.player.pause();
        q.paused = true;
        const panel = buildMusicController(interaction.guild, q.current, q);
        await interaction.message.edit(panel).catch(() => {});
        return interaction.reply({ content: "⏸️ Music paused.", flags: 64 });
      } else {
        q.player.unpause();
        q.paused = false;
        const panel = buildMusicController(interaction.guild, q.current, q);
        await interaction.message.edit(panel).catch(() => {});
        return interaction.reply({ content: "▶️ Music resumed.", flags: 64 });
      }
    }

    // Skip
    if (id === "music_skip") {
      await interaction.reply({ content: "⏭️ Skipped current track.", flags: 64 });
      if (q.tracks.length > 0) {
        const next = q.tracks.shift();
        return music.startTrack(interaction.guildId, next, true);
      } else {
        q.playing = false;
        q.current = null;
        q.player.stop();
        return;
      }
    }

    // Shuffle
    if (id === "music_shuffle") {
      if (q.tracks.length < 2) {
        return interaction.reply({ content: "ℹ️ Need at least 2 tracks in queue to shuffle.", flags: 64 });
      }
      for (let i = q.tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q.tracks[i], q.tracks[j]] = [q.tracks[j], q.tracks[i]];
      }
      return interaction.reply({ content: ` Shuffled **${q.tracks.length}** tracks in queue!`, flags: 64 });
    }

    // Loop mode
    if (id === "music_loop") {
      const modes = ["off", "track", "queue"];
      const nextIdx = (modes.indexOf(q.loop || "off") + 1) % modes.length;
      q.loop = modes[nextIdx];
      const panel = buildMusicController(interaction.guild, q.current, q);
      await interaction.message.edit(panel).catch(() => {});
      return interaction.reply({ content: ` Loop mode set to: **${q.loop.toUpperCase()}**`, flags: 64 });
    }

    // Stop
    if (id === "music_stop") {
      q.tracks = [];
      q.history = [];
      q.playing = false;
      q.current = null;
      q.player.stop();
      if (q.connection) {
        try { q.connection.destroy(); } catch (e) {}
      }
      queues.delete(interaction.guildId);
      const stoppedEmbed = new EmbedBuilder()
        .setAuthor({ name: "MUSIC PANEL", iconURL: interaction.client.user.displayAvatarURL() })
        .setColor(0xed4245)
        .setDescription("⏹️ Playback stopped and disconnected from voice channel.")
        .setFooter({ text: "Zenith Music" });
      await interaction.message.edit({ embeds: [stoppedEmbed], components: [] }).catch(() => {});
      return interaction.reply({ content: "⏹️ Playback stopped and disconnected.", flags: 64 });
    }

    // AutoPlay
    if (id === "music_autoplay") {
      q.autoplay = !q.autoplay;
      const panel = buildMusicController(interaction.guild, q.current, q);
      await interaction.message.edit(panel).catch(() => {});
      return interaction.reply({ content: ` AutoPlay is now **${q.autoplay ? "ENABLED" : "DISABLED"}**`, flags: 64 });
    }

    // Playlist
    if (id === "music_playlist") {
      const queueList = q.tracks.slice(0, 10).map((t, idx) => `\`${idx + 1}.\` **${t.title}** \`[${t.duration || "3:30"}]\` (by ${t.requester})`).join("\n");
      const qEmbed = new EmbedBuilder()
        .setTitle(" Current Playlist & Queue")
        .setColor(0x5865f2)
        .setDescription(
          `**Now Playing:**\n \`${q.current.title}\` \`[${q.current.duration || "3:30"}]\`\n\n` +
          `**Upcoming Tracks (${q.tracks.length}):**\n` +
          (queueList || "_No upcoming tracks in queue._")
        )
        .setFooter({ text: `Total Queue: ${q.tracks.length} track(s) • Loop: ${(q.loop || "off").toUpperCase()} • AutoPlay: ${q.autoplay ? "ON" : "OFF"}` });
      return interaction.reply({ embeds: [qEmbed], flags: 64 });
    }
  }
}

/* =========================================================
   MODAL SUBMIT HANDLER (TempVoice Name & Limit Modals)
========================================================= */

async function handleModal(interaction) {
  const id = interaction.customId;
  // Instantly defer to satisfy Discord's 3-second hard timeout
  await interaction.deferReply({ flags: 64 }).catch(() => {});

  let channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    if (interaction.member?.voice?.channel) {
      channel = interaction.member.voice.channel;
    }
  }

  if (!channel) {
    return interaction.editReply("You must be connected to your voice channel to modify it.");
  }

  if (id === "modal_voice_name") {
    let newName = "";
    try {
      newName = interaction.fields.getTextInputValue("input_voice_name")?.trim() || "";
    } catch {
      newName = interaction.fields.fields.first()?.value?.trim() || "";
    }

    if (!newName) return interaction.editReply("Please provide a valid channel name.");

    try {
      await channel.setName(newName.slice(0, 95));
      return interaction.editReply(`Voice channel successfully renamed to **${newName}**!`);
    } catch (err) {
      console.error("Rename channel error:", err.message);
      if (err.message.includes("rate limit") || err.status === 429) {
        return interaction.editReply("Discord Rate Limit: Discord only allows renaming a voice channel 2 times every 10 minutes. Please wait a few minutes and try again!");
      }
      return interaction.editReply(`Failed to rename channel: ${err.message}`);
    }
  }

  if (id === "modal_voice_limit") {
    let rawLimit = "";
    try {
      rawLimit = interaction.fields.getTextInputValue("input_voice_limit")?.trim() || "";
    } catch {
      rawLimit = interaction.fields.fields.first()?.value?.trim() || "";
    }
    const limit = parseInt(rawLimit, 10);
    const validLimit = isNaN(limit) ? 0 : Math.max(0, Math.min(99, limit));

    try {
      await channel.setUserLimit(validLimit);
      return interaction.editReply(`User capacity set to **${validLimit === 0 ? "Unlimited" : validLimit}**!`);
    } catch (err) {
      return interaction.editReply(`Failed to set capacity: ${err.message}`);
    }
  }
}

async function handleSelectMenu(interaction) {
  const id = interaction.customId;
  const guild = interaction.guild;
  const cfg = getGuild(guild.id);
  const activeRooms = cfg.tempVoice?.activeRooms || {};
  const voiceState = interaction.member?.voice;
  const channel = voiceState?.channel;

  if (id === "voice_select_transfer") {
    if (!channel) {
      return interaction.reply({ content: "You must be connected to your voice channel.", flags: 64 });
    }
    const room = activeRooms[channel.id];
    if (!room) {
      return interaction.reply({ content: "This is not an active temporary voice channel.", flags: 64 });
    }
    if (room.ownerId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "Access Denied: Only the room owner can transfer ownership.", flags: 64 });
    }

    const newOwnerId = interaction.values[0];
    const newOwnerMember = await guild.members.fetch(newOwnerId).catch(() => null);
    if (!newOwnerMember) {
      return interaction.reply({ content: "Selected member not found.", flags: 64 });
    }

    // Verify member is STILL in this voice channel!
    if (newOwnerMember.voice?.channelId !== channel.id) {
      return interaction.reply({ content: `[X] ${newOwnerMember} voice channel chhod kar nikal gaya! Wo abhi VC me connected hona chahiye.`, flags: 64 });
    }

    room.ownerId = newOwnerId;
    cfg.tempVoice.activeRooms = activeRooms;
    save();

    // Grant new owner full room permissions
    await channel.permissionOverwrites.edit(newOwnerId, {
      ViewChannel: true,
      Connect: true,
      Speak: true,
      Stream: true,
      UseVAD: true,
      PrioritySpeaker: true,
      MuteMembers: true,
      DeafenMembers: true,
      MoveMembers: true,
      ManageChannels: true,
      SendMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
      ManageMessages: true,
    }).catch(() => {});

    await interaction.reply({
      content: `[OK] Ownership of this voice channel has been transferred to ${newOwnerMember}!`,
      flags: 64,
    });
    return channel.send(`[OWNER] **New Host:** Ownership of this voice channel has been transferred to ${newOwnerMember}!`).catch(() => {});
  }
}

async function closeTicketChannel(channel, closedByUser) {
  const ticket = getTicket(channel.id) || { ticketNum: "0000", userId: null };
  bump("ticketsClosed");

  const transcriptPath = await generateTranscript(channel, ticket);
  updateTicket(channel.id, { status: "closed", closedAt: Date.now(), closedBy: closedByUser?.id });

  if (ticket.userId) {
    try {
      const member = await channel.guild.members.fetch(ticket.userId).catch(() => null);
      if (member) {
        const ratingRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ticket_rate:1:${channel.id}`).setLabel("1 Star").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`ticket_rate:2:${channel.id}`).setLabel("2 Stars").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`ticket_rate:3:${channel.id}`).setLabel("3 Stars").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`ticket_rate:4:${channel.id}`).setLabel("4 Stars").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`ticket_rate:5:${channel.id}`).setLabel("5 Stars (Best)").setStyle(ButtonStyle.Success)
        );

        const appUrl = process.env.PUBLIC_URL || "https://zenith.apps.bot-hosting.cloud";
        const dmEmbed = new EmbedBuilder()
          .setTitle(`Ticket #${ticket.ticketNum} Closed`)
          .setDescription(
            `Your ticket in **${channel.guild.name}** has been closed.\n\n` +
            `Click the button below to view your full transcript online in your browser.\n\n` +
            `Please rate your experience with our staff below:`
          )
          .setColor(0x5865f2)
          .setFooter({ text: "Zenith Ticket System" })
          .setTimestamp();

        const transcriptRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("View Transcript Online")
            .setStyle(ButtonStyle.Link)
            .setURL(`${appUrl}/transcript/${channel.id}`)
        );

        await member.send({ embeds: [dmEmbed], components: [transcriptRow, ratingRow] }).catch(() => {});
      }
    } catch (e) {
      console.error("Failed to send ticket close DM:", e.message);
    }
  }

  const cfg = getGuild(channel.guild.id);
  const logChannelId = cfg.ticketLogChannelId || cfg.logChannelId;
  if (logChannelId) {
    const logCh = channel.guild.channels.cache.get(logChannelId);
    if (logCh) {
      const appUrl = process.env.PUBLIC_URL || "https://zenith.apps.bot-hosting.cloud";
      const logEmbedMsg = new EmbedBuilder()
        .setTitle(`[Ticket Closed] #${channel.name}`)
        .setColor(0xed4245)
        .addFields(
          { name: "Ticket Number", value: `#${ticket.ticketNum || "Unknown"}`, inline: true },
          { name: "Opened By", value: `<@${ticket.userId || "Unknown"}>`, inline: true },
          { name: "Closed By", value: `${closedByUser || "Staff"}`, inline: true },
          { name: "Handling Staff", value: ticket.claimedBy ? `<@${ticket.claimedBy}>` : "Unclaimed", inline: true },
          { name: "Online Transcript", value: `[Click to View Transcript](${appUrl}/transcript/${channel.id})`, inline: false }
        )
        .setTimestamp();

      const logRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("View Transcript Online")
          .setStyle(ButtonStyle.Link)
          .setURL(`${appUrl}/transcript/${channel.id}`)
      );

      await logCh.send({ embeds: [logEmbedMsg], components: [logRow] }).catch(() => {});
    }
  }

  setTimeout(async () => {
    await channel.delete().catch(() => {});
  }, 3000);
}

/* =========================================================
   MESSAGE HANDLER (AFK, Security Checks, XP & Prefix)
========================================================= */

async function handleMessage(message) {
  if (message.author.bot || !message.guild) return;
  bump("messages");
  const cfg = getGuild(message.guild.id);

  // Security Check: Anti-Invite
  if (cfg.antiNuke && cfg.antiNuke.enabled && cfg.antiNuke.antiInvite) {
    const hasManage = message.member?.permissions.has(PermissionFlagsBits.ManageGuild);
    const isWhitelisted = cfg.antiNuke.whitelist && cfg.antiNuke.whitelist.includes(message.author.id);
    if (!hasManage && !isWhitelisted) {
      const inviteRegex = /(discord\.(gg|io|me|li)|discordapp\.com\/invite|discord\.com\/invite)\/[a-zA-Z0-9]+/i;
      if (inviteRegex.test(message.content)) {
        await message.delete().catch(() => {});
        return message.channel.send(`${message.author}, posting Discord invite links is not permitted here.`).then((m) => setTimeout(() => m.delete().catch(() => {}), 5000));
      }
    }
  }

  // Security Check: Anti-Spam / Mass Mentions
  if (cfg.antiNuke && cfg.antiNuke.enabled && cfg.antiNuke.antiSpam) {
    if (message.mentions.users.size >= 5) {
      await message.delete().catch(() => {});
      if (message.member && message.member.moderatable) {
        await message.member.timeout(10 * 60_000, "Anti-Nuke: Mass mention spam detected").catch(() => {});
      }
      return message.channel.send(`${message.author} has been timed out for mass-mention spam.`);
    }
  }

  // XP progression & Leveling
  if (cfg.xpEnabled !== false) {
    const u = getUser(message.author.id);
    const oldLevel = levelFromXp(u.xp);
    u.xp = (u.xp || 0) + 15;
    const newLevel = levelFromXp(u.xp);
    save();
    if (newLevel > oldLevel) {
      message.channel.send(`GG ${message.author}, you leveled up to **Level ${newLevel}**!`).catch(() => {});
    }
  }

  // AFK detection
  const authorAfk = getAfk(message.author.id);
  if (authorAfk) {
    removeAfk(message.author.id);
    const duration = formatDuration(Date.now() - authorAfk.timestamp);
    message.reply(`Welcome back ${message.author}! Your AFK status has been removed. *(Away for ${duration})*`).catch(() => {});
  }

  if (message.mentions.users.size > 0) {
    message.mentions.users.forEach((mentionedUser) => {
      if (mentionedUser.id === message.author.id) return;
      const userAfk = getAfk(mentionedUser.id);
      if (userAfk) {
        const duration = formatDuration(Date.now() - userAfk.timestamp);
        message.reply(`**${mentionedUser.username}** is currently AFK: *${userAfk.reason}* (${duration} ago)`).catch(() => {});
      }
    });
  }

  // Prefix commands fallback
  const prefix = cfg.prefix || "!";
  if (!message.content.startsWith(prefix)) return;
  const [cmd, ...rest] = message.content.slice(prefix.length).trim().split(/\s+/);
  const cmdLower = cmd?.toLowerCase();

  // Custom Role Commands (!staff, !girl, !vip, !guest, !friend)
  const roleCmds = ["staff", "girl", "vip", "guest", "friend"];
  if (roleCmds.includes(cmdLower)) {
    const customRoles = cfg.customRoles || {};
    const configuredRoleId = customRoles[cmdLower];
    if (!configuredRoleId) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription(`The **${cmdLower.toUpperCase()}** role has not been configured in the Zenith Dashboard yet.`),
        ],
      });
    }

    // Authorization: Admin or Required Role
    const hasAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator);
    const hasReqRole = customRoles.reqRole ? message.member?.roles.cache.has(customRoles.reqRole) : false;
    if (!hasAdmin && customRoles.reqRole && !hasReqRole) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription(`You need the <@&${customRoles.reqRole}> role or Administrator permissions to use this command.`),
        ],
      });
    }

    // Target Member
    const targetMember =
      message.mentions.members.first() ||
      (rest[0] ? await message.guild.members.fetch(rest[0]).catch(() => null) : null);

    if (!targetMember) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setDescription(`**Usage:** \`${prefix}${cmdLower} @user\` (or user ID)`),
        ],
      });
    }

    // Bot Permission Check
    if (!message.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription(`I need the **Manage Roles** permission to assign roles.`),
        ],
      });
    }

    const targetRole = message.guild.roles.cache.get(configuredRoleId);
    if (!targetRole) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription(`The configured role (\`${configuredRoleId}\`) no longer exists in this server.`),
        ],
      });
    }

    // Role Hierarchy Check
    if (targetRole.position >= message.guild.members.me.roles.highest.position) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription(`The <@&${targetRole.id}> role is higher than or equal to my highest role. Please move my role higher in Discord Server Settings > Roles.`),
        ],
      });
    }

    // Toggle Role
    try {
      if (targetMember.roles.cache.has(targetRole.id)) {
        await targetMember.roles.remove(targetRole.id, `Custom role removed by ${message.author.tag} (${message.author.id})`);
        return message.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xfee75c)
              .setDescription(`Removed <@&${targetRole.id}> from ${targetMember}.`),
          ],
        });
      } else {
        await targetMember.roles.add(targetRole.id, `Custom role assigned by ${message.author.tag} (${message.author.id})`);
        return message.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x57f287)
              .setDescription(`Added <@&${targetRole.id}> to ${targetMember}.`),
          ],
        });
      }
    } catch (err) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription(`Failed to update role: ${err.message}`),
        ],
      });
    }
  }

  const map = db.customCommands[message.guild.id] || {};
  if (map[cmdLower]) {
    return message.reply(map[cmdLower]);
  }
  if (cmdLower === "ping") return message.reply(`Pong · ${message.client.ws.ping}ms`);
  if (cmdLower === "prefix") return message.reply(`Prefix is \`${prefix}\``);
  if (cmdLower === "help") return message.reply(`Use slash commands like \`/help\` to access all features!`);
}

async function onGuildCreate(guild) {
  try {
    getGuild(guild.id);
    save();

    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${guild.client.user.id}&permissions=8&scope=bot%20applications.commands`;
      const dmEmbed = new EmbedBuilder()
        .setTitle("Thank you for choosing Zenith!")
        .setColor(0x2b2d31)
        .setThumbnail(guild.client.user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setDescription(
          `**${guild.client.user.tag}** has been successfully added to **${guild.name}**\n\n` +
          `You are a valued member! Thank you for your support. You can explore all systems by typing **/help** in any channel.\n\n` +
          `Move the **Zenith** role towards the top of your server roles list to ensure full anti-nuke protection.\n\n` +
          `**Zenith is Unbeatable**`
        );

      const supportUrl = process.env.SUPPORT_SERVER || "https://discord.gg/RmV56QrpPg";
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Support Server")
          .setStyle(ButtonStyle.Link)
          .setURL(supportUrl),
        new ButtonBuilder()
          .setLabel("Invite Zenith")
          .setStyle(ButtonStyle.Link)
          .setURL(inviteUrl)
      );

      await owner.send({ embeds: [dmEmbed], components: [row] }).catch(() => {});
    }
  } catch (err) {
    console.error("onGuildCreate error:", err.message);
  }
}


async function sendTicketPanel(guild, channel, options = {}) {
  const title = (options.title || "").trim();
  const desc = (options.description || "").trim();
  const color = options.color ? parseInt(options.color.replace("#", ""), 16) : 0x5865f2;
  const image = options.image || null;
  const botAvatar = options.botAvatar || guild.client.user.displayAvatarURL({ dynamic: true, size: 256 });
  const footerText = (options.footer || "").trim();

  const embed = new EmbedBuilder()
    .setColor(isNaN(color) ? 0x5865f2 : color);

  if (title) embed.setTitle(title);
  if (desc) embed.setDescription(desc);
  if (footerText) embed.setFooter({ text: footerText, iconURL: botAvatar });

  if (!title && !desc && !image) {
    embed.setTitle("Ticket Support");
    embed.setDescription("Click below to open a ticket.");
  }

  if (options.authorName) {
    embed.setAuthor({ name: options.authorName, iconURL: options.authorIcon || botAvatar });
  }

  if (options.thumb) {
    let thumbUrl = options.thumb.trim();
    if (thumbUrl === "{server_icon}") thumbUrl = guild.iconURL({ dynamic: true }) || null;
    if (thumbUrl && thumbUrl.startsWith("http")) embed.setThumbnail(thumbUrl);
  }

  if (image) {
    const resolved = await resolveMediaUrl(image);
    if (resolved && !resolved.isVideo) {
      embed.setImage(resolved.url);
    }
  }

  const btnLabel = options.buttonLabel || options.btnLabel || "Open Ticket";
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_open:general").setLabel(btnLabel).setStyle(ButtonStyle.Primary)
  );

  return channel.send({ embeds: [embed], components: [row] });
}

async function sendServerAnnouncement(guild, channel, options = {}) {
  const title = options.title || "Server Announcement";
  const desc = options.message || options.description || "Important community announcement.";
  const color = options.color ? parseInt(options.color.replace("#", ""), 16) : 0x6366f1;
  const image = options.image || null;
  const ping = options.ping || "none";
  const botAvatar = options.botAvatar || guild.iconURL() || guild.client.user.displayAvatarURL({ dynamic: true, size: 256 });
  const footerText = options.footer || (options.botName ? `${options.botName} • Announcement` : guild.name);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(isNaN(color) ? 0x6366f1 : color)
    .setTimestamp()
    .setFooter({ text: footerText, iconURL: botAvatar });

  if (options.authorName) {
    embed.setAuthor({ name: options.authorName, iconURL: options.authorIcon || botAvatar });
  }

  if (image) {
    const resolved = await resolveMediaUrl(image);
    if (resolved && !resolved.isVideo) {
      embed.setImage(resolved.url);
    }
  }

  let content = undefined;
  if (ping === "everyone") content = "@everyone";
  else if (ping === "here") content = "@here";

  return channel.send({ content, embeds: [embed] });
}

async function sendServerRules(guild, channel, options = {}) {
  const title = options.title || `Rules of ${guild.name}`;
  const rulesText = options.rules || options.text || 
`**1. Respect Everyone:** Treat all members with civility. Harassment, hate speech, or toxicity will not be tolerated.

**2. No Spam or Self-Promotion:** Keep advertisements, unsolicited DMs, and link dumping out of public channels.

**3. Relevant Channels:** Post content in appropriate channels and observe topic guidelines.

**4. Discord Terms of Service:** Always adhere to the official Discord Community Guidelines and Terms of Service.

**5. Staff Guidance:** Follow instructions given by server moderators and administrators.`;

  const color = options.color ? parseInt(options.color.replace("#", ""), 16) : 0xfacc15;
  const image = options.image || null;
  const botAvatar = options.botAvatar || guild.iconURL() || guild.client.user.displayAvatarURL({ dynamic: true, size: 256 });
  const footerText = options.footer || (options.botName ? `${options.botName} • Official Server Rules` : `${guild.name} • Official Server Rules`);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(rulesText)
    .setColor(isNaN(color) ? 0xfacc15 : color)
    .setFooter({ text: footerText, iconURL: botAvatar });

  if (options.authorName) {
    embed.setAuthor({ name: options.authorName, iconURL: options.authorIcon || botAvatar });
  }

  if (image) {
    const resolved = await resolveMediaUrl(image);
    if (resolved && !resolved.isVideo) {
      embed.setImage(resolved.url);
    }
  }

  return channel.send({ embeds: [embed] });
}

module.exports = {
  commands,
  handleSlash,
  handleButton,
  handleModal,
  handleSelectMenu,
  handleMessage,
  onGuildCreate,
  onMemberAdd,
  onMemberRemove,
  onChannelDelete,
  onChannelCreate,
  onRoleDelete,
  onRoleCreate,
  onBanAdd,
  onWebhookUpdate,
  onGuildUpdate,
  onVoiceStateUpdate,
  setupTempVoice,
  disableTempVoice,
  setupMemberCounters,
  disableMemberCounters,
  updateMemberCounters,
  closeTicketChannel,
  generateTranscript,
  queues,
  sendZenithWelcome,
  resolveMediaUrl,
  sendTicketPanel,
  sendServerAnnouncement,
  sendServerRules,
  initInviteTracker,
  onInviteCreate,
  onInviteDelete,
  commands,
  resolvePlayableTrack,
  cleanAllOrphanTempRooms,
  executeLockdown,
};
