/*****************************************************************************************
 * DISCORD INVITE TRACKER — FULL PROFESSIONAL BOT
 * PART 1 / 2
 * Single File • Supabase Powered • Auto Slash Deploy
 * Author: You
 *****************************************************************************************/

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  Collection,
  EmbedBuilder
} = require("discord.js");

const { createClient } = require("@supabase/supabase-js");
const http = require("http");

/* =======================================================================================
   KEEP ALIVE (RENDER FREE)
======================================================================================= */
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Invite Tracker Alive");
}).listen(process.env.PORT || 3000);

/* =======================================================================================
   SUPABASE
======================================================================================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =======================================================================================
   DISCORD CLIENT
======================================================================================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ],
  partials: [Partials.GuildMember]
});

const inviteCache = new Collection();

/* =======================================================================================
   UTILS
======================================================================================= */
function isAdmin(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

function replaceVars(text, vars) {
  let out = text;
  for (const key in vars) {
    out = out.replaceAll(`{${key}}`, vars[key]);
  }
  return out;
}

function baseEmbed(color = 0x5865f2) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

/* =======================================================================================
   READY + AUTO SLASH DEPLOY
======================================================================================= */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  /* ---------- AUTO DEPLOY COMMANDS ---------- */
  const commands = [
    {
      name: "config",
      description: "Server configuration",
      options: [
        {
          name: "welcome",
          description: "Set welcome channel",
          type: 1,
          options: [
            { name: "channel", type: 7, required: true }
          ]
        },
        {
          name: "toggle",
          description: "Toggle features",
          type: 1,
          options: [
            {
              name: "feature",
              type: 3,
              required: true,
              choices: [
                { name: "welcome", value: "welcome_enabled" },
                { name: "fake_detection", value: "fake_detection" }
              ]
            }
          ]
        },
        {
          name: "embed",
          description: "Set welcome embed",
          type: 1,
          options: [
            { name: "title", type: 3, required: true },
            { name: "description", type: 3, required: true }
          ]
        }
      ]
    },
    {
      name: "invites",
      description: "Check invite stats",
      options: [
        { name: "user", type: 6, required: false }
      ]
    },
    {
      name: "leaderboard",
      description: "Top inviters"
    }
  ];

  await client.application.commands.set(commands);
  console.log("⚡ Slash commands auto-deployed");

  /* ---------- INVITE SNAPSHOT ---------- */
  for (const guild of client.guilds.cache.values()) {
    const invites = await guild.invites.fetch();
    inviteCache.set(
      guild.id,
      new Collection(invites.map(i => [i.code, i.uses]))
    );

    for (const invite of invites.values()) {
      await supabase.from("invites").upsert({
        guild_id: guild.id,
        code: invite.code,
        inviter_id: invite.inviter?.id || "unknown",
        uses: invite.uses
      });
    }

    // baseline existing members
    const members = await guild.members.fetch();
    for (const m of members.values()) {
      await supabase.from("invite_history").upsert({
        guild_id: guild.id,
        joined_user_id: m.id,
        inviter_id: "unknown"
      });
    }
  }
});

