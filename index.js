/*****************************************************************************************
 * 🚀 PRO INVITE TRACKER — SUPABASE EDITION (FIXED)
 * Description fields added to fix Error 50035
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

// --- 1. KEEP ALIVE SERVER (Render Support) ---
http.createServer((req, res) => {
    res.writeHead(200);
    res.end("System Online");
}).listen(process.env.PORT || 3000);

// --- 2. SUPABASE CONNECTION ---
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// --- 3. DISCORD CLIENT ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.GuildMember]
});

const inviteCache = new Collection();

// --- 4. HELPER FUNCTIONS ---
function isAdmin(member) {
    return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// --- REWARD SYSTEM (Auto Role) ---
async function checkRewards(guild, inviterId) {
    const { data: stats } = await supabase
        .from("invite_stats")
        .select("*")
        .eq("guild_id", guild.id)
        .eq("inviter_id", inviterId)
        .maybeSingle();

    if (!stats) return;

    const { data: rewards } = await supabase
        .from("invite_rewards")
        .select("*")
        .eq("guild_id", guild.id);

    if (!rewards || rewards.length === 0) return;

    const member = await guild.members.fetch(inviterId).catch(() => null);
    if (!member) return;

    for (const reward of rewards) {
        if (stats.real_invites >= reward.invites_required) {
            const { data: already } = await supabase
                .from("reward_logs")
                .select("*")
                .eq("guild_id", guild.id)
                .eq("user_id", inviterId)
                .eq("invites_required", reward.invites_required)
                .maybeSingle();

            if (already) continue;

            if (reward.reward_type === "role") {
                const role = guild.roles.cache.get(reward.role_id);
                if (role) {
                    await member.roles.add(role).catch(e => console.log("Role Error:", e));
                    console.log(`🎉 Reward: Gave ${role.name} to ${member.user.tag}`);
                }
            }

            await supabase.from("reward_logs").insert({
                guild_id: guild.id,
                user_id: inviterId,
                invites_required: reward.invites_required
            });
        }
    }
}

// --- 5. EVENTS ---

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    // --- REGISTER SLASH COMMANDS (FIXED DESCRIPTIONS) ---
    const commands = [
        {
            name: "config",
            description: "Admin Configuration",
            options: [
                {
                    name: "setchannel",
                    description: "Set Welcome Channel",
                    type: 1, // Subcommand
                    options: [
                        // FIX: Description added here
                        { name: "channel", type: 7, required: true, description: "Select the welcome channel" }
                    ]
                },
                {
                    name: "addreward",
                    description: "Add Invite Reward Role",
                    type: 1,
                    options: [
                        { name: "invites", type: 4, required: true, description: "Number of invites required" },
                        { name: "role", type: 8, required: true, description: "Role to give" }
                    ]
                }
            ]
        },
        {
            name: "invites",
            description: "Check your or someone's invites",
            options: [
                // FIX: Description added here
                { name: "user", type: 6, required: false, description: "Select user to check" }
            ]
        },
        {
            name: "leaderboard",
            description: "View Top 10 Inviters"
        }
    ];

    await client.application.commands.set(commands);
    console.log("⚡ Slash commands deployed!");

    // --- CACHE SYNC ---
    for (const guild of client.guilds.cache.values()) {
        try {
            const invites = await guild.invites.fetch();
            inviteCache.set(guild.id, new Collection(invites.map(i => [i.code, i.uses])));
            console.log(`📥 ${guild.name}: Invites Synced`);
        } catch (e) {
            console.log(`❌ Missing Permissions in: ${guild.name}`);
        }
    }
});

// --- MEMBER JOIN ---
client.on("guildMemberAdd", async member => {
    const newInvites = await member.guild.invites.fetch();
    const oldInvites = inviteCache.get(member.guild.id);
    const usedInvite = newInvites.find(i => i.uses > (oldInvites.get(i.code) || 0));

    inviteCache.set(member.guild.id, new Collection(newInvites.map(i => [i.code, i.uses])));

    let inviterId = null;
    let code = "Unknown";

    if (usedInvite) {
        inviterId = usedInvite.inviter?.id;
        code = usedInvite.code;
    }

    if (inviterId) {
        await supabase.from("joins").insert({
            guild_id: member.guild.id,
            user_id: member.id,
            inviter_id: inviterId,
            code: code
        });

        const { data: existing } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", inviterId).maybeSingle();
        
        const currentReal = (existing?.real_invites || 0) + 1;
        const currentTotal = (existing?.total_invites || 0) + 1;

        await supabase.from("invite_stats").upsert({
            guild_id: member.guild.id,
            inviter_id: inviterId,
            total_invites: currentTotal,
            real_invites: currentReal
        });

        await checkRewards(member.guild, inviterId);
    }

    const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
    
    if (config?.welcome_channel) {
        const channel = member.guild.channels.cache.get(config.welcome_channel);
        if (channel) {
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('📥 New Member Joined')
                .setDescription(`Welcome ${member}!`)
                .addFields(
                    { name: 'Discord User', value: `${member} (\`${member.id}\`)`, inline: false },
                    { name: 'Invited By', value: inviterId ? `<@${inviterId}>` : "Unknown", inline: false },
                    { name: 'Invite Code', value: `\`${code}\``, inline: true },
                    { name: 'Member Count', value: `#${member.guild.memberCount}`, inline: true }
                )
                .setThumbnail(member.user.displayAvatarURL())
                .setTimestamp();
            
            channel.send({ embeds: [embed] });
        }
    }
});

// --- MEMBER LEAVE ---
client.on("guildMemberRemove", async member => {
    const { data: join } = await supabase
        .from("joins")
        .select("*")
        .eq("guild_id", member.guild.id)
        .eq("user_id", member.id)
        .maybeSingle();

    if (join && join.inviter_id) {
        const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id).maybeSingle();
        
        if (stats) {
            await supabase.from("invite_stats").update({
                real_invites: stats.real_invites - 1,
                leaves: stats.leaves + 1
            }).eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id);
        }
    }
});

// --- INTERACTIONS ---
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "config") {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        
        const sub = interaction.options.getSubcommand();

        if (sub === "setchannel") {
            const ch = interaction.options.getChannel("channel");
            await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, welcome_channel: ch.id });
            return interaction.reply(`✅ Welcome channel set to ${ch}`);
        }

        if (sub === "addreward") {
            const invites = interaction.options.getInteger("invites");
            const role = interaction.options.getRole("role");
            
            await supabase.from("invite_rewards").insert({
                guild_id: interaction.guild.id,
                invites_required: invites,
                role_id: role.id
            });
            return interaction.reply(`✅ Reward Added: **${invites} Invites** -> ${role}`);
        }
    }

    if (interaction.commandName === "invites") {
        const user = interaction.options.getUser("user") || interaction.user;

        const { data } = await supabase
            .from("invite_stats")
            .select("*")
            .eq("guild_id", interaction.guild.id)
            .eq("inviter_id", user.id)
            .maybeSingle();

        const embed = new EmbedBuilder()
            .setColor('#2b2d31')
            .setAuthor({ name: `Invites: ${user.username}`, iconURL: user.displayAvatarURL() })
            .addFields(
                { name: 'Total Joins', value: `${data?.total_invites || 0}`, inline: true },
                { name: 'Leaves', value: `${data?.leaves || 0}`, inline: true },
                { name: '✅ Real Invites', value: `**${data?.real_invites || 0}**`, inline: true }
            );

        return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === "leaderboard") {
        const { data } = await supabase
            .from("invite_stats")
            .select("*")
            .eq("guild_id", interaction.guild.id)
            .order("real_invites", { ascending: false })
            .limit(10);

        const lbString = data && data.length > 0 
            ? data.map((u, i) => `**#${i + 1}** <@${u.inviter_id}> : **${u.real_invites}**`).join("\n")
            : "No data yet.";

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🏆 Invite Leaderboard')
            .setDescription(lbString);

        return interaction.reply({ embeds: [embed] });
    }
});

client.on('inviteCreate', (invite) => {
    const invites = inviteCache.get(invite.guild.id);
    if (invites) invites.set(invite.code, invite.uses);
});
client.on('inviteDelete', (invite) => {
    const invites = inviteCache.get(invite.guild.id);
    if (invites) invites.delete(invite.code);
});

client.login(process.env.TOKEN);

