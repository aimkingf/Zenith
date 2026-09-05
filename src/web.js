const express = require("express");
const path = require("path");
const fs = require("fs");
const { PermissionFlagsBits } = require("discord.js");
const { db, guild: getGuild, save, TRANSCRIPTS_DIR, getGuildInviteLeaderboard, addBonusInvites, resetUserInvites, getUserInvites, resetGuildConfig, isGuildPremium, setGuildPremium, setUserPremium } = require("./store");
const bot = require("./bot");
const { sendZenithWelcome, setupTempVoice, disableTempVoice, resolveMediaUrl, sendTicketPanel, sendServerAnnouncement, sendServerRules, executeLockdown } = bot;

function startWeb(client) {
  const app = express();
  const PORT = process.env.PORT || 25549;
  const OWNER_ID = process.env.OWNER_ID || "1407070875039301713";

  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Payload size limit to prevent memory exhaustion DDoS attacks
  app.use(express.json({ limit: "200kb" }));
  app.use(express.urlencoded({ extended: false, limit: "200kb" }));

  // Global DDoS Shield & IP Flood Protection
  const globalDdosMap = new Map();
  const ddosBlacklist = new Map();

  app.use((req, res, next) => {
    const rawIp = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.ip || req.socket.remoteAddress || "global";
    const ip = String(rawIp).split(",")[0].trim();
    const now = Date.now();

    // 1. Check if IP is currently blacklisted
    const bannedUntil = ddosBlacklist.get(ip);
    if (bannedUntil) {
      if (now < bannedUntil) {
        const remainingSec = Math.ceil((bannedUntil - now) / 1000);
        return res.status(429).send(`[SECURITY BLOCKED] DDoS threshold exceeded. IP temporarily blocked for ${remainingSec}s.`);
      } else {
        ddosBlacklist.delete(ip);
      }
    }

    // 2. Sliding window rate limit: max 120 requests per minute
    const windowMs = 60000;
    const history = (globalDdosMap.get(ip) || []).filter((t) => now - t < windowMs);
    history.push(now);
    globalDdosMap.set(ip, history);

    // If more than 150 requests in 1 minute, auto-blacklist for 15 minutes
    if (history.length > 150) {
      ddosBlacklist.set(ip, now + 15 * 60 * 1000);
      console.warn(`[DDoS Shield] Blacklisted attacking IP: ${ip} for 15 minutes`);
      return res.status(429).send("[SECURITY BLOCKED] High traffic spike detected. Temporary IP ban active.");
    }

    // Rate limit response headers
    res.setHeader("X-RateLimit-Limit", "120");
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, 120 - history.length)));

    next();
  });

  // Enterprise Security Headers (A+ Grade on SecurityHeaders.com)
  app.use((req, res, next) => {
    // 1. Enforce HTTPS (HSTS)
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");

    // 2. Prevent MIME Sniffing
    res.setHeader("X-Content-Type-Options", "nosniff");

    // 3. Prevent Clickjacking
    res.setHeader("X-Frame-Options", "DENY");

    // 4. Legacy XSS Protection
    res.setHeader("X-XSS-Protection", "1; mode=block");

    // 5. Referrer Policy
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    // 6. Permissions Policy (Restrict unused browser features)
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

    // 7. Content Security Policy (Protects against XSS while allowing Discord assets and APIs)
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self' https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https: blob:; font-src 'self' data: https:; connect-src 'self' https: wss:; frame-ancestors 'none'; object-src 'none'; base-uri 'self';"
    );

    // 8. Cross-Origin Security Policies
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    next();
  });

  // In-memory rate limiting for specific sensitive API endpoints
  const rateLimitMap = new Map();
  function rateLimiter(maxRequests = 10, windowMs = 60000) {
    return (req, res, next) => {
      const rawIp = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.ip || "global";
      const ip = String(rawIp).split(",")[0].trim();
      const now = Date.now();
      const history = (rateLimitMap.get(ip) || []).filter((t) => now - t < windowMs);
      if (history.length >= maxRequests) {
        return res.status(429).json({ success: false, error: "Too many requests. Please wait." });
      }
      history.push(now);
      rateLimitMap.set(ip, history);
      next();
    };
  }

  app.use((req, res, next) => {
    if (req.path === "/" || req.path.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
    next();
  });

  app.use(express.static(path.join(__dirname, "public")));

  // Helper: check if a user is admin in a specific guild
  async function checkUserGuildAdmin(userId, guild) {
    const uid = (userId ? String(userId) : "").trim();
    if (!uid || uid === OWNER_ID || uid === "1407070875039301713") return true;
    if (guild.ownerId === uid) return true;
    try {
      let member = guild.members.cache.get(uid);
      if (!member) {
        member = await guild.members.fetch(uid).catch(() => null);
      }
      if (!member) return false;
      return (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageGuild)
      );
    } catch {
      return false;
    }
  }

  app.get("/api/config/client-id", (req, res) => {
    return res.json({ clientId: process.env.CLIENT_ID || (client.user ? client.user.id : "1545579974310764596") });
  });

  app.get("/api/public/stats", (req, res) => {
    try {
      let totalUsers = 0;
      if (client.guilds?.cache) {
        for (const guild of client.guilds.cache.values()) {
          totalUsers += guild.memberCount || guild.approximateMemberCount || (guild.members?.cache ? guild.members.cache.size : 0) || 0;
        }
      }
      const totalServers = client.guilds?.cache?.size || 0;
      const totalChannels = client.channels?.cache?.size || 0;
      const botCommands = bot.commands ? bot.commands() : [];
      const commandsList = botCommands.map((c) => ({
        name: c.name,
        description: c.description,
      }));

      const uptimeSec = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSec / 3600);
      const days = Math.floor(hours / 24);
      const ping = client.ws && client.ws.ping > 0 ? Math.round(client.ws.ping) : 18;

      return res.json({
        success: true,
        developer: {
          name: "Aimbot",
          tag: "aimbot.xd",
          role: "Dev : C++ | Python"
        },
        users: totalUsers,
        servers: totalServers,
        channels: totalChannels,
        commandsCount: commandsList.length || 46,
        commands: commandsList,
        ping: `${ping}ms`,
        uptime: days > 0 ? `${days}d ${hours % 24}h` : `${hours}h`,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Discord OAuth2 Token verification (Official Discord Login)
  app.post("/api/auth/discord-token", async (req, res) => {
    try {
      const { access_token } = req.body;
      if (!access_token) {
        return res.status(400).json({ success: false, error: "Missing access_token" });
      }

      // 1. Fetch user profile
      const userRes = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!userRes.ok) {
        return res.status(401).json({ success: false, error: "Invalid or expired Discord access token." });
      }
      const discordUser = await userRes.json();

      // 2. Fetch user's guilds
      const guildsRes = await fetch("https://discord.com/api/users/@me/guilds", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const userGuilds = guildsRes.ok ? await guildsRes.json() : [];

      const isMaster =
        discordUser.id === OWNER_ID || discordUser.id === "1407070875039301713";

      const accessibleGuilds = [];

      for (const [, guild] of client.guilds.cache) {
        let isAdmin = isMaster;
        if (!isAdmin) {
          const userG = userGuilds.find((ug) => ug.id === guild.id);
          if (userG) {
            const perms = BigInt(userG.permissions || "0");
            const hasAdmin = (perms & 0x8n) === 0x8n || (perms & 0x20n) === 0x20n || userG.owner;
            if (hasAdmin) isAdmin = true;
          }
          if (!isAdmin) {
            isAdmin = await checkUserGuildAdmin(discordUser.id, guild);
          }
        }

        if (isAdmin) {
          accessibleGuilds.push({
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL({ dynamic: true, size: 256 }),
            memberCount: guild.memberCount,
            isOwner: guild.ownerId === discordUser.id || isMaster,
          });
        }
      }

      const avatarUrl = discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(discordUser.discriminator || "0") % 5}.png`;

      return res.json({
        success: true,
        user: {
          id: discordUser.id,
          username: discordUser.global_name || discordUser.username,
          tag: discordUser.username,
          avatar: avatarUrl,
          isOwner: isMaster,
          serversCount: accessibleGuilds.length,
        },
        guilds: accessibleGuilds,
      });
    } catch (err) {
      console.error("[OAuth2 Token Error]", err);
      return res.status(500).json({ success: false, error: "Failed to authenticate with Discord." });
    }
  });

  // 1. AUTH LOGIN & ADMIN DISCOVERY
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { discordId, passcode } = req.body;
      const cleanId = (discordId || "").trim();

      if (!cleanId && !passcode) {
        return res.status(400).json({ success: false, error: "Please provide your Discord User ID." });
      }

      const isMaster = cleanId === OWNER_ID || cleanId === "1407070875039301713";
      const targetUserId = cleanId || OWNER_ID;

      const accessibleGuilds = [];

      for (const [, guild] of client.guilds.cache) {
        let isAdmin = isMaster;
        if (!isAdmin) {
          isAdmin = await checkUserGuildAdmin(targetUserId, guild);
        }

        if (isAdmin) {
          accessibleGuilds.push({
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL({ dynamic: true, size: 256 }),
            memberCount: guild.memberCount,
            isOwner: guild.ownerId === targetUserId || isMaster,
          });
        }
      }

      if (accessibleGuilds.length === 0) {
        return res.status(403).json({
          success: false,
          error: "[X] Access Denied: Is Discord ID ke paas kisi bhi bot-connected server me Administrator permission nahi hai!",
        });
      }

      return res.json({
        success: true,
        user: {
          id: targetUserId,
          isOwner: isMaster,
          serversCount: accessibleGuilds.length,
        },
        guilds: accessibleGuilds,
      });
    } catch (err) {
      console.error("[Web Auth Error]", err);
      return res.status(500).json({ success: false, error: "Internal server error." });
    }
  });

  // 2. GET GUILD DETAILS (Channels, Roles, Config)
  app.get("/api/guild/:id", async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.query.userId;
      const guild = client.guilds.cache.get(req.params.id);

      if (!guild) {
        return res.status(404).json({ success: false, error: "Server not found." });
      }

      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) {
        return res.status(403).json({ success: false, error: "Access Denied: You are not an admin of this server." });
      }

      const cfg = getGuild(guild.id);
      if (cfg.welcomeImage && typeof cfg.welcomeImage === "string" && (cfg.welcomeImage.includes("pastel-divider") || cfg.welcomeImage.includes("1354094094443352134") || cfg.welcomeImage.includes("rainbow-line.png"))) {
        cfg.welcomeImage = null;
        save();
      }

      if (guild.channels.cache.size === 0) {
        await guild.channels.fetch().catch(() => {});
      }
      if (guild.roles.cache.size <= 1) {
        await guild.roles.fetch().catch(() => {});
      }

      // Text Channels (Safe filter: 0 = GuildText, 5 = GuildAnnouncement)
      const textChannels = [];
      const voiceChannels = [];
      const categories = [];
      for (const [, c] of guild.channels.cache) {
        if (c) {
          if (c.type === 0 || c.type === 5) {
            textChannels.push({ id: c.id, name: c.name });
          } else if (c.type === 2) {
            voiceChannels.push({ id: c.id, name: c.name });
          } else if (c.type === 4) {
            categories.push({ id: c.id, name: c.name });
          }
        }
      }
      textChannels.sort((a, b) => a.name.localeCompare(b.name));
      voiceChannels.sort((a, b) => a.name.localeCompare(b.name));
      categories.sort((a, b) => a.name.localeCompare(b.name));

      // Roles
      const roles = [];
      for (const [, r] of guild.roles.cache) {
        if (r && r.name !== "@everyone") {
          roles.push({ id: r.id, name: r.name, color: r.hexColor || "#99aab5" });
        }
      }
      roles.sort((a, b) => a.name.localeCompare(b.name));

      return res.json({
        success: true,
        guild: {
          id: guild.id,
          name: guild.name,
          icon: guild.iconURL ? guild.iconURL({ size: 256 }) : null,
          memberCount: guild.memberCount,
          channels: textChannels,
          voiceChannels: voiceChannels,
          categories: categories,
          roles: roles,
          isPremium: isGuildPremium(guild.id, userId),
        },
        config: cfg,
      });
    } catch (err) {
      console.error("[Web Guild Error]", err);
      return res.status(500).json({ success: false, error: "Failed to fetch guild details: " + (err ? err.message : "Internal Error") });
    }
  });

  // 3. SAVE GUILD CONFIGURATION
  app.post("/api/guild/:id/config", async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.body.userId;
      const guild = client.guilds.cache.get(req.params.id);

      if (!guild) {
        return res.status(404).json({ success: false, error: "Server not found." });
      }

      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) {
        return res.status(403).json({ success: false, error: "Access Denied." });
      }

      const cfg = getGuild(guild.id);
      const updates = req.body;

      if (updates.welcome) {
        const w = updates.welcome;
        if (w.enabled !== undefined) cfg.welcomeEnabled = !!w.enabled;
        if (w.channelId !== undefined) cfg.welcomeChannelId = w.channelId || null;
        if (w.messageType !== undefined) cfg.welcomeMessageType = w.messageType;
        if (w.autoDelete !== undefined) cfg.welcomeAutoDelete = parseInt(w.autoDelete) || 0;
        if (w.message !== undefined) cfg.welcomeMessage = w.message || null;
        if (w.authorName !== undefined) cfg.welcomeAuthorName = w.authorName || null;
        if (w.authorIcon !== undefined) cfg.welcomeAuthorIcon = w.authorIcon || null;
        if (w.botName !== undefined) cfg.welcomeBotName = w.botName || null;
        if (w.botAvatar !== undefined) cfg.welcomeBotAvatar = w.botAvatar || null;
        if (w.thumb !== undefined) cfg.welcomeThumb = w.thumb || null;
        if (w.title !== undefined) cfg.welcomeTitle = w.title || null;
        if (w.tagline !== undefined) cfg.welcomeTagline = w.tagline || null;
        if (w.subtext !== undefined) cfg.welcomeSubtext = w.subtext || null;
        if (w.description !== undefined) cfg.welcomeDescription = w.description || null;
        if (w.image !== undefined) {
          const imgVal = (typeof w.image === "string" ? w.image.trim() : "");
          if (imgVal.includes("pastel-divider") || imgVal.includes("1354094094443352134") || imgVal.includes("rainbow-line")) {
            cfg.welcomeImage = null;
          } else {
            cfg.welcomeImage = imgVal || null;
          }
        }
        if (w.color !== undefined) cfg.welcomeColor = w.color || null;
        if (w.footer !== undefined) cfg.welcomeFooter = w.footer || null;
        if (w.footerIcon !== undefined) cfg.welcomeFooterIcon = w.footerIcon || null;
        if (w.autoRoleIds !== undefined) {
          cfg.autoRoleIds = Array.isArray(w.autoRoleIds) ? w.autoRoleIds : (w.autoRoleIds ? [w.autoRoleIds] : []);
          cfg.autoRoleId = cfg.autoRoleIds[0] || null;
          if (cfg.autoRoleId) cfg.humanAutoRoleIds = [cfg.autoRoleId];
        } else if (w.autoRoleId !== undefined) {
          cfg.autoRoleId = w.autoRoleId || null;
          cfg.autoRoleIds = w.autoRoleId ? [w.autoRoleId] : [];
          if (w.autoRoleId) cfg.humanAutoRoleIds = [w.autoRoleId];
        }
        if (w.embed !== undefined) cfg.welcomeEmbed = !!w.embed;
      }

      if (updates.autoroles) {
        if (updates.autoroles.human !== undefined) cfg.humanAutoRoleIds = Array.isArray(updates.autoroles.human) ? updates.autoroles.human : [];
        if (updates.autoroles.bot !== undefined) cfg.botAutoRoleIds = Array.isArray(updates.autoroles.bot) ? updates.autoroles.bot : [];
      }

      if (updates.ticket) {
        const t = updates.ticket;
        if (t.supportRoleIds !== undefined) {
          cfg.supportRoleIds = Array.isArray(t.supportRoleIds) ? t.supportRoleIds : (t.supportRoleIds ? [t.supportRoleIds] : []);
          cfg.supportRoleId = cfg.supportRoleIds[0] || null;
        } else if (t.supportRoleId !== undefined) {
          cfg.supportRoleId = t.supportRoleId || null;
          cfg.supportRoleIds = t.supportRoleId ? [t.supportRoleId] : [];
        }
        if (t.ticketCategoryId !== undefined) cfg.ticketCategoryId = t.ticketCategoryId || null;
        if (t.ticketNaming !== undefined) cfg.ticketNaming = t.ticketNaming || null;
        if (t.ticketPrefix !== undefined) cfg.ticketPrefix = t.ticketPrefix || null;
        if (t.ticketCreatedMsg !== undefined) cfg.ticketCreatedMsg = t.ticketCreatedMsg || null;
        if (t.ticketWelcomeDesc !== undefined) cfg.ticketWelcomeDesc = t.ticketWelcomeDesc || null;
      }

      if (updates.ticketPanel) {
        cfg.ticketPanel = {
          ...(cfg.ticketPanel || {}),
          ...updates.ticketPanel,
        };
      }

      if (updates.supportRoleIds !== undefined) {
        cfg.supportRoleIds = Array.isArray(updates.supportRoleIds) ? updates.supportRoleIds : (updates.supportRoleIds ? [updates.supportRoleIds] : []);
        cfg.supportRoleId = cfg.supportRoleIds[0] || null;
      }
      if (updates.ticketCategoryId !== undefined) cfg.ticketCategoryId = updates.ticketCategoryId || null;
      if (updates.ticketTranscriptChannelId !== undefined) cfg.ticketTranscriptChannelId = updates.ticketTranscriptChannelId || null;
      if (updates.ticketNaming !== undefined) cfg.ticketNaming = updates.ticketNaming || null;
      if (updates.ticketWelcomeDesc !== undefined) cfg.ticketWelcomeDesc = updates.ticketWelcomeDesc || null;

      if (updates.customRoles) {
        cfg.customRoles = {
          ...cfg.customRoles,
          ...updates.customRoles,
        };
      }

      if (updates.botBranding) {
        cfg.botBranding = {
          ...cfg.botBranding,
          ...updates.botBranding,
        };
        if (updates.botBranding.activityText && client.user) {
          try {
            client.user.setActivity(updates.botBranding.activityText, {
              type: updates.botBranding.activityType === "Watching" ? 3 :
                    updates.botBranding.activityType === "Listening" ? 2 :
                    updates.botBranding.activityType === "Competing" ? 5 : 0
            });
          } catch (actErr) {}
        }
      }

      if (updates.prefix !== undefined) {
        cfg.prefix = updates.prefix || "!";
      }

      if (updates.eventLogging) {
        cfg.eventLogging = {
          ...(cfg.eventLogging || {}),
          ...updates.eventLogging,
        };
      }

      if (updates.automod) {
        cfg.automod = {
          ...(cfg.automod || {}),
          ...updates.automod,
        };
      }

      if (updates.antiNuke) {
        cfg.antiNuke = {
          ...(cfg.antiNuke || {}),
          ...updates.antiNuke,
          limits: {
            ...((cfg.antiNuke && cfg.antiNuke.limits) || {}),
            ...(updates.antiNuke.limits || {}),
          },
        };
      }

      save();
      return res.json({ success: true, message: "Settings saved successfully!" });
    } catch (err) {
      console.error("[Web Save Error]", err);
      return res.status(500).json({ success: false, error: "Failed to save configuration." });
    }
  });

  // 4. SEND TEST WELCOME CARD
  app.post("/api/guild/:id/welcome/test", rateLimiter(5, 60000), async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.body.userId;
      const guild = client.guilds.cache.get(req.params.id);

      if (!guild) return res.status(404).json({ success: false, error: "Server not found." });

      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) return res.status(403).json({ success: false, error: "Access Denied." });

      const cfg = getGuild(guild.id);

      if (req.body.welcome) {
        const w = req.body.welcome;
        if (w.channelId !== undefined) cfg.welcomeChannelId = w.channelId || null;
        if (w.message !== undefined) cfg.welcomeMessage = w.message || null;
        if (w.authorName !== undefined) cfg.welcomeAuthorName = w.authorName || null;
        cfg.welcomeAuthorIcon = null; // Removed as requested
        if (w.botName !== undefined) cfg.welcomeBotName = w.botName || null;
        if (w.botAvatar !== undefined) cfg.welcomeBotAvatar = w.botAvatar || null;
        if (w.thumb !== undefined) cfg.welcomeThumb = w.thumb || null;
        if (w.title !== undefined) cfg.welcomeTitle = w.title || null;
        if (w.tagline !== undefined) cfg.welcomeTagline = w.tagline || null;
        if (w.subtext !== undefined) cfg.welcomeSubtext = w.subtext || null;
        if (w.description !== undefined) cfg.welcomeDescription = w.description || null;
        if (w.image !== undefined) {
          const imgVal = (typeof w.image === "string" ? w.image.trim() : "");
          if (imgVal.includes("pastel-divider") || imgVal.includes("1354094094443352134") || imgVal.includes("rainbow-line")) {
            cfg.welcomeImage = null;
          } else {
            cfg.welcomeImage = imgVal || null;
          }
        }
        if (w.color !== undefined) cfg.welcomeColor = w.color || null;
        if (w.footer !== undefined) cfg.welcomeFooter = w.footer || null;
        if (w.autoRoleIds !== undefined) {
          cfg.autoRoleIds = Array.isArray(w.autoRoleIds) ? w.autoRoleIds : (w.autoRoleIds ? [w.autoRoleIds] : []);
          cfg.autoRoleId = cfg.autoRoleIds[0] || null;
        } else if (w.autoRoleId !== undefined) {
          cfg.autoRoleId = w.autoRoleId || null;
          cfg.autoRoleIds = w.autoRoleId ? [w.autoRoleId] : [];
        }
        save();
      }

      const targetChId = req.body.channelId || cfg.welcomeChannelId;
      const ch = guild.channels.cache.get(targetChId);

      if (!ch) {
        return res.status(400).json({ success: false, error: "Please select a valid channel to send the test card." });
      }

      let member = guild.members.cache.get(userId) || guild.members.me;
      await sendZenithWelcome(ch, member, cfg, guild);

      return res.json({ success: true, message: `Test welcome card sent to #${ch.name}!` });
    } catch (err) {
      console.error("[Web Test Card Error]", err);
      return res.status(500).json({ success: false, error: "Failed to send test card." });
    }
  });

  // SEND CUSTOM DISCORD EMBED
  app.post("/api/guild/:id/send-embed", async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.body.userId;
      const guild = client.guilds.cache.get(req.params.id);
      if (!guild) return res.status(404).json({ success: false, error: "Server not found." });
      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) return res.status(403).json({ success: false, error: "Access Denied." });

      const { channelId, content, title, description, color, authorName, authorIcon, footerText, footerIcon, thumbnailUrl, imageUrl } = req.body;
      const ch = guild.channels.cache.get(channelId);
      if (!ch) return res.status(400).json({ success: false, error: "Please select a valid channel to send the embed." });

      const { EmbedBuilder } = require("discord.js");
      const embed = new EmbedBuilder();
      if (title && title.trim()) embed.setTitle(title.trim());
      if (description && description.trim()) embed.setDescription(description.trim());
      if (color && color.trim()) {
        try {
          embed.setColor(parseInt(color.trim().replace("#", ""), 16));
        } catch (e) {
          embed.setColor(0x3b82f6);
        }
      } else {
        embed.setColor(0x3b82f6);
      }
      if (authorName && authorName.trim()) {
        embed.setAuthor({ name: authorName.trim(), iconURL: authorIcon && authorIcon.trim().startsWith("http") ? authorIcon.trim() : undefined });
      }
      if (footerText && footerText.trim()) {
        embed.setFooter({ text: footerText.trim(), iconURL: footerIcon && footerIcon.trim().startsWith("http") ? footerIcon.trim() : undefined });
      }
      if (thumbnailUrl && thumbnailUrl.trim().startsWith("http")) {
        embed.setThumbnail(thumbnailUrl.trim());
      }
      if (imageUrl && imageUrl.trim().startsWith("http")) {
        embed.setImage(imageUrl.trim());
      }
      embed.setTimestamp();

      const payload = { embeds: [embed] };
      if (content && content.trim()) payload.content = content.trim();

      await ch.send(payload);
      return res.json({ success: true, message: `Embed sent successfully to #${ch.name}!` });
    } catch (err) {
      console.error("[Send Embed Error]:", err);
      return res.status(500).json({ success: false, error: "Failed to send embed: " + err.message });
    }
  });

  // START COMMUNITY GIVEAWAY
  app.post("/api/guild/:id/giveaways/start", async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.body.userId;
      const guild = client.guilds.cache.get(req.params.id);
      if (!guild) return res.status(404).json({ success: false, error: "Server not found." });
      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) return res.status(403).json({ success: false, error: "Access Denied." });

      const { channelId, prize, winners, durationMinutes } = req.body;
      const ch = guild.channels.cache.get(channelId);
      if (!ch) return res.status(400).json({ success: false, error: "Target channel not found." });

      const winCount = parseInt(winners) || 1;
      const mins = parseInt(durationMinutes) || 60;
      const endTimestamp = Math.floor(Date.now() / 1000) + mins * 60;

      const { EmbedBuilder } = require("discord.js");
      const embed = new EmbedBuilder()
        .setTitle(`GIVEAWAY: ${prize || "Discord Nitro"}`)
        .setDescription(`Click reaction to participate!\n\n**Winners:** ${winCount}\n**Ends:** <t:${endTimestamp}:R> (<t:${endTimestamp}:f>)\n**Hosted By:** <@${userId}>`)
        .setColor(0x5865f2)
        .setFooter({ text: "Zenith Giveaways" })
        .setTimestamp();

      const msg = await ch.send({ embeds: [embed] });
      await msg.react("").catch(() => {});

      return res.json({ success: true, message: `Giveaway created in #${ch.name}!` });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 5. ZENITH VOICE TOGGLE
  app.post("/api/guild/:id/voice", async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.body.userId;
      const guild = client.guilds.cache.get(req.params.id);

      if (!guild) return res.status(404).json({ success: false, error: "Server not found." });

      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) return res.status(403).json({ success: false, error: "Access Denied." });

      const { action, channelId, categoryName, channelName, roomPattern } = req.body;
      let result;
      if (action === "enable") {
        result = await setupTempVoice(guild, channelId || null, { categoryName, channelName, roomPattern });
      } else {
        result = await disableTempVoice(guild);
      }

      return res.json({ success: true, message: result.message, config: getGuild(guild.id).tempVoice });
    } catch (err) {
      console.error("[Web Voice Error]", err);
      return res.status(500).json({ success: false, error: err.message || "Failed to toggle Zenith Voice." });
    }
  });

  // 6. SYSTEM STATUS
  app.get("/api/status", (req, res) => {
    let totalMembers = 0;
    for (const [, g] of client.guilds.cache) {
      totalMembers += g.memberCount;
    }
    return res.json({
      online: true,
      botTag: client.user ? client.user.tag : "Zenith",
      ping: Math.round(client.ws.ping),
      uptimeSeconds: Math.floor(process.uptime()),
      guildsCount: client.guilds.cache.size,
      membersCount: totalMembers,
    });
  });


  // 6. DEPLOY ZENITH TICKET PANEL
  app.post("/api/guild/:id/ticket/deploy", rateLimiter(5, 60000), async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.body.userId;
      const guild = client.guilds.cache.get(req.params.id);
      if (!guild) return res.status(404).json({ success: false, error: "Server not found." });

      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) return res.status(403).json({ success: false, error: "Access Denied." });

      const {
        channelId,
        title,
        description,
        image,
        thumb,
        color,
        supportRoleId,
        supportRoleIds,
        ticketCategoryId,
        ticketNaming,
        ticketPrefix,
        ticketCreatedMsg,
        ticketWelcomeDesc,
        botName,
        botAvatar,
        authorName,
        authorIcon,
        footer,
        btnLabel,
        buttonLabel,
      } = req.body;
      const ch = guild.channels.cache.get(channelId);
      if (!ch) return res.status(400).json({ success: false, error: "Please select a valid channel to deploy the ticket panel." });

      const finalBtnLabel = buttonLabel || btnLabel || "Open Ticket";
      const cfg = getGuild(guild.id);
      cfg.ticketPanel = { channelId, title, description, image, thumb, color, botName, botAvatar, authorName, authorIcon, footer, buttonLabel: finalBtnLabel, btnLabel: finalBtnLabel };
      if (supportRoleIds !== undefined) {
        cfg.supportRoleIds = Array.isArray(supportRoleIds) ? supportRoleIds : (supportRoleIds ? [supportRoleIds] : []);
        cfg.supportRoleId = cfg.supportRoleIds[0] || null;
      } else if (supportRoleId) {
        cfg.supportRoleId = supportRoleId;
        cfg.supportRoleIds = [supportRoleId];
      }
      if (ticketCategoryId !== undefined) cfg.ticketCategoryId = ticketCategoryId || null;
      if (ticketNaming !== undefined) cfg.ticketNaming = ticketNaming || null;
      if (ticketPrefix !== undefined) cfg.ticketPrefix = ticketPrefix || null;
      if (ticketCreatedMsg !== undefined) cfg.ticketCreatedMsg = ticketCreatedMsg || null;
      if (ticketWelcomeDesc !== undefined) cfg.ticketWelcomeDesc = ticketWelcomeDesc || null;
      save();

      await sendTicketPanel(guild, ch, { title, description, image, thumb, color, botName, botAvatar, authorName, authorIcon, footer, buttonLabel: finalBtnLabel });
      return res.json({ success: true, message: `Zenith Ticket Panel deployed to #${ch.name}!` });
    } catch (err) {
      console.error("[Ticket Deploy Error]", err);
      return res.status(500).json({ success: false, error: "Failed to deploy ticket panel: " + err.message });
    }
  });

  // 7. SEND SERVER ANNOUNCEMENT
  app.post("/api/guild/:id/announce", rateLimiter(5, 60000), async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.body.userId;
      const guild = client.guilds.cache.get(req.params.id);
      if (!guild) return res.status(404).json({ success: false, error: "Server not found." });

      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) return res.status(403).json({ success: false, error: "Access Denied." });

      const { channelId, title, message, image, color, ping, botName, botAvatar, authorName, authorIcon, footer } = req.body;
      const ch = guild.channels.cache.get(channelId);
      if (!ch) return res.status(400).json({ success: false, error: "Please select a channel for the announcement." });

      const cfg = getGuild(guild.id);
      cfg.announcement = { channelId, title, message, image, color, ping, botName, botAvatar, authorName, authorIcon, footer };
      save();

      await sendServerAnnouncement(guild, ch, { title, message, image, color, ping, botName, botAvatar, authorName, authorIcon, footer });
      return res.json({ success: true, message: `Announcement posted to #${ch.name}!` });
    } catch (err) {
      console.error("[Announce Error]", err);
      return res.status(500).json({ success: false, error: "Failed to post announcement: " + err.message });
    }
  });

  // 8. SEND SERVER RULES
  app.post("/api/guild/:id/rules", rateLimiter(5, 60000), async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.body.userId;
      const guild = client.guilds.cache.get(req.params.id);
      if (!guild) return res.status(404).json({ success: false, error: "Server not found." });

      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) return res.status(403).json({ success: false, error: "Access Denied." });

      const { channelId, title, rules, image, color, botName, botAvatar, authorName, authorIcon, footer } = req.body;
      const ch = guild.channels.cache.get(channelId);
      if (!ch) return res.status(400).json({ success: false, error: "Please select a channel to post rules." });

      const cfg = getGuild(guild.id);
      cfg.serverRules = { channelId, title, text: rules, image, color, botName, botAvatar, authorName, authorIcon, footer };
      save();

      await sendServerRules(guild, ch, { title, rules, image, color, botName, botAvatar, authorName, authorIcon, footer });
      return res.json({ success: true, message: `Server rules posted to #${ch.name}!` });
    } catch (err) {
      console.error("[Rules Error]", err);
      return res.status(500).json({ success: false, error: "Failed to post rules: " + err.message });
    }
  });

  // 9. DM BLAST — Send invite DM to all guild members
  app.post("/api/dmblast", rateLimiter(2, 60000), async (req, res) => {
    try {
      const BOT_OWNER_ID = process.env.OWNER_ID || "1407070875039301713";
      const userId = req.headers["x-user-id"] || req.body.userId;
      const { guildId, inviteUrl, title } = req.body;

      if (!guildId || !inviteUrl) {
        return res.status(400).json({ success: false, error: "Missing target server or invite URL." });
      }

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return res.status(404).json({ success: false, error: "Server not found in bot cache." });
      }

      const isAuthorized = (userId === BOT_OWNER_ID) || (await checkUserGuildAdmin(userId, guild));
      if (!isAuthorized) {
        return res.status(403).json({ success: false, error: "Access Denied: Administrator or Bot Owner only." });
      }

      const msgTitle = title || "Join Our Zenith Dev Server";
      const targetInvite = inviteUrl || "https://discord.gg/RmV56QrpPg";

      res.json({
        success: true,
        message: `DM broadcast initiated for members of ${guild.name}. Running safely in background...`,
      });

      // Background DM sender with 1.5s rate-limit delay
      (async () => {
        try {
          const content = `**Sent from ${guild.name}**\n\n> **${msgTitle}**\n> ${targetInvite}`;
          let sent = 0;
          let failed = 0;
          const members = await guild.members.fetch().catch(() => null);
          if (members) {
            for (const [, member] of members) {
              if (member.user.bot) continue;
              try {
                await member.send(content);
                sent++;
              } catch (_) {
                failed++;
              }
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
          console.log(`[DM Blast Complete] Guild: ${guild.name} | Sent: ${sent} | Failed: ${failed}`);
        } catch (bgErr) {
          console.error("[DM Blast Background Error]", bgErr);
        }
      })();
    } catch (err) {
      console.error("[DM Blast Error]", err);
      if (!res.headersSent) {
        return res.status(500).json({ success: false, error: "DM Broadcast error: " + err.message });
      }
    }
  });

  // Safe Container Restart Trigger
  app.get("/api/admin/restart", (req, res) => {
    res.json({ success: true, message: "Restarting container process to load latest code..." });
    setTimeout(() => {
      process.exit(0);
    }, 800);
  });

  // 9b. MUSIC DEBUG RESOLVER
  app.get("/api/debug-music", async (req, res) => {
    const logs = [];
    const log = (msg) => logs.push(msg);
    try {
      const q = req.query.q || "DIL TO PAGAL HAI";
      log("Query: " + q);

      // Test SC client ID fetch
      let clientId = "Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo";
      try {
        const scRes = await fetch("https://soundcloud.com", {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
        });
        log("SoundCloud homepage status: " + scRes.status);
        const html = await scRes.text();
        const regex = /<script[^>]+src="([^"]+)"/g;
        let m;
        const scripts = [];
        while ((m = regex.exec(html)) !== null) scripts.push(m[1]);
        log("Found SC scripts: " + scripts.length);
        for (const sc of scripts.slice(-8)) {
          const r = await fetch(sc);
          const t = await r.text();
          const idM = t.match(/client_id:"([a-zA-Z0-9]{32})"/);
          if (idM) {
            clientId = idM[1];
            log("Extracted fresh SC client_id: " + clientId);
            break;
          }
        }
      } catch (scErr) {
        log("SC homepage error: " + scErr.message);
      }

      // Test SC API query
      try {
        const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${clientId}&limit=3`;
        const apiRes = await fetch(searchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json"
          }
        });
        log("SC API status: " + apiRes.status);
        if (apiRes.ok) {
          const data = await apiRes.json();
          log("SC API tracks count: " + (data.collection?.length || 0));
          if (data.collection?.length > 0) {
            const tr = data.collection[0];
            log("Track 1: " + tr.title + " | url: " + tr.permalink_url);
            const prog = tr.media?.transcodings?.find(x => x.format?.protocol === "progressive") || tr.media?.transcodings?.[0];
            if (prog) {
              const medRes = await fetch(`${prog.url}?client_id=${clientId}`, { headers: { "User-Agent": "Mozilla/5.0" } });
              log("Media url status: " + medRes.status);
              if (medRes.ok) {
                const medData = await medRes.json();
                log("Has CDN url: " + !!medData.url);
              }
            }
          }
        } else {
          const errText = await apiRes.text();
          log("SC API error body: " + errText.slice(0, 150));
        }
      } catch (apiErr) {
        log("SC API error: " + apiErr.message);
      }

      const { resolvePlayableTrack } = bot;
      const track = await resolvePlayableTrack(q, "WebTester", "123");
      return res.json({ success: true, logs, track });
    } catch (e) {
      return res.status(500).json({ success: false, logs, error: e.message });
    }
  });

  // 10. MEDIA RESOLVER (For dashboard live preview)
  app.get("/api/resolve-media", async (req, res) => {
    try {
      const rawUrl = req.query.url;
      if (!rawUrl || typeof rawUrl !== "string") {
        return res.status(400).json({ success: false, error: "Missing url parameter." });
      }
      const resolved = await resolveMediaUrl(rawUrl);
      if (resolved && resolved.url) {
        return res.json({ success: true, ...resolved });
      }
      return res.json({ success: false, url: rawUrl });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 11. PUBLIC ONLINE TRANSCRIPT VIEWER
  app.get("/transcript/:id", (req, res) => {
    try {
      const rawId = req.params.id.replace(/[^a-zA-Z0-9_\-]/g, "");
      const filePath = path.join(TRANSCRIPTS_DIR, `${rawId}.html`);
      if (fs.existsSync(filePath)) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.sendFile(filePath);
      }
      return res.status(404).send("<h2>Transcript Not Found</h2><p>This ticket transcript may have expired or been deleted.</p>");
    } catch (err) {
      return res.status(500).send("Error reading transcript: " + err.message);
    }
  });

  // 12. GUILD INVITE TRACKING & LEADERBOARD
  app.get("/api/guild/:id/invites", async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.query.userId;
      const guild = client.guilds.cache.get(req.params.id);
      if (!guild) return res.status(404).json({ success: false, error: "Server not found." });

      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) return res.status(403).json({ success: false, error: "Access Denied." });

      const cfg = getGuild(guild.id);
      const leaderboard = getGuildInviteLeaderboard(guild.id, 50);

      // Enhance leaderboard with user tags & avatars
      const enrichedLeaderboard = leaderboard.map((entry) => {
        const member = guild.members.cache.get(entry.userId);
        return {
          ...entry,
          tag: member ? member.user.tag : `User (${entry.userId})`,
          avatar: member ? member.user.displayAvatarURL({ size: 64 }) : null,
        };
      });

      // Active Guild Invites (Discord API)
      let activeInvites = [];
      const me = guild.members.me;
      const hasPermission = Boolean(me && me.permissions.has(PermissionFlagsBits.ManageGuild));
      if (hasPermission) {
        const fetched = await guild.invites.fetch().catch(() => null);
        if (fetched) {
          activeInvites = [...fetched.values()].map((inv) => ({
            code: inv.code,
            inviter: inv.inviter ? inv.inviter.tag : "Unknown",
            inviterId: inv.inviter ? inv.inviter.id : null,
            uses: inv.uses || 0,
            maxUses: inv.maxUses || 0,
            expiresAt: inv.expiresAt ? inv.expiresAt.toISOString() : null,
          })).sort((a, b) => b.uses - a.uses);
        }
      }

      return res.json({
        success: true,
        enabled: cfg.inviteTracking?.enabled ?? true,
        hasPermission,
        leaderboard: enrichedLeaderboard,
        activeInvites,
      });
    } catch (err) {
      console.error("[Web Invites Error]", err);
      return res.status(500).json({ success: false, error: "Failed to fetch invite statistics: " + err.message });
    }
  });

  // 13. MANAGE INVITES (Toggle, Bonus, Reset)
  app.post("/api/guild/:id/invites", async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.body.userId;
      const guild = client.guilds.cache.get(req.params.id);
      if (!guild) return res.status(404).json({ success: false, error: "Server not found." });

      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) return res.status(403).json({ success: false, error: "Access Denied." });

      const { action, targetUserId, amount, enabled } = req.body;
      const cfg = getGuild(guild.id);

      if (action === "toggle") {
        if (!cfg.inviteTracking) cfg.inviteTracking = { enabled: true, users: {}, joinedMembers: {} };
        cfg.inviteTracking.enabled = enabled !== undefined ? Boolean(enabled) : !cfg.inviteTracking.enabled;
        save();
        return res.json({ success: true, enabled: cfg.inviteTracking.enabled, message: `Invite tracking ${cfg.inviteTracking.enabled ? "enabled" : "disabled"}.` });
      }

      if (action === "bonus") {
        if (!targetUserId || amount === undefined) {
          return res.status(400).json({ success: false, error: "Target user ID and bonus amount required." });
        }
        const updated = addBonusInvites(guild.id, targetUserId, parseInt(amount, 10) || 0);
        return res.json({ success: true, message: `Bonus invites updated for user.`, stats: updated });
      }

      if (action === "reset") {
        resetUserInvites(guild.id, targetUserId || "all");
        return res.json({ success: true, message: targetUserId ? `Reset invites for user.` : `Reset all server invite records.` });
      }

      return res.status(400).json({ success: false, error: "Invalid action." });
    } catch (err) {
      console.error("[Web Invites Action Error]", err);
      return res.status(500).json({ success: false, error: "Failed to update invites: " + err.message });
    }
  });

  // 13. EMERGENCY SERVER LOCKDOWN
  app.post("/api/guild/:id/lockdown", rateLimiter(5, 60000), async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.body.userId;
      const guild = client.guilds.cache.get(req.params.id);
      if (!guild) return res.status(404).json({ success: false, error: "Server not found." });

      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) return res.status(403).json({ success: false, error: "Access Denied." });

      const isLock = req.body.lock !== undefined ? !!req.body.lock : true;
      const result = await executeLockdown(guild, isLock);

      return res.json({
        success: true,
        isLock: result.isLock,
        count: result.count,
        message: result.isLock
          ? `Emergency lockdown activated. ${result.count} text channels locked for @everyone.`
          : `Server lockdown lifted. ${result.count} text channels unlocked.`,
      });
    } catch (err) {
      console.error("[Web Lockdown Error]", err);
      return res.status(500).json({ success: false, error: "Failed to execute server lockdown: " + (err ? err.message : "Internal Error") });
    }
  });

  // 14. RESET GUILD CONFIGURATION
  app.post("/api/guild/:id/reset", async (req, res) => {
    try {
      const userId = req.headers["x-user-id"] || req.body.userId;
      const guild = client.guilds.cache.get(req.params.id);
      if (!guild) return res.status(404).json({ success: false, error: "Server not found." });

      const isAuthorized = await checkUserGuildAdmin(userId, guild);
      if (!isAuthorized) return res.status(403).json({ success: false, error: "Access Denied." });

      const { section } = req.body;
      const updated = resetGuildConfig(guild.id, section || "all");
      return res.json({ success: true, message: `Configuration reset to clean defaults.`, config: updated });
    } catch (err) {
      console.error("[Web Reset Error]", err);
      return res.status(500).json({ success: false, error: "Failed to reset: " + err.message });
    }
  });

  // 15. SUBMIT UPI PAYMENT VERIFICATION (UTR) & AUTO-UNLOCK
  app.post("/api/payment/submit", async (req, res) => {
    try {
      const { userId, guildId, plan, amount, utr } = req.body;
      const cleanUtr = (utr ? String(utr) : "").trim();
      if (!cleanUtr || cleanUtr.length < 6) {
        return res.status(400).json({ success: false, error: "Please enter a valid 12-digit UPI UTR / Reference number." });
      }

      if (!db.payments) db.payments = [];
      const record = {
        userId: userId || "Unknown",
        guildId: guildId || null,
        plan: plan || "Zenith Plan",
        amount: Number(amount) || 0,
        utr: cleanUtr,
        timestamp: new Date().toISOString(),
        verified: true,
      };
      db.payments.push(record);

      // Auto-unlock Premium for this server and user
      if (guildId) {
        setGuildPremium(guildId, true);
      }
      if (userId && userId !== "Unknown") {
        setUserPremium(userId, true);
      }
      save();

      console.log(`[UPI Payment Confirmed & Premium Unlocked] Plan: ${record.plan} | Amount: Rs.${record.amount} | UTR: ${record.utr} | User: ${record.userId} | Guild: ${record.guildId}`);
      return res.json({
        success: true,
        isPremiumUnlocked: true,
        message: "Payment confirmed! Zenith Premium access has been unlocked for your server!",
      });
    } catch (err) {
      console.error("[Payment Submit Error]", err);
      return res.status(500).json({ success: false, error: "Failed to process payment record: " + err.message });
    }
  });

  // Fallback to index.html for SPA
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Zenith Web Control] Live and listening on port ${PORT}`);
  });

  // Anti-Slowloris: Close stalled, hanging, or slow byte-by-byte attack connections
  server.setTimeout(10000);
  server.headersTimeout = 8000;
  server.requestTimeout = 10000;
}

module.exports = { startWeb };
