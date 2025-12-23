
const {
  Client,
  GatewayIntentBits,
  Collection,
  EmbedBuilder
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
const http = require("http");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/* ───────── KEEP ALIVE ───────── */
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot alive");
}).listen(process.env.PORT || 3000);

setInterval(() => {
  fetch(`http://localhost:${process.env.PORT || 3000}`);
}, 5 * 60 * 1000);

/* ───────── SUPABASE ───────── */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ───────── CLIENT ───────── */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ]
});

const inviteCache = new Collection();

/* ───────── READY ───────── */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

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

    // baseline sync (existing members)
    const members = await guild.members.fetch();
    for (const member of members.values()) {
      await supabase.from("invite_history").upsert({
        guild_id: guild.id,
        joined_user_id: member.id,
        inviter_id: "unknown"
      }, { onConflict: "guild_id,joined_user_id" });
    }
  }
});

/* ───────── MEMBER JOIN ───────── */
client.on("guildMemberAdd", async member => {
  const newInvites = await member.guild.invites.fetch();
  const oldInvites = inviteCache.get(member.guild.id);

  let usedInvite;
  for (const invite of newInvites.values()) {
    if ((oldInvites?.get(invite.code) || 0) < invite.uses) {
      usedInvite = invite;
      break;
    }
  }

  inviteCache.set(
    member.guild.id,
    new Collection(newInvites.map(i => [i.code, i.uses]))
  );

  if (!usedInvite || !usedInvite.inviter) return;

  // save join
  await supabase.from("joins").insert({
    guild_id: member.guild.id,
    user_id: member.id,
    inviter_id: usedInvite.inviter.id,
    code: usedInvite.code
  });

  // stats update
  await supabase.from("invite_stats").upsert({
    guild_id: member.guild.id,
    inviter_id: usedInvite.inviter.id,
    total_invites: 1,
    real_invites: 1
  }, { onConflict: "guild_id,inviter_id", increment: ["total_invites", "real_invites"] });

});

/* ───────── MEMBER LEAVE ───────── */
client.on("guildMemberRemove", async member => {
  const { data } = await supabase
    .from("joins")
    .select("*")
    .eq("guild_id", member.guild.id)
    .eq("user_id", member.id)
    .maybeSingle();

  if (!data) return;

  const joinedAt = new Date(data.joined_at);
  const diffHours = (Date.now() - joinedAt.getTime()) / 36e5;

  const isFake = diffHours < 24;

  await supabase.from("invite_stats").upsert({
    guild_id: member.guild.id,
    inviter_id: data.inviter_id,
    total_invites: -1,
    fake_invites: isFake ? 1 : 0,
    leaves: 1
  }, { onConflict: "guild_id,inviter_id", increment: ["total_invites", "fake_invites", "leaves"] });

  await supabase.from("member_leaves").insert({
    guild_id: member.guild.id,
    user_id: member.id,
    inviter_id: data.inviter_id,
    joined_at: data.joined_at,
    duration_minutes: Math.floor(diffHours * 60)
  });
});

/* ───────── SLASH COMMANDS ───────── */
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "invites") {
    const user = interaction.options.getUser("user") || interaction.user;

    const { data } = await supabase
      .from("invite_stats")
      .select("*")
      .eq("guild_id", interaction.guild.id)
      .eq("inviter_id", user.id)
      .maybeSingle();

    return interaction.reply({
      content: `📨 **${user.tag}** has **${data?.total_invites || 0}** invites`
    });
  }

  if (interaction.commandName === "leaderboard") {
    const { data } = await supabase
      .from("invite_stats")
      .select("*")
      .eq("guild_id", interaction.guild.id)
      .order("total_invites", { ascending: false })
      .limit(10);

    if (!data?.length) return interaction.reply("No data yet.");

    const text = data
      .map((u, i) => `#${i + 1} <@${u.inviter_id}> — ${u.total_invites}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle("🏆 Invite Leaderboard")
      .setDescription(text)
      .setColor(0xf1c40f);

    interaction.reply({ embeds: [embed] });
  }
});

/* ───────── LOGIN ───────── */
client.login(process.env.TOKEN);