/* =======================================================================================
   MEMBER JOIN
======================================================================================= */
client.on("guildMemberAdd", async member => {
  const newInvites = await member.guild.invites.fetch();
  const oldInvites = inviteCache.get(member.guild.id);

  let usedInvite;
  for (const inv of newInvites.values()) {
    if ((oldInvites?.get(inv.code) || 0) < inv.uses) {
      usedInvite = inv;
      break;
    }
  }

  inviteCache.set(
    member.guild.id,
    new Collection(newInvites.map(i => [i.code, i.uses]))
  );

  if (!usedInvite || !usedInvite.inviter) return;

  /* DB: joins */
  await supabase.from("joins").insert({
    guild_id: member.guild.id,
    user_id: member.id,
    inviter_id: usedInvite.inviter.id,
    code: usedInvite.code
  });

  /* DB: stats */
  await supabase.from("invite_stats").upsert({
    guild_id: member.guild.id,
    inviter_id: usedInvite.inviter.id,
    total_invites: 1,
    real_invites: 1
  });

  /* DB: history */
  await supabase.from("invite_history").insert({
    guild_id: member.guild.id,
    inviter_id: usedInvite.inviter.id,
    joined_user_id: member.id,
    code: usedInvite.code
  });

  /* WELCOME SYSTEM */
  const { data: config } = await supabase
    .from("guild_config")
    .select("*")
    .eq("guild_id", member.guild.id)
    .maybeSingle();

  const { data: flags } = await supabase
    .from("feature_flags")
    .select("*")
    .eq("guild_id", member.guild.id)
    .maybeSingle();

  if (!config?.welcome_channel) return;
  if (flags && flags.welcome_enabled === false) return;

  const { data: template } = await supabase
    .from("embed_templates")
    .select("*")
    .eq("guild_id", member.guild.id)
    .maybeSingle();

  const channel = member.guild.channels.cache.get(config.welcome_channel);
  if (!channel) return;

  const vars = {
    user: member.toString(),
    inviter: `<@${usedInvite.inviter.id}>`,
    invite_code: usedInvite.code,
    member_count: member.guild.memberCount
  };

  const embed = baseEmbed(template?.color || 0x57f287)
    .setTitle(replaceVars(template?.welcome_title || "Welcome!", vars))
    .setDescription(
      replaceVars(
        template?.welcome_description ||
          "{user} joined • Invited by {inviter}",
        vars
      )
    );

  channel.send({ embeds: [embed] });
});

/* =======================================================================================
   MEMBER LEAVE
======================================================================================= */
client.on("guildMemberRemove", async member => {
  const { data: join } = await supabase
    .from("joins")
    .select("*")
    .eq("guild_id", member.guild.id)
    .eq("user_id", member.id)
    .maybeSingle();

  if (!join) return;

  const joinedAt = new Date(join.joined_at);
  const diffHrs = (Date.now() - joinedAt.getTime()) / 36e5;
  const isFake = diffHrs < 24;

  await supabase.from("invite_stats").upsert({
    guild_id: member.guild.id,
    inviter_id: join.inviter_id,
    total_invites: -1,
    fake_invites: isFake ? 1 : 0,
    leaves: 1
  });

  await supabase.from("member_leaves").insert({
    guild_id: member.guild.id,
    user_id: member.id,
    inviter_id: join.inviter_id,
    joined_at: join.joined_at,
    duration_minutes: Math.floor(diffHrs * 60)
  });
});

/* =======================================================================================
   INTERACTIONS — CONFIG / INVITES / LEADERBOARD
======================================================================================= */
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  /* ---------------- CONFIG ---------------- */
  if (interaction.commandName === "config") {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: "Admin only.", ephemeral: true });

    const sub = interaction.options.getSubcommand();

    if (sub === "welcome") {
      const ch = interaction.options.getChannel("channel");
      await supabase.from("guild_config").upsert({
        guild_id: interaction.guild.id,
        welcome_channel: ch.id
      });
      return interaction.reply(`✅ Welcome channel set to ${ch}`);
    }

    if (sub === "toggle") {
      const feature = interaction.options.getString("feature");
      await supabase.from("feature_flags").upsert({
        guild_id: interaction.guild.id,
        [feature]: true
      });
      return interaction.reply(`⚙️ ${feature} enabled`);
    }

    if (sub === "embed") {
      const title = interaction.options.getString("title");
      const desc = interaction.options.getString("description");

      await supabase.from("embed_templates").upsert({
        guild_id: interaction.guild.id,
        welcome_title: title,
        welcome_description: desc
      });

      return interaction.reply("🎨 Welcome embed updated");
    }
  }

  /* ---------------- INVITES ---------------- */
  if (interaction.commandName === "invites") {
    const user = interaction.options.getUser("user") || interaction.user;

    const { data } = await supabase
      .from("invite_stats")
      .select("*")
      .eq("guild_id", interaction.guild.id)
      .eq("inviter_id", user.id)
      .maybeSingle();

    return interaction.reply(
      `📨 **${user.tag}** has **${data?.total_invites || 0}** invites`
    );
  }

  /* ---------------- LEADERBOARD ---------------- */
  if (interaction.commandName === "leaderboard") {
    const { data } = await supabase
      .from("invite_stats")
      .select("*")
      .eq("guild_id", interaction.guild.id)
      .order("total_invites", { ascending: false })
      .limit(10);

    if (!data?.length)
      return interaction.reply("No invite data yet.");

    const text = data
      .map((u, i) => `**#${i + 1}** <@${u.inviter_id}> — ${u.total_invites}`)
      .join("\n");

    const embed = baseEmbed(0xf1c40f)
      .setTitle("🏆 Invite Leaderboard")
      .setDescription(text);

    return interaction.reply({ embeds: [embed] });
  }
});

