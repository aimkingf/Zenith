require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function setupFFmpeg() {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    process.env.FFMPEG_PATH = "ffmpeg";
    console.log("[Zenith Audio] Using system FFmpeg from PATH");
    return;
  } catch (_) {}

  try {
    const ffmpegStatic = require("ffmpeg-static");
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      process.env.FFMPEG_PATH = ffmpegStatic;
      if (process.platform !== "win32") {
        try { fs.chmodSync(ffmpegStatic, 0o755); } catch (_) {}
      }
      console.log("[Zenith Audio] Using static FFmpeg binary at:", ffmpegStatic);
      return;
    }

    const installScript = path.join(__dirname, "../node_modules/ffmpeg-static/install.js");
    if (fs.existsSync(installScript)) {
      console.log("[Zenith Audio] FFmpeg binary missing. Running ffmpeg-static/install.js...");
      execSync(`node "${installScript}"`, { stdio: "inherit" });
      if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
        process.env.FFMPEG_PATH = ffmpegStatic;
        if (process.platform !== "win32") {
          try { fs.chmodSync(ffmpegStatic, 0o755); } catch (_) {}
        }
        console.log("[Zenith Audio] Static FFmpeg binary installed at:", ffmpegStatic);
      }
    }
  } catch (err) {
    console.warn("[Zenith Audio] FFmpeg setup warning:", err.message);
  }
}
setupFFmpeg();

const { Client, GatewayIntentBits, Collection, REST, Routes, Partials, Options } = require("discord.js");
const bot = require("./bot");
const { startWeb } = require("./web");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
  sweepers: {
    messages: {
      interval: 300,
      lifetime: 300,
    },
  },
  makeCache: Options.cacheWithLimits({
    MessageManager: 100,
    PresenceManager: 50,
    ReactionManager: 0,
    ThreadMemberManager: 0,
  }),
  rest: {
    timeout: 15000,
  },
  ws: {
    large_threshold: 50,
  },
});

client.commands = new Collection();

async function registerCommands() {
  if (!token || !clientId || token.includes("your_bot")) {
    console.log("Skip slash register: set DISCORD_TOKEN and CLIENT_ID in .env");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(token);
  const body = bot.commands();

  try {
    // 1. Global registration (single instance for all servers)
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log("Registered global slash commands (Public Bot mode)");

    // 2. Clear any leftover guild-specific commands to prevent duplicates
    for (const guild of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: [] }).catch(() => {});
    }
  } catch (err) {
    console.error("Slash command registration failed:", err.message);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity({ name: "/help | Security & Music", type: 3 });
  await registerCommands();
  await bot.initInviteTracker(client).catch((e) => console.error("initInviteTracker error:", e.message));
  if (bot.cleanAllOrphanTempRooms) {
    await bot.cleanAllOrphanTempRooms(client).catch((e) => console.error("cleanAllOrphanTempRooms error:", e.message));
    setInterval(() => bot.cleanAllOrphanTempRooms(client).catch(() => {}), 60000);
  }
  startWeb(client);
});

client.on("guildCreate", async (guild) => {
  try {
    await bot.onGuildCreate(guild);
  } catch (e) {
    console.error("guildCreate error:", e.message);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await bot.handleSlash(interaction);
    if (interaction.isButton()) await bot.handleButton(interaction);
    if (interaction.isModalSubmit()) await bot.handleModal(interaction);
    if (interaction.isAnySelectMenu()) await bot.handleSelectMenu(interaction);
  } catch (err) {
    console.error("Interaction error:", err);
    const msg = { content: "Command failed. Check bot permissions and logs.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

// Voice state events (TempVoice / Join to Create)
client.on("voiceStateUpdate", (oldState, newState) => {
  bot.onVoiceStateUpdate(oldState, newState).catch((err) => console.error("voiceStateUpdate error:", err));
});

// Message listener (AFK, XP & Prefix)
client.on("messageCreate", (message) => bot.handleMessage(message));

// Member & Counter events
client.on("guildMemberAdd", (member) => bot.onMemberAdd(member));
client.on("guildMemberRemove", (member) => bot.onMemberRemove(member));

// Invite events
client.on("inviteCreate", (invite) => bot.onInviteCreate(invite));
client.on("inviteDelete", (invite) => bot.onInviteDelete(invite));

// Anti-Nuke Audit Log triggers
client.on("channelDelete", (channel) => bot.onChannelDelete(channel));
client.on("channelCreate", (channel) => bot.onChannelCreate(channel));
client.on("roleDelete", (role) => bot.onRoleDelete(role));
client.on("roleCreate", (role) => bot.onRoleCreate(role));
client.on("guildBanAdd", (ban) => bot.onBanAdd(ban));
client.on("webhookUpdate", (channel) => bot.onWebhookUpdate(channel));
client.on("guildUpdate", (oldG, newG) => bot.onGuildUpdate(oldG, newG));

(async () => {
  if (!token || token.includes("your_bot")) {
    console.log("No Discord token yet. Web dashboard is still running. Copy .env.example to .env and restart.");
    return;
  }
  await client.login(token);
})();


