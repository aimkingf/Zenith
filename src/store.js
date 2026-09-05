const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");
const FILE = path.join(DATA_DIR, "store.json");

const defaults = {
  guilds: {},
  users: {},
  customCommands: {},
  tickets: {},
  stats: { messages: 0, webVisits: 0, commands: 0, ticketsOpened: 0, ticketsClosed: 0, ratings: [] },
  warns: {},
  afk: {},
  premiumUsers: ["1407070875039301713"],
  payments: [],
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(defaults, null, 2));
    return structuredClone(defaults);
  }
  try {
    const loaded = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { ...structuredClone(defaults), ...loaded };
  } catch {
    return structuredClone(defaults);
  }
}

let db = load();
if (!db.afk) db.afk = {};
if (!db.tickets) db.tickets = {};
if (!db.stats.ticketsOpened) db.stats.ticketsOpened = 0;
if (!db.stats.ticketsClosed) db.stats.ticketsClosed = 0;
if (!db.stats.ratings) db.stats.ratings = [];
if (!db.premiumUsers) db.premiumUsers = ["1407070875039301713"];
for (const g of Object.values(db.guilds || {})) {
  if (g.welcomeImage && typeof g.welcomeImage === "string" && (g.welcomeImage.includes("pastel-divider") || g.welcomeImage.includes("1354094094443352134") || g.welcomeImage.includes("rainbow-line.png"))) {
    g.welcomeImage = null;
  }
}

