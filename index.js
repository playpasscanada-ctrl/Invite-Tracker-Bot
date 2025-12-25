/*****************************************************************************************
 * 🚀 PRO INVITE TRACKER — ULTIMATE EDITION
 * WhoInvited + Pro Stats + Custom Default Message
 *****************************************************************************************/

const {
    Client,
    GatewayIntentBits,
    Partials,
    PermissionsBitField,
    Collection,
    EmbedBuilder,
    ActionRowBuilder,
    UserSelectMenuBuilder
} = require("discord.js");
  
const { createClient } = require("@supabase/supabase-js");
const http = require("http");
const https = require("https");

// --- 1. KEEP ALIVE (24/7) ---
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

// --- 4. DEFAULT MESSAGE (Tumhara Wala) ---
const DEFAULT_TITLE = "Swagat hai {user}!";
const DEFAULT_DESC = `You are member **#{count}**! Invited by {inviter}.\n
📜 **Read Rules:** <#1440014653273931787>
📜 **Get Script:** <#1440567887965192254>

💬 **Chat in server** to gain **Level 5** and unlock additional features in script!

💰 **Earn Money:** Go to <#1444069380525789336> and use bot commands to earn money and get **extra verification hours**.

✅ **Verify Access:** Paste your Roblox ID in <#1451973498200133786> to access the script.`;

// --- HELPER: FORMAT MESSAGE ---
function formatMessage(text, member, inviterId, code) {
    if (!text) return "";
    return text
        .replace(/{user}/g, `${member}`)
        .replace(/{username}/g, member.user.username)
        .replace(/{inviter}/g, inviterId ? `<@${inviterId}>` : "**Unknown**")
        .replace(/{code}/g, code || "N/A")
        .replace(/{count}/g, member.guild.memberCount);
}

function isAdmin(member) {
    return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// --- 5. EVENTS ---
client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    // SLASH COMMANDS
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
                        { name: "title", type: 3, required: true, description: "Title ({user}, {count})" },
                        { name: "description", type: 3, required: true, description: "Body ({user}, {inviter}, {count})" }
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
            description: "Admin: Fix missing invite data",
        },
        {
            name: "whoinvited",
            description: "Check who invited a specific user",
            options: [{ name: "user", type: 6, required: true, description: "Select the user" }]
        },
        {
            name: "invites",
            description: "Check detailed invite stats",
            options: [{ name: "user", type: 6, required: false, description: "User to check" }]
        },
        {
            name: "leaderboard",
            description: "Top 10 Inviters"
        }
    ];

    await client.application.commands.set(commands);
    console.log("⚡ Slash commands deployed!");

    // CACHE SYNC
    for (const guild of client.guilds.cache.values()) {
        try {
            const invites = await guild.invites.fetch();
            inviteCache.set(guild.id, new Collection(invites.map(i => [i.code, i.uses])));
        } catch (e) { console.log(`❌ No perms: ${guild.name}`); }
    }
});

// --- MEMBER JOIN ---
client.on("guildMemberAdd", async member => {
    const newInvites = await member.guild.invites.fetch();
    const oldInvites = inviteCache.get(member.guild.id);
    const usedInvite = newInvites.find(i => i.uses > (oldInvites.get(i.code) || 0));
    inviteCache.set(member.guild.id, new Collection(newInvites.map(i => [i.code, i.uses])));

    let inviterId = null; let code = "Unknown";
    if (usedInvite) { inviterId = usedInvite.inviter?.id; code = usedInvite.code; }

    // Save to DB
    if (inviterId) {
        await supabase.from("joins").insert({ guild_id: member.guild.id, user_id: member.id, inviter_id: inviterId, code: code });
        
        const { data: existing } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", inviterId).maybeSingle();
        const currentReal = (existing?.real_invites || 0) + 1;
        const currentTotal = (existing?.total_invites || 0) + 1;

        await supabase.from("invite_stats").upsert({
            guild_id: member.guild.id, inviter_id: inviterId,
            total_invites: currentTotal, real_invites: currentReal,
            fake_invites: existing?.fake_invites || 0, leaves: existing?.leaves || 0
        });

        // Check Rewards
        await checkRewards(member.guild, inviterId);
    }

    // Welcome Message
    const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
    
    if (config?.welcome_channel) {
        const channel = member.guild.channels.cache.get(config.welcome_channel);
        if (channel) {
            // Use Custom or Fallback to DEFAULT_DESC (Tumhara text)
            const titleRaw = config.welcome_title || DEFAULT_TITLE;
            const descRaw = config.welcome_desc || DEFAULT_DESC;

            const title = formatMessage(titleRaw, member, inviterId, code);
            const desc = formatMessage(descRaw, member, inviterId, code);

            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle(title)
                .setDescription(desc)
                .setThumbnail(member.user.displayAvatarURL())
                .setFooter({ text: `Member #${member.guild.memberCount}` })
                .setTimestamp();
            
            channel.send({ embeds: [embed] });
        }
    }
});

