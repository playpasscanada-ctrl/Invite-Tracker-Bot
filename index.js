/*****************************************************************************************
 * 🚀 PRO INVITE TRACKER — FIXED EDITION
 * Fixes: Database Loop, Leaderboard, & "Left User" Button
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
    ButtonBuilder,
    ButtonStyle,
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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.GuildMember, Partials.Channel]
});

const inviteCache = new Collection();
const recentlySynced = new Set(); 

// --- 4. DEFAULTS ---
const DEFAULT_TITLE = "Swagat hai {user}!";
const DEFAULT_DESC = `You are member **#{count}**! Invited by {inviter}.\n
📜 **Read Rules:** <#1440014653273931787>
📜 **Get Script:** <#1440567887965192254>

💬 **Chat in server** to gain **Level 5** and unlock additional features in script!

💰 **Earn Money:** Go to <#1444069380525789336> and use bot commands to earn money and get **extra verification hours**.

✅ **Verify Access:** Paste your Roblox ID in <#1451973498200133786> to access the script.`;

function formatMessage(text, member, inviterId, code) {
    if (!text) return "";
    return text
        .replace(/{user}/g, `${member}`)
        .replace(/{username}/g, member.user.username)
        .replace(/{inviter}/g, (inviterId && inviterId !== 'left_user') ? `<@${inviterId}>` : "**Someone (Left)**")
        .replace(/{code}/g, code || "N/A")
        .replace(/{count}/g, member.guild.memberCount);
}

function isAdmin(member) {
    return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// --- 5. EVENTS ---
client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    const commands = [
        {
            name: "config",
            description: "Admin Configuration",
            options: [
                {
                    name: "setchannel",
                    description: "Set Welcome/Leave Channel",
                    type: 1, 
                    options: [{ name: "channel", type: 7, required: true, description: "Select channel" }]
                },
                {
                    name: "setmessage",
                    description: "Set Welcome Message",
                    type: 1,
                    options: [
                        { name: "title", type: 3, required: true, description: "Title" },
                        { name: "description", type: 3, required: true, description: "Body" }
                    ]
                },
                {
                    name: "addreward",
                    description: "Add Reward",
                    type: 1,
                    options: [
                        { name: "invites", type: 4, required: true, description: "Invites needed" },
                        { name: "role", type: 8, required: true, description: "Role" }
                    ]
                }
            ]
        },
        { name: "syncmissing", description: "Admin: Fix missing invite data" },
        { name: "whoinvited", description: "Check who invited a user", options: [{ name: "user", type: 6, required: true, description: "Select user" }] },
        { name: "invites", description: "Check detailed stats", options: [{ name: "user", type: 6, required: false, description: "Select user" }] },
        { name: "leaderboard", description: "Top 10 Inviters" }
    ];

    await client.application.commands.set(commands);
    console.log("⚡ Slash commands deployed!");

    // Cache Sync (Without Loop Crash)
    for (const guild of client.guilds.cache.values()) {
        try {
            const invites = await guild.invites.fetch();
            inviteCache.set(guild.id, new Collection(invites.map(i => [i.code, i.uses])));
            // Initial member fetch done quietly
            guild.members.fetch().catch(() => {});
        } catch (e) { console.log(`❌ No perms: ${guild.name}`); }
    }
});

// --- MEMBER JOIN ---
client.on("guildMemberAdd", async member => {
    const newInvites = await member.guild.invites.fetch().catch(() => new Collection());
    const oldInvites = inviteCache.get(member.guild.id);
    const usedInvite = newInvites.find(i => i.uses > (oldInvites?.get(i.code) || 0));
    inviteCache.set(member.guild.id, new Collection(newInvites.map(i => [i.code, i.uses])));

    let inviterId = null; let code = "Unknown";
    if (usedInvite) { inviterId = usedInvite.inviter?.id; code = usedInvite.code; }

    if (inviterId) {
        await supabase.from("joins").insert({ guild_id: member.guild.id, user_id: member.id, inviter_id: inviterId, code: code });
        const { data: existing } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", inviterId).maybeSingle();
        await supabase.from("invite_stats").upsert({
            guild_id: member.guild.id, inviter_id: inviterId,
            total_invites: (existing?.total_invites || 0) + 1, real_invites: (existing?.real_invites || 0) + 1,
            fake_invites: existing?.fake_invites || 0, leaves: existing?.leaves || 0
        });
        await checkRewards(member.guild, inviterId);
    }

    // Welcome & DM
    const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
    
    if (config?.welcome_channel) {
        const channel = member.guild.channels.cache.get(config.welcome_channel);
        if (channel) {
            const title = formatMessage(config.welcome_title || DEFAULT_TITLE, member, inviterId, code);
            const desc = formatMessage(config.welcome_desc || DEFAULT_DESC, member, inviterId, code);
            const embed = new EmbedBuilder().setColor('#0099ff').setTitle(title).setDescription(desc)
                .setThumbnail(member.user.displayAvatarURL()).setFooter({ text: `Member #${member.guild.memberCount}` }).setTimestamp();
            channel.send({ embeds: [embed] });
        }
    }
    try {
        const dmEmbed = new EmbedBuilder().setColor('#FF00FF').setTitle(`Welcome to ${member.guild.name}! 🚀`)
            .setDescription(`Hello **${member.user.username}**!\nCheck <#1440014653273931787> for rules!`).setFooter({ text: "Happy Gaming!" });
        await member.send({ embeds: [dmEmbed] });
    } catch (e) {}
});

// --- MEMBER LEAVE ---
client.on("guildMemberRemove", async member => {
    const { data: join } = await supabase.from("joins").select("*").eq("guild_id", member.guild.id).eq("user_id", member.id).maybeSingle();
    if (join && join.inviter_id && join.inviter_id !== 'left_user') {
        const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id).maybeSingle();
        if (stats) {
            await supabase.from("invite_stats").update({
                real_invites: (stats.real_invites || 1) - 1, leaves: (stats.leaves || 0) + 1
            }).eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id);
        }
    }
    // Leave Msg
    const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
    if (config?.welcome_channel) {
        const channel = member.guild.channels.cache.get(config.welcome_channel);
        if (channel) channel.send({ embeds: [new EmbedBuilder().setColor('#FF0000').setTitle('👋 Goodbye!').setDescription(`**${member.user.tag}** left.`).setFooter({ text: `Members: ${member.guild.memberCount}` })] });
    }
});

// --- INTERACTIONS ---
client.on("interactionCreate", async interaction => {
    
    // --- 1. SYNC SELECT MENU (For Members) ---
    if (interaction.isUserSelectMenu() && interaction.customId === 'sync_select_inviter') {
        await handleSyncResponse(interaction, interaction.values[0]);
    }

    // --- 2. SYNC BUTTON (For Left Users) ---
    if (interaction.isButton() && interaction.customId === 'sync_user_left') {
        await handleSyncResponse(interaction, 'left_user');
    }

    if (!interaction.isChatInputCommand()) return;

    // --- COMMANDS ---
    if (interaction.commandName === "whoinvited") {
        const target = interaction.options.getUser("user");
        const { data: joinData } = await supabase.from("joins").select("*").eq("guild_id", interaction.guild.id).eq("user_id", target.id).maybeSingle();
        if (!joinData) return interaction.reply({ content: `❌ No record.`, ephemeral: true });
        
        const inviterText = joinData.inviter_id === 'left_user' ? "Someone (Left Server)" : `<@${joinData.inviter_id}>`;
        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFA500').addFields({ name: 'Invited By', value: inviterText }, { name: 'Code', value: `\`${joinData.code}\`` })] });
    }

    if (interaction.commandName === "invites") {
        const user = interaction.options.getUser("user") || interaction.user;
        const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", user.id).maybeSingle();
        const real = data?.real_invites || 0;
        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#2b2d31').addFields({ name: '✅ Real', value: `${real}`, inline: true }, { name: '📊 Total', value: `${data?.total_invites || 0}`, inline: true }, { name: '❌ Fake', value: `${data?.fake_invites || 0}`, inline: true })] });
    }

    if (interaction.commandName === "syncmissing") {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        recentlySynced.clear(); 
        await interaction.reply({ content: "🔎 Searching...", ephemeral: true });
        if (interaction.guild.memberCount > interaction.guild.members.cache.size) await interaction.guild.members.fetch(); 
        await checkNextMissingUser(interaction);
    }

    if (interaction.commandName === "leaderboard") {
        const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).order("real_invites", { ascending: false }).limit(10);
        const lb = data?.map((u, i) => `**#${i + 1}** <@${u.inviter_id}>: ${u.real_invites}`).join("\n") || "No data.";
        return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Leaderboard').setDescription(lb)] });
    }
    
    // Config commands same as before...
    if (interaction.commandName === "config") {
        if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === "setchannel") {
            const ch = interaction.options.getChannel("channel");
            await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, welcome_channel: ch.id });
            return interaction.reply(`✅ Channel set.`);
        }
        if (sub === "setmessage") {
            const title = interaction.options.getString("title"); const desc = interaction.options.getString("description");
            const { data: existing } = await supabase.from("guild_config").select("welcome_channel").eq("guild_id", interaction.guild.id).maybeSingle();
            await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, welcome_channel: existing?.welcome_channel, welcome_title: title, welcome_desc: desc });
            return interaction.reply(`✅ Message Updated!`);
        }
        if (sub === "addreward") {
            const invites = interaction.options.getInteger("invites"); const role = interaction.options.getRole("role");
            await supabase.from("invite_rewards").insert({ guild_id: interaction.guild.id, invites_required: invites, role_id: role.id });
            return interaction.reply(`✅ Reward Added.`);
        }
    }
});

// --- HELPER: HANDLE SYNC RESPONSE ---
async function handleSyncResponse(interaction, inviterId) {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
    
    // ID of the user we are syncing (from Embed Footer)
    const targetUserId = interaction.message.embeds[0].footer.text.replace("TargetID: ", "");
    recentlySynced.add(targetUserId); // Mark done locally

    await interaction.deferUpdate();

    // 1. Save Join Record
    const { error } = await supabase.from("joins").upsert({ 
        guild_id: interaction.guild.id, 
        user_id: targetUserId, 
        inviter_id: inviterId, 
        code: "manual" 
    });

    if (error) console.log("DB Write Error (Check RLS):", error.message);

    // 2. Update Stats (Only if not a 'Left User')
    if (inviterId !== 'left_user') {
        const { data: existing } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", inviterId).maybeSingle();
        await supabase.from("invite_stats").upsert({
            guild_id: interaction.guild.id, inviter_id: inviterId,
            total_invites: (existing?.total_invites || 0) + 1, real_invites: (existing?.real_invites || 0) + 1
        });
    }

    // 3. Next
    await checkNextMissingUser(interaction);
}

// --- HELPER: CHECK NEXT USER ---
async function checkNextMissingUser(interactionOrMessage) {
    const guild = interactionOrMessage.guild;
    const members = guild.members.cache; 
    
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", guild.id);
    const recordedIds = new Set(joins?.map(j => j.user_id));
    
    // Find someone NOT in DB and NOT just synced
    const missingMember = members.find(m => !m.user.bot && !recordedIds.has(m.id) && !recentlySynced.has(m.id));

    if (!missingMember) {
        const embed = new EmbedBuilder().setColor('#00FF00').setTitle('✅ Sync Complete!').setDescription("All members synced.");
        if (interactionOrMessage.editReply) return interactionOrMessage.editReply({ content: null, embeds: [embed], components: [] });
        return interactionOrMessage.channel.send({ embeds: [embed] });
    }

    const embed = new EmbedBuilder().setColor('#FFA500').setTitle('⚠️ Missing Data').setDescription(`**User:** ${missingMember} (${missingMember.user.tag})\nWho invited them?`).setFooter({ text: `TargetID: ${missingMember.id}` }); 
    
    const row1 = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('sync_select_inviter').setPlaceholder('Select Inviter (Current Member)...').setMaxValues(1));
    const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sync_user_left').setLabel('Inviter Left Server / Unknown').setStyle(ButtonStyle.Secondary).setEmoji('🚪'));

    if (interactionOrMessage.editReply) await interactionOrMessage.editReply({ content: null, embeds: [embed], components: [row1, row2] });
    else await interactionOrMessage.update({ content: null, embeds: [embed], components: [row1, row2] });
}

async function checkRewards(guild, inviterId) {
    if (inviterId === 'left_user') return;
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

process.on('unhandledRejection', (r) => console.log('Err:', r));
client.login(process.env.TOKEN);