function save() {
  try {
    ensureDir();
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (err) {
    console.error("Store save error:", err.message);
  }
}

function saveSync() {
  save();
}

function guild(id) {
  if (!db.guilds[id]) {
    db.guilds[id] = {};
  }
  const g = db.guilds[id];
  g.prefix = g.prefix || "!";
  g.welcomeChannelId = g.welcomeChannelId || null;
  g.welcomeMessage = g.welcomeMessage ?? null;
  g.welcomeTitle = g.welcomeTitle ?? null;
  g.welcomeTagline = g.welcomeTagline ?? "";
  g.welcomeSubtext = g.welcomeSubtext ?? "";
  g.welcomeDescription = g.welcomeDescription ?? null;
  g.welcomeAuthorName = g.welcomeAuthorName ?? null;
  g.welcomeAuthorIcon = g.welcomeAuthorIcon ?? null;
  g.welcomeBotName = g.welcomeBotName ?? null;
  g.welcomeBotAvatar = g.welcomeBotAvatar ?? null;
  g.welcomeThumb = g.welcomeThumb ?? null;
  if (g.welcomeImage && typeof g.welcomeImage === "string" && (g.welcomeImage.includes("pastel-divider") || g.welcomeImage.includes("1354094094443352134") || g.welcomeImage.includes("rainbow-line.png"))) {
    g.welcomeImage = null;
  }
  g.welcomeImage = g.welcomeImage || null;
  g.welcomeColor = g.welcomeColor || "#6366f1";
  g.welcomeFooter = g.welcomeFooter || null;
  g.welcomeEmbed = g.welcomeEmbed ?? true;
  g.autoRoleId = g.autoRoleId || null;
  g.autoRoleIds = g.autoRoleIds || (g.autoRoleId ? [g.autoRoleId] : []);
  g.leaveChannelId = g.leaveChannelId || null;
  g.leaveMessage = g.leaveMessage || "{user} left **{server}**.";
  g.leaveEmbed = g.leaveEmbed ?? true;
  g.logChannelId = g.logChannelId || null;
  g.supportRoleId = g.supportRoleId || null;
  g.supportRoleIds = g.supportRoleIds || (g.supportRoleId ? [g.supportRoleId] : []);
  g.ticketCategoryId = g.ticketCategoryId || null;
  g.ticketNaming = g.ticketNaming || "num-user";
  g.ticketPrefix = g.ticketPrefix || "ticket";
  g.ticketCreatedMsg = g.ticketCreatedMsg || null;
  g.ticketWelcomeDesc = g.ticketWelcomeDesc || null;
  g.ticketLogChannelId = g.ticketLogChannelId || null;
  g.ticketCounter = g.ticketCounter || 0;
  g.musicChannelId = g.musicChannelId || null;
  g.xpEnabled = g.xpEnabled ?? true;
  g.isPremium = g.isPremium ?? false;

  if (!g.customRoles) {
    g.customRoles = {
      staff: null,
      girl: null,
      vip: null,
      guest: null,
      friend: null,
      reqRole: null,
    };
  }

  if (!g.botBranding) {
    g.botBranding = {
      botName: null,
      botAvatar: null,
      activityType: "Playing",
      activityText: "Zenith | /help",
      themeColor: "#6366f1",
      defaultFooter: "Zenith • Unbreakable Defense",
    };
  }

  if (!g.ticketPanel) {
    g.ticketPanel = {
      channelId: null,
      title: null,
      description: null,
      image: null,
      color: "#5865f2",
      botName: null,
      botAvatar: null,
      authorName: null,
      authorIcon: null,
      footer: null,
    };
  } else {
    g.ticketPanel.botName = g.ticketPanel.botName || null;
    g.ticketPanel.botAvatar = g.ticketPanel.botAvatar || null;
    g.ticketPanel.authorName = g.ticketPanel.authorName || null;
    g.ticketPanel.authorIcon = g.ticketPanel.authorIcon || null;
    g.ticketPanel.footer = g.ticketPanel.footer || null;
  }

  if (!g.announcement) {
    g.announcement = {
      channelId: null,
      title: "Important Community Announcement",
      message: "",
      image: null,
      color: "#6366f1",
      ping: "none",
      botName: null,
      botAvatar: null,
      authorName: null,
      authorIcon: null,
      footer: null,
    };
  } else {
    g.announcement.botName = g.announcement.botName || null;
    g.announcement.botAvatar = g.announcement.botAvatar || null;
    g.announcement.authorName = g.announcement.authorName || null;
    g.announcement.authorIcon = g.announcement.authorIcon || null;
    g.announcement.footer = g.announcement.footer || null;
  }

  if (!g.serverRules) {
    g.serverRules = {
      channelId: null,
      title: "Official Server Rules",
      text: "",
      image: null,
      color: "#facc15",
      botName: null,
      botAvatar: null,
      authorName: null,
      authorIcon: null,
      footer: null,
    };
  } else {
    g.serverRules.botName = g.serverRules.botName || null;
    g.serverRules.botAvatar = g.serverRules.botAvatar || null;
    g.serverRules.authorName = g.serverRules.authorName || null;
    g.serverRules.authorIcon = g.serverRules.authorIcon || null;
    g.serverRules.footer = g.serverRules.footer || null;
  }

  if (!g.tempVoice) {
    g.tempVoice = {
      enabled: false,
      channelId: null,
      categoryId: null,
      categoryName: "ZENITH VOICE",
      channelName: "+ Join to Create",
      roomPattern: "[VC] {user}'s Room",
      activeRooms: {},
    };
  } else {
    if (!g.tempVoice.activeRooms) g.tempVoice.activeRooms = {};
    g.tempVoice.categoryName = g.tempVoice.categoryName || "ZENITH VOICE";
    g.tempVoice.channelName = g.tempVoice.channelName || "+ Join to Create";
    g.tempVoice.roomPattern = g.tempVoice.roomPattern || "[VC] {user}'s Room";
  }

  if (!g.inviteTracking) {
    g.inviteTracking = {
      enabled: true,
      users: {},
      joinedMembers: {},
    };
  } else {
    if (!g.inviteTracking.users) g.inviteTracking.users = {};
    if (!g.inviteTracking.joinedMembers) g.inviteTracking.joinedMembers = {};
  }

  if (!g.antiNuke) {
    g.antiNuke = {
      enabled: false,
      whitelist: [],
      action: "strip_roles",
      antiAlt: false,
      minAccountAgeDays: 3,
      antiInvite: false,
      antiSpam: false,
      limits: {
        channelDelete: 2,
        channelCreate: 3,
        roleDelete: 2,
        roleCreate: 3,
        ban: 2,
        kick: 2,
        botAdd: 1,
        webhook: 2,
        guild: 1,
      },
    };
  } else {
    g.antiNuke.antiAlt = g.antiNuke.antiAlt ?? false;
    g.antiNuke.minAccountAgeDays = g.antiNuke.minAccountAgeDays || 3;
    g.antiNuke.antiInvite = g.antiNuke.antiInvite ?? false;
    g.antiNuke.antiSpam = g.antiNuke.antiSpam ?? false;
    if (!g.antiNuke.limits) g.antiNuke.limits = {};
    g.antiNuke.limits.webhook = g.antiNuke.limits.webhook || 2;
    g.antiNuke.limits.guild = g.antiNuke.limits.guild || 1;
    if (!g.antiNuke.events) g.antiNuke.events = {};
  }

  if (!g.counters) {
    g.counters = {
      enabled: false,
      categoryId: null,
      totalId: null,
      humansId: null,
      botsId: null,
      lastUpdated: 0,
    };
  }
  save();
  return g;
}

function user(id) {
  if (!db.users[id]) {
    db.users[id] = { coins: 0, xp: 0, lastDaily: 0, inventory: [] };
    save();
  }
  return db.users[id];
}

function bump(stat, n = 1) {
  db.stats[stat] = (db.stats[stat] || 0) + n;
  save();
}

function setAfk(userId, reason, guildId) {
  if (!db.afk) db.afk = {};
  db.afk[userId] = { reason: reason || "AFK", timestamp: Date.now(), guildId };
  save();
}

function getAfk(userId) {
  if (!db.afk) db.afk = {};
  return db.afk[userId] || null;
}

function removeAfk(userId) {
  if (!db.afk || !db.afk[userId]) return null;
  const data = db.afk[userId];
  delete db.afk[userId];
  save();
  return data;
}

/* =========================================================
   TICKET HELPER FUNCTIONS
========================================================= */

function saveTicket(ticket) {
  if (!db.tickets) db.tickets = {};
  db.tickets[ticket.channelId] = ticket;
  bump("ticketsOpened");
  save();
  return ticket;
}

function getTicket(channelId) {
  return db.tickets?.[channelId] || null;
}

function updateTicket(channelId, patch) {
  if (!db.tickets || !db.tickets[channelId]) return null;
  db.tickets[channelId] = { ...db.tickets[channelId], ...patch };
  save();
  return db.tickets[channelId];
}

function getGuildTickets(guildId) {
  if (!db.tickets) return [];
  return Object.values(db.tickets).filter((t) => t.guildId === guildId);
}

function saveRating(ticketId, stars, feedback = "") {
  if (!db.stats.ratings) db.stats.ratings = [];
  db.stats.ratings.push({ ticketId, stars, feedback, timestamp: Date.now() });
  save();
}

/* =========================================================
   INVITE TRACKING HELPERS
========================================================= */

function recordInviteJoin(guildId, inviterId, memberId, isFake = false, code = null) {
  const g = guild(guildId);
  if (!g.inviteTracking) g.inviteTracking = { enabled: true, users: {}, joinedMembers: {} };
  if (!g.inviteTracking.users) g.inviteTracking.users = {};
  if (!g.inviteTracking.joinedMembers) g.inviteTracking.joinedMembers = {};

  if (!g.inviteTracking.users[inviterId]) {
    g.inviteTracking.users[inviterId] = { regular: 0, left: 0, fake: 0, bonus: 0 };
  }

  const u = g.inviteTracking.users[inviterId];
  if (isFake) {
    u.fake = (u.fake || 0) + 1;
  } else {
    u.regular = (u.regular || 0) + 1;
  }

  g.inviteTracking.joinedMembers[memberId] = { inviterId, code, isFake, timestamp: Date.now() };
  save();
}

function recordInviteLeave(guildId, memberId) {
  const g = guild(guildId);
  if (!g.inviteTracking || !g.inviteTracking.joinedMembers) return;
  const joinData = g.inviteTracking.joinedMembers[memberId];
  if (joinData && joinData.inviterId) {
    const inviterId = joinData.inviterId;
    if (g.inviteTracking.users && g.inviteTracking.users[inviterId]) {
      g.inviteTracking.users[inviterId].left = (g.inviteTracking.users[inviterId].left || 0) + 1;
      save();
    }
  }
}

function getUserInvites(guildId, userId) {
  const g = guild(guildId);
  const u = (g.inviteTracking?.users && g.inviteTracking.users[userId]) || { regular: 0, left: 0, fake: 0, bonus: 0 };
  const leaves = u.left || 0;
  const fake = u.fake || 0;
  const bonus = u.bonus || 0;
  const regular = u.regular || 0;
  const real = Math.max(0, regular - leaves);
  const total = regular + fake;
  const effective = real + bonus;
  return {
    regular,
    real,
    left: leaves,
    fake,
    bonus,
    total,
    effective,
  };
}

function getGuildInviteLeaderboard(guildId, limit = 25) {
  const g = guild(guildId);
  const users = g.inviteTracking?.users || {};
  const list = [];
  for (const [userId, data] of Object.entries(users)) {
    const leaves = data.left || 0;
    const fake = data.fake || 0;
    const bonus = data.bonus || 0;
    const regular = data.regular || 0;
    const real = Math.max(0, regular - leaves);
    const total = regular + fake;
    const effective = real + bonus;
    list.push({
      userId,
      regular,
      real,
      left: leaves,
      fake,
      bonus,
      total,
      effective,
    });
  }
  list.sort((a, b) => b.effective - a.effective || b.total - a.total);
  return list.slice(0, limit);
}

function addBonusInvites(guildId, userId, amount) {
  const g = guild(guildId);
  if (!g.inviteTracking) g.inviteTracking = { enabled: true, users: {}, joinedMembers: {} };
  if (!g.inviteTracking.users) g.inviteTracking.users = {};
  if (!g.inviteTracking.users[userId]) {
    g.inviteTracking.users[userId] = { regular: 0, left: 0, fake: 0, bonus: 0 };
  }
  g.inviteTracking.users[userId].bonus = (g.inviteTracking.users[userId].bonus || 0) + amount;
  save();
  return getUserInvites(guildId, userId);
}

function resetUserInvites(guildId, userId) {
  const g = guild(guildId);
  if (!g.inviteTracking || !g.inviteTracking.users) return;
  if (userId === "all") {
    g.inviteTracking.users = {};
    g.inviteTracking.joinedMembers = {};
  } else if (g.inviteTracking.users[userId]) {
    delete g.inviteTracking.users[userId];
  }
  save();
}

function resetGuildConfig(id, section = "all") {
  if (!db.guilds[id]) db.guilds[id] = {};
  const g = db.guilds[id];

  if (section === "welcome" || section === "all") {
    g.welcomeChannelId = null;
    g.welcomeMessage = null;
    g.welcomeTitle = null;
    g.welcomeTagline = "";
    g.welcomeSubtext = "";
    g.welcomeDescription = null;
    g.welcomeAuthorName = null;
    g.welcomeAuthorIcon = null;
    g.welcomeBotName = null;
    g.welcomeBotAvatar = null;
    g.welcomeThumb = null;
    g.welcomeImage = null;
    g.welcomeColor = "#3b82f6";
    g.welcomeFooter = null;
    g.welcomeEmbed = true;
    g.welcomeHeaderTitle = null;
    g.welcomeOuterPing = null;
    g.autoRoleId = null;
    g.autoRoleIds = [];
    g.leaveChannelId = null;
    g.leaveMessage = "{user} left **{server}**.";
    g.leaveEmbed = true;
  }

  if (section === "ticket" || section === "all") {
    g.ticketPanel = {
      channelId: null,
      title: null,
      description: null,
      image: null,
      color: "#5865f2",
      botName: null,
      botAvatar: null,
      authorName: null,
      authorIcon: null,
      footer: null,
    };
    g.supportRoleId = null;
    g.supportRoleIds = [];
    g.ticketCategoryId = null;
    g.ticketLogChannelId = null;
    g.ticketNaming = "num-user";
    g.ticketPrefix = "ticket";
    g.ticketCreatedMsg = null;
    g.ticketWelcomeDesc = null;
  }

  if (section === "announcement" || section === "all") {
    g.announcement = {
      channelId: null,
      title: "Important Community Announcement",
      message: "",
      image: null,
      color: "#6366f1",
      ping: "none",
      botName: null,
      botAvatar: null,
      authorName: null,
      authorIcon: null,
      footer: null,
    };
  }

  if (section === "rules" || section === "all") {
    g.serverRules = {
      channelId: null,
      title: "Official Server Rules",
      text: "",
      image: null,
      color: "#facc15",
      botName: null,
      botAvatar: null,
      authorName: null,
      authorIcon: null,
      footer: null,
    };
  }

  if (section === "voice" || section === "all") {
    g.tempVoice = {
      enabled: false,
      channelId: null,
      categoryId: null,
      categoryName: "ZENITH VOICE",
      channelName: "+ Join to Create",
      roomPattern: "[VC] {user}'s Room",
      activeRooms: {},
    };
  }

  if (section === "antinuke" || section === "all") {
    g.antiNuke = {
      enabled: false,
      whitelist: [],
      action: "strip_roles",
      antiAlt: false,
      minAccountAgeDays: 3,
      antiInvite: false,
      antiSpam: false,
      limits: {
        channelDelete: 2,
        channelCreate: 3,
        roleDelete: 2,
        roleCreate: 3,
        ban: 2,
        kick: 2,
        botAdd: 1,
        webhook: 2,
        guild: 1,
      },
    };
  }

  if (section === "invites" || section === "all") {
    g.inviteTracking = {
      enabled: true,
      users: {},
      joinedMembers: {},
    };
  }

  if (section === "customroles" || section === "all") {
    g.customRoles = {
      staff: null,
      girl: null,
      vip: null,
      guest: null,
      friend: null,
      reqRole: null,
    };
  }

  if (section === "botsettings" || section === "all") {
    g.botBranding = {
      name: null,
      avatar: null,
      activityType: "Playing",
      activityText: "Zenith Studio | /help",
      themeColor: "#6366f1",
      defaultFooter: "Powered by Zenith Multi-Purpose",
    };
  }

  save();
  return g;
}

function isGuildPremium(guildId, userId) {
  const OWNER_ID = process.env.OWNER_ID || "1407070875039301713";
  const uid = userId ? String(userId).trim() : "";
  if (uid && (uid === OWNER_ID || uid === "1407070875039301713")) return true;
  if (uid && Array.isArray(db.premiumUsers) && db.premiumUsers.includes(uid)) return true;
  if (guildId && db.guilds[guildId] && db.guilds[guildId].isPremium) return true;
  return false;
}

function setGuildPremium(guildId, isPrem = true) {
  if (!db.guilds[guildId]) guild(guildId);
  db.guilds[guildId].isPremium = !!isPrem;
  save();
  return db.guilds[guildId].isPremium;
}

function setUserPremium(userId, isPrem = true) {
  const uid = String(userId).trim();
  if (!Array.isArray(db.premiumUsers)) db.premiumUsers = [];
  if (isPrem) {
    if (!db.premiumUsers.includes(uid)) db.premiumUsers.push(uid);
  } else {
    db.premiumUsers = db.premiumUsers.filter((id) => id !== uid);
  }
  save();
  return db.premiumUsers;
}

module.exports = {
  db,
  save,
  saveSync,
  guild,
  getGuild: guild,
  user,
  getUser: user,
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
  resetGuildConfig,
  isGuildPremium,
  setGuildPremium,
  setUserPremium,
  DATA_DIR,
  TRANSCRIPTS_DIR,
};
