/*****************************************************************************************
 * 🚀 PRO INVITE TRACKER — RAPID SYNC EDITION
 * Auto-Ask for Missing Invites + Invitee List + DB Debug
 *****************************************************************************************/

const {
    Client,
    GatewayIntentBits,
    Partials,
    PermissionsBitField,
    Collection,
    EmbedBuilder,
    ActionRowBuilder,
    UserSelectMenuBuilder,
    StringSelectMenuBuilder,
    ComponentType
} = require("discord.js");
  
const { createClient } = require("@supabase/supabase-js");
const http = require("http");
const https = require("https");

// --- 1. KEEP ALIVE ---
http.createServer((req, res) => { res.writeHead(200); res.end("Bot Awake"); }).listen(process.env.PORT || 3000);
setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => console.log(`⏰ Ping: ${res.statusCode}`)).on('error', () => {});
}, 300000);

// --- 2. SUPABASE ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- 3. DISCORD CLIENT ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites, GatewayIntentBits.MessageContent],
    partials: [Partials.GuildMember]
});

const inviteCache = new Collection();

// --- HELPERS ---
function isAdmin(member) {
    return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// --- 4. EVENTS ---
client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    const commands = [
        {
            name: "config",
            description: "Admin Configuration",
            options: [
                {
                    name: "setchannel",
                    description: "Set Welcome Channel",
                    type: 1, 
                    options: [{ name: "channel", type: 7, required: true, description: "Select welcome channel" }]
                },
                {
                    name: "setmessage",
                    description: "Set Custom Welcome Message",
                    type: 1,
                    options: [
                        { name: "title", type: 3, required: true, description: "Title ({user}, {inviter})" },
                        { name: "description", type: 3, required: true, description: "Body ({user}, {inviter}, {code}, {count})" }
                    ]
                },
                {
                    name: "addreward",
                    description: "Add Invite Reward Role",
                    type: 1,
                    options: [
                        { name: "invites", type: 4, required: true, description: "Invites needed" },
                        { name: "role", type: 8, required: true, description: "Role to give" }
                    ]
                }
            ]
        },
        {
            name: "syncmissing",
            description: "Admin: Rapidly fix missing invite data manually",
        },
        {
            name: "invitelist",
            description: "See WHO a user invited (List of names)",
            options: [{ name: "user", type: 6, required: false, description: "Select user" }]
        },
        {
            name: "dbtables",
            description: "Admin: Show Supabase table structure (Debug)",
        },
        {
            name: "invites",
            description: "Check invites count",
            options: [{ name: "user", type: 6, required: false, description: "User to check" }]
        },
        {
            name: "leaderboard",
            description: "Top 10 Inviters"
        }
    ];

    await client.application.commands.set(commands);
    console.log("⚡ Slash commands deployed!");

    // Cache Sync
    for (const guild of client.guilds.cache.values()) {
        try {
            const invites = await guild.invites.fetch();
            inviteCache.set(guild.id, new Collection(invites.map(i => [i.code, i.uses])));
        } catch (e) { console.log(`❌ No perms: ${guild.name}`); }
    }
});

// --- MEMBER JOIN ---
client.on("guildMemberAdd", async member => {
    // (Same logic as before - keeping it short for this snippet)
    const newInvites = await member.guild.invites.fetch();
    const oldInvites = inviteCache.get(member.guild.id);
    const usedInvite = newInvites.find(i => i.uses > (oldInvites.get(i.code) || 0));
    inviteCache.set(member.guild.id, new Collection(newInvites.map(i => [i.code, i.uses])));

    let inviterId = null; let code = "Unknown";
    if (usedInvite) { inviterId = usedInvite.inviter?.id; code = usedInvite.code; }

    if (inviterId) {
        await supabase.from("joins").insert({ guild_id: member.guild.id, user_id: member.id, inviter_id: inviterId, code: code });
        const { data: existing } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", inviterId).maybeSingle();
        await supabase.from("invite_stats").upsert({
            guild_id: member.guild.id, inviter_id: inviterId,
            total_invites: (existing?.total_invites || 0) + 1,
            real_invites: (existing?.real_invites || 0) + 1
        });
        await checkRewards(member.guild, inviterId);
    }
    // Welcome Msg Logic (Shortened)
    const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
    if (config?.welcome_channel) {
        const channel = member.guild.channels.cache.get(config.welcome_channel);
        if (channel) {
            let title = (config.welcome_title || "📥 New Member").replace(/{user}/g, `${member}`).replace(/{inviter}/g, inviterId ? `<@${inviterId}>` : "Unknown");
            let desc = (config.welcome_desc || "Welcome {user}!").replace(/{user}/g, `${member}`).replace(/{inviter}/g, inviterId ? `<@${inviterId}>` : "Unknown").replace(/{count}/g, member.guild.memberCount);
            channel.send({ embeds: [new EmbedBuilder().setColor('#0099ff').setTitle(title).setDescription(desc).setThumbnail(member.user.displayAvatarURL())] });
        }
    }
});