// --- MEMBER LEAVE ---
client.on("guildMemberRemove", async member => {
    const { data: join } = await supabase.from("joins").select("*").eq("guild_id", member.guild.id).eq("user_id", member.id).maybeSingle();
    if (join && join.inviter_id) {
        const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id).maybeSingle();
        if (stats) {
            await supabase.from("invite_stats").update({
                real_invites: (stats.real_invites || 1) - 1,
                leaves: (stats.leaves || 0) + 1
            }).eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id);
        }
    }
});

// --- INTERACTIONS ---
client.on("interactionCreate", async interaction => {
    // SYNC SELECT MENU
    if (interaction.isUserSelectMenu() && interaction.customId === 'sync_select_inviter') {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        const selectedInviterId = interaction.values[0];
        const targetUserId = interaction.message.embeds[0].footer.text.replace("TargetID: ", "");
        
        await interaction.deferUpdate();
        await supabase.from("joins").insert({ guild_id: interaction.guild.id, user_id: targetUserId, inviter_id: selectedInviterId, code: "manual" });
        
        const { data: existing } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", selectedInviterId).maybeSingle();
        await supabase.from("invite_stats").upsert({
            guild_id: interaction.guild.id, inviter_id: selectedInviterId,
            total_invites: (existing?.total_invites || 0) + 1,
            real_invites: (existing?.real_invites || 0) + 1
        });
        await checkNextMissingUser(interaction);
    }

    if (!interaction.isChatInputCommand()) return;

    // --- WHO INVITED COMMAND ---
    if (interaction.commandName === "whoinvited") {
        const target = interaction.options.getUser("user");
        
        const { data: joinData } = await supabase
            .from("joins")
            .select("*")
            .eq("guild_id", interaction.guild.id)
            .eq("user_id", target.id)
            .maybeSingle();

        if (!joinData) {
            return interaction.reply({ content: `❌ **${target.username}** ka invite record database me nahi hai. (Shayad bot se pehle join kiya ho).`, ephemeral: true });
        }

        const inviterId = joinData.inviter_id;
        const code = joinData.code;
        const joinDate = `<t:${Math.floor(new Date(joinData.joined_at).getTime() / 1000)}:F>`; // Timestamp

        const embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setAuthor({ name: `Invite Detail: ${target.username}`, iconURL: target.displayAvatarURL() })
            .addFields(
                { name: '👤 Invited By', value: `<@${inviterId}>`, inline: true },
                { name: '🎟️ Code', value: `\`${code}\``, inline: true },
                { name: '📅 Joined At', value: joinDate, inline: false }
            );

        return interaction.reply({ embeds: [embed] });
    }

    // --- INVITES COMMAND (PRO STYLE) ---
    if (interaction.commandName === "invites") {
        const user = interaction.options.getUser("user") || interaction.user;
        const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", user.id).maybeSingle();

        const real = data?.real_invites || 0;
        const total = data?.total_invites || 0;
        const fake = data?.fake_invites || 0;
        const leaves = data?.leaves || 0;

        const embed = new EmbedBuilder()
            .setColor('#2b2d31')
            .setAuthor({ name: `${user.username}'s Invites`, iconURL: user.displayAvatarURL() })
            .setDescription(`**Total Real Invites: ${real}**`)
            .addFields(
                { name: '✅ Real', value: `${real}`, inline: true },
                { name: '❌ Fake', value: `${fake}`, inline: true },
                { name: '🚪 Left', value: `${leaves}`, inline: true },
                { name: '📊 Total', value: `${total}`, inline: true }
            )
            .setFooter({ text: 'Real = Total - Fake - Leaves' });
        
        return interaction.reply({ embeds: [embed] });
    }

    // --- SYNC MISSING ---
    if (interaction.commandName === "syncmissing") {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        await interaction.reply({ content: "🔎 Searching...", ephemeral: true });
        await checkNextMissingUser(interaction);
    }

    // --- CONFIG COMMANDS ---
    if (interaction.commandName === "config") {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        const sub = interaction.options.getSubcommand();

        if (sub === "setchannel") {
            const ch = interaction.options.getChannel("channel");
            await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, welcome_channel: ch.id });
            return interaction.reply(`✅ Welcome channel set to ${ch}`);
        }
        if (sub === "setmessage") {
            const title = interaction.options.getString("title");
            const desc = interaction.options.getString("description");
            const { data: existing } = await supabase.from("guild_config").select("welcome_channel").eq("guild_id", interaction.guild.id).maybeSingle();
            await supabase.from("guild_config").upsert({ 
                guild_id: interaction.guild.id, 
                welcome_channel: existing?.welcome_channel, 
                welcome_title: title, 
                welcome_desc: desc 
            });
            return interaction.reply(`✅ **Message Updated!** Use \`{count}\` for member number.`);
        }
        if (sub === "addreward") {
            const invites = interaction.options.getInteger("invites");
            const role = interaction.options.getRole("role");
            await supabase.from("invite_rewards").insert({ guild_id: interaction.guild.id, invites_required: invites, role_id: role.id });
            return interaction.reply(`✅ Reward Added: **${invites}** -> ${role}`);
        }
    }

    // --- LEADERBOARD ---
    if (interaction.commandName === "leaderboard") {
        const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).order("real_invites", { ascending: false }).limit(10);
        const lb = data?.map((u, i) => `**#${i + 1}** <@${u.inviter_id}> : **${u.real_invites}**`).join("\n") || "No data.";
        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Leaderboard').setDescription(lb)] });
    }
});