/* =======================================================================================
   LOGIN
======================================================================================= */
client.login(process.env.TOKEN);


/*****************************************************************************************
 * PART 2 / 2
 * Rewards • Stats • Logs • Styling • Future-Proof Systems
 *****************************************************************************************/

/* =======================================================================================
   ADVANCED STATS COMMAND
======================================================================================= */
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "stats") {
    const user = interaction.options.getUser("user") || interaction.user;

    const { data } = await supabase
      .from("invite_stats")
      .select("*")
      .eq("guild_id", interaction.guild.id)
      .eq("inviter_id", user.id)
      .maybeSingle();

    const embed = new EmbedBuilder()
      .setTitle(`📊 Stats for ${user.tag}`)
      .addFields(
        { name: "Total Invites", value: `${data?.total_invites || 0}`, inline: true },
        { name: "Real", value: `${data?.real_invites || 0}`, inline: true },
        { name: "Fake", value: `${data?.fake_invites || 0}`, inline: true },
        { name: "Leaves", value: `${data?.leaves || 0}`, inline: true }
      )
      .setColor(0x3498db);

    interaction.reply({ embeds: [embed] });
  }
});

/* =======================================================================================
   REWARD CHECKER (AUTO)
======================================================================================= */
async function checkRewards(guildId, inviterId, member) {
  const { data: stats } = await supabase
    .from("invite_stats")
    .select("*")
    .eq("guild_id", guildId)
    .eq("inviter_id", inviterId)
    .maybeSingle();

  if (!stats) return;

  const { data: rewards } = await supabase
    .from("invite_rewards")
    .select("*")
    .eq("guild_id", guildId);

  for (const reward of rewards || []) {
    if (stats.total_invites >= reward.invites_required) {
      const { data: already } = await supabase
        .from("reward_logs")
        .select("*")
        .eq("guild_id", guildId)
        .eq("user_id", inviterId)
        .eq("invites_required", reward.invites_required)
        .maybeSingle();

      if (already) continue;

      if (reward.reward_type === "role") {
        const role = member.guild.roles.cache.get(reward.role_id);
        if (role) await member.roles.add(role);
      }

      await supabase.from("reward_logs").insert({
        guild_id: guildId,
        user_id: inviterId,
        invites_required: reward.invites_required
      });
    }
  }
}

/* =======================================================================================
   ADMIN LOGGING
======================================================================================= */
async function logAdmin(guildId, adminId, action, details) {
  await supabase.from("admin_logs").insert({
    guild_id: guildId,
    admin_id: adminId,
    action,
    details
  });
}

/* =======================================================================================
   GLOBAL ERROR HANDLER (ANTI-CRASH)
======================================================================================= */
process.on("unhandledRejection", err => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", err => {
  console.error("Uncaught exception:", err);
});

/* =======================================================================================
   END OF FILE
======================================================================================= */