// --- REWARDS LOGIC (Same as before) ---
async function checkRewards(guild, inviterId) {
    const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", guild.id).eq("inviter_id", inviterId).maybeSingle();
    if (!stats) return;
    const { data: rewards } = await supabase.from("invite_rewards").select("*").eq("guild_id", guild.id);
    if (!rewards) return;
    const member = await guild.members.fetch(inviterId).catch(() => null);
    if (!member) return;

    for (const reward of rewards) {
        if (stats.real_invites >= reward.invites_required) {
            const { data: already } = await supabase.from("reward_logs").select("*").eq("guild_id", guild.id).eq("user_id", inviterId).eq("invites_required", reward.invites_required).maybeSingle();
            if (already) continue;
            const role = guild.roles.cache.get(reward.role_id);
            if (role) await member.roles.add(role).catch(e => console.log(e));
            await supabase.from("reward_logs").insert({ guild_id: guild.id, user_id: inviterId, invites_required: reward.invites_required });
        }
    }
}

// --- INTERACTIONS ---
client.on("interactionCreate", async interaction => {
    // 1. SELECT MENU HANDLER (For Sync)
    if (interaction.isUserSelectMenu() && interaction.customId === 'sync_select_inviter') {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });

        const selectedInviterId = interaction.values[0];
        // The missing user's ID is stored in the message content or we can pass it differently. 
        // Hack: Let's extract it from the embed description or title.
        // Better: We will store it in the SelectMenu customID but that has length limits.
        // Let's use the Embed footer to store the Target User ID securely.
        
        const targetUserId = interaction.message.embeds[0].footer.text.replace("TargetID: ", "");
        const targetUser = await interaction.guild.members.fetch(targetUserId).catch(() => null);

        if (!targetUser) return interaction.reply("User left server.");

        await interaction.deferUpdate(); // Stop loading circle

        // Save to DB
        await supabase.from("joins").insert({ guild_id: interaction.guild.id, user_id: targetUserId, inviter_id: selectedInviterId, code: "manual" });
        
        // Update Stats
        const { data: existing } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", selectedInviterId).maybeSingle();
        await supabase.from("invite_stats").upsert({
            guild_id: interaction.guild.id, inviter_id: selectedInviterId,
            total_invites: (existing?.total_invites || 0) + 1,
            real_invites: (existing?.real_invites || 0) + 1
        });

        // Continue Syncing
        await checkNextMissingUser(interaction);
    }

    if (!interaction.isChatInputCommand()) return;

    // --- COMMAND: SYNC MISSING (RAPID FIRE) ---
    if (interaction.commandName === "syncmissing") {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        await interaction.reply({ content: "🔎 Searching for members with missing data...", ephemeral: true });
        await checkNextMissingUser(interaction);
    }

    // --- COMMAND: INVITE LIST (Who did they invite?) ---
    if (interaction.commandName === "invitelist") {
        const user = interaction.options.getUser("user") || interaction.user;
        await interaction.deferReply();

        const { data: joins } = await supabase.from("joins").select("user_id, joined_at").eq("guild_id", interaction.guild.id).eq("inviter_id", user.id);

        if (!joins || joins.length === 0) {
            return interaction.editReply(`❌ **${user.username}** has not invited anyone yet (or database is empty).`);
        }

        // List names
        const names = [];
        for (const j of joins) {
            names.push(`<@${j.user_id}> (<t:${Math.floor(new Date(j.joined_at).getTime() / 1000)}:R>)`);
        }

        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(`📜 Invited by ${user.username}`)
            .setDescription(names.slice(0, 20).join('\n') + (names.length > 20 ? `\n...and ${names.length - 20} more` : ""))
            .setFooter({ text: `Total: ${joins.length}` });

        return interaction.editReply({ embeds: [embed] });
    }

    // --- COMMAND: DB TABLES (Debug) ---
    if (interaction.commandName === "dbtables") {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        
        // Special SQL to list tables
        const { data, error } = await supabase.rpc('get_tables'); 
        // Note: RPC setup is complex, let's use a simpler method if possible or just guide user.
        // Actually, listing tables via JS client is hard without raw SQL permission.
        // Let's print the table names we KNOW we created.
        
        const tables = ["joins", "invite_stats", "guild_config", "invite_rewards", "reward_logs", "feature_flags"];
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('📂 Database Structure')
            .setDescription(`**Known Tables:**\n${tables.join('\n')}\n\n*Use Supabase Dashboard > Table Editor to see extra tables.*`);
        
        return interaction.reply({ embeds: [embed] });
    }

    // --- EXISTING COMMANDS ---
    if (interaction.commandName === "config") {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === "setchannel") {
            const ch = interaction.options.getChannel("channel");
            await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, welcome_channel: ch.id });
            return interaction.reply(`✅ Channel set: ${ch}`);
        }
        if (sub === "setmessage") {
            const title = interaction.options.getString("title");
            const desc = interaction.options.getString("description");
            const { data: existing } = await supabase.from("guild_config").select("welcome_channel").eq("guild_id", interaction.guild.id).maybeSingle();
            await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, welcome_channel: existing?.welcome_channel, welcome_title: title, welcome_desc: desc });
            return interaction.reply(`✅ Message Updated!`);
        }
        if (sub === "addreward") {
            const invites = interaction.options.getInteger("invites");
            const role = interaction.options.getRole("role");
            await supabase.from("invite_rewards").insert({ guild_id: interaction.guild.id, invites_required: invites, role_id: role.id });
            return interaction.reply(`✅ Reward Added: ${invites} -> ${role}`);
        }
    }

    if (interaction.commandName === "invites") {
        const user = interaction.options.getUser("user") || interaction.user;
        const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", user.id).maybeSingle();
        const embed = new EmbedBuilder().setColor('#2b2d31').addFields({ name: 'Real Invites', value: `**${data?.real_invites || 0}**` });
        return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === "leaderboard") {
        const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).order("real_invites", { ascending: false }).limit(10);
        const lb = data?.map((u, i) => `**#${i + 1}** <@${u.inviter_id}>: ${u.real_invites}`).join("\n") || "No data.";
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🏆 Leaderboard').setDescription(lb)] });
    }
});