// --- HELPER: SYNC ---
async function checkNextMissingUser(interactionOrMessage) {
    const guild = interactionOrMessage.guild;
    const members = await guild.members.fetch();
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", guild.id);
    const recordedIds = new Set(joins?.map(j => j.user_id));
    const missingMember = members.find(m => !m.user.bot && !recordedIds.has(m.id));

    if (!missingMember) {
        const embed = new EmbedBuilder().setColor('#00FF00').setTitle('✅ All Synced!').setDescription("All members recorded.");
        if (interactionOrMessage.editReply) return interactionOrMessage.editReply({ content: null, embeds: [embed], components: [] });
        return interactionOrMessage.channel.send({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('⚠️ Missing Invite Data')
        .setDescription(`**User:** ${missingMember} (${missingMember.user.tag})\nSelect who invited them:`)
        .setFooter({ text: `TargetID: ${missingMember.id}` }); 

    const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('sync_select_inviter').setPlaceholder('Select Inviter...').setMaxValues(1));
    
    if (interactionOrMessage.editReply) await interactionOrMessage.editReply({ content: null, embeds: [embed], components: [row] });
    else await interactionOrMessage.update({ content: null, embeds: [embed], components: [row] });
}

// --- HELPER: REWARDS ---
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

// EVENTS
client.on('inviteCreate', (invite) => {
    const invites = inviteCache.get(invite.guild.id);
    if (invites) invites.set(invite.code, invite.uses);
});
client.on('inviteDelete', (invite) => {
    const invites = inviteCache.get(invite.guild.id);
    if (invites) invites.delete(invite.code);
});

client.login(process.env.TOKEN);