// --- SYNC HELPER FUNCTION ---
async function checkNextMissingUser(interactionOrMessage) {
    const guild = interactionOrMessage.guild;
    const members = await guild.members.fetch();
    
    // 1. Get all recorded joins
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", guild.id);
    const recordedIds = new Set(joins?.map(j => j.user_id));

    // 2. Find first member NOT in DB
    const missingMember = members.find(m => !m.user.bot && !recordedIds.has(m.id));

    if (!missingMember) {
        // Sab sync ho gaye!
        const embed = new EmbedBuilder().setColor('#00FF00').setTitle('✅ Sync Complete!').setDescription("All current members are recorded in database.");
        if (interactionOrMessage.editReply) return interactionOrMessage.editReply({ content: null, embeds: [embed], components: [] });
        return interactionOrMessage.channel.send({ embeds: [embed] });
    }

    // 3. Ask Admin
    const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('⚠️ Missing Invite Data')
        .setDescription(`**User:** ${missingMember} (${missingMember.user.tag})\n\nSelect who invited this person from the menu below.`)
        .setFooter({ text: `TargetID: ${missingMember.id}` }); // ID stored here for next step

    const selectMenu = new UserSelectMenuBuilder()
        .setCustomId('sync_select_inviter')
        .setPlaceholder('Select the Inviter...')
        .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    if (interactionOrMessage.editReply) {
        await interactionOrMessage.editReply({ content: null, embeds: [embed], components: [row] });
    } else if (interactionOrMessage.update) {
        await interactionOrMessage.update({ content: null, embeds: [embed], components: [row] });
    } else {
        await interactionOrMessage.channel.send({ embeds: [embed], components: [row] });
    }
}

client.login(process.env.TOKEN);

