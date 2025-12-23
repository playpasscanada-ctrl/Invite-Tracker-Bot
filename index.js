const { Client, GatewayIntentBits, Collection, EmbedBuilder, PermissionsBitField } = require('discord.js');
const http = require('http');

// --- RENDER KEEP-ALIVE ---
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is working!');
});
server.listen(process.env.PORT || 3000);

// --- BOT CLIENT ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.MessageContent
    ]
});

// --- SETTINGS (DATA STORE) ---
// Yahan hum variables bana rahe hain jo tum command se set karoge
let CONFIG = {
    TOKEN: process.env.TOKEN, 
    PREFIX: "!",
    // Ye rahi tumhari ADMIN ROLE IDs (Ab sahi jagah hain)
    ADMIN_ROLES: ["1440722692243198072", "1440017250345291918"],
    
    // Ye abhi empty hain, tum command se set karoge
    WELCOME_CHANNEL: null, 
    RULES_CHANNEL: null    
};

const inviteCache = new Collection();

// --- 1. READY EVENT ---
client.on('ready', async () => {
    console.log(`✅ ${client.user.tag} online hai!`);
    
    // Current Invites Save karo
    for (const [guildId, guild] of client.guilds.cache) {
        try {
            const currentInvites = await guild.invites.fetch();
            inviteCache.set(guildId, new Collection(currentInvites.map(invite => [invite.code, invite.uses])));
            console.log(`📥 ${guild.name}: Invites tracked.`);
        } catch (err) {
            console.log(`❌ Error: ${guild.name} me invites fetch nahi huye.`);
        }
    }
});

// --- 2. MEMBER JOIN LOGIC ---
client.on('guildMemberAdd', async (member) => {
    // Agar Welcome Channel set nahi hai to kuch mat karo
    if (!CONFIG.WELCOME_CHANNEL) return;

    const channel = member.guild.channels.cache.get(CONFIG.WELCOME_CHANNEL);
    if (!channel) return;

    const newInvites = await member.guild.invites.fetch();
    const oldInvites = inviteCache.get(member.guild.id);
    const invite = newInvites.find(i => i.uses > (oldInvites.get(i.code) || 0));

    let inviterMention = "Unknown";
    let inviteCode = "N/A";

    if (invite) {
        inviterMention = `<@${invite.inviter.id}>`;
        inviteCode = invite.code;
    }

    // Rules Channel Mention Logic
    const rulesText = CONFIG.RULES_CHANNEL ? `<#${CONFIG.RULES_CHANNEL}>` : "Rules Channel";

    const welcomeEmbed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('📥 New Member Joined')
        .setDescription(`Swagat hai ${member}! Please read rules in ${rulesText}.`)
        .addFields(
            { name: 'Discord User', value: `${member} (\`${member.id}\`)`, inline: false },
            { name: 'Invited By', value: `${inviterMention}`, inline: false },
            { name: 'Invite Code', value: `\`${inviteCode}\``, inline: true },
            { name: 'Member Count', value: `#${member.guild.memberCount}`, inline: true }
        )
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp();

    channel.send({ embeds: [welcomeEmbed] });

    // Cache Update
    inviteCache.set(member.guild.id, new Collection(newInvites.map(i => [i.code, i.uses])));
});

// --- 3. INVITE TRACKING ---
client.on('inviteCreate', (invite) => {
    const invites = inviteCache.get(invite.guild.id);
    if (invites) invites.set(invite.code, invite.uses);
});
client.on('inviteDelete', (invite) => {
    const invites = inviteCache.get(invite.guild.id);
    if (invites) invites.delete(invite.code);
});

// --- 4. COMMANDS ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(CONFIG.PREFIX)) return;

    const args = message.content.slice(CONFIG.PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Helper: Check Admin Role
    const isAdmin = message.member.roles.cache.some(role => CONFIG.ADMIN_ROLES.includes(role.id)) || message.member.permissions.has(PermissionsBitField.Flags.Administrator);

    // --- COMMAND: SET WELCOME (Admin Only) ---
    if (command === 'setwelcome') {
        if (!isAdmin) return message.reply("❌ Sirf Admin/Owner ye kar sakte hain.");
        
        const channel = message.mentions.channels.first();
        if (!channel) return message.reply("❌ Kripya channel mention karein. Example: `!setwelcome #general`");

        CONFIG.WELCOME_CHANNEL = channel.id;

        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setDescription(`✅ **Welcome Channel Set!**\nAb se welcome messages ${channel} me aayenge.`);
        return message.channel.send({ embeds: [embed] });
    }

    // --- COMMAND: SET RULES (Admin Only) ---
    if (command === 'setrules') {
        if (!isAdmin) return message.reply("❌ Sirf Admin/Owner ye kar sakte hain.");

        const channel = message.mentions.channels.first();
        if (!channel) return message.reply("❌ Kripya channel mention karein. Example: `!setrules #rules`");

        CONFIG.RULES_CHANNEL = channel.id;

        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setDescription(`✅ **Rules Channel Set!**\nNew members ko ${channel} check karne ko bola jayega.`);
        return message.channel.send({ embeds: [embed] });
    }

    // --- COMMAND: INVITES ---
    if (command === 'invites' || command === 'myinvites') {
        const targetUser = message.mentions.users.first() || message.author;
        const invites = await message.guild.invites.fetch();
        const userInvites = invites.filter(i => i.inviter && i.inviter.id === targetUser.id);
        
        let totalUses = 0;
        userInvites.forEach(invite => totalUses += invite.uses);

        const embed = new EmbedBuilder()
            .setColor('#2b2d31')
            .setAuthor({ name: 'Invitation Stats', iconURL: targetUser.displayAvatarURL() })
            .addFields(
                { name: 'User', value: `<@${targetUser.id}>`, inline: false },
                { name: 'Total Invites', value: `**${totalUses}**`, inline: false },
                { name: 'Active Codes', value: `${userInvites.size}`, inline: false }
            )
            .setFooter({ text: 'Tracking active invites only' });
        return message.channel.send({ embeds: [embed] });
    }

    // --- COMMAND: LEADERBOARD ---
    if (command === 'leaderboard' || command === 'lb') {
        const invites = await message.guild.invites.fetch();
        const inviteCounter = {};

        invites.forEach(invite => {
            if (invite.inviter) {
                const id = invite.inviter.id;
                inviteCounter[id] = (inviteCounter[id] || 0) + invite.uses;
            }
        });

        const sortedInvites = Object.entries(inviteCounter)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10);

        let lbString = sortedInvites.map((entry, index) => {
            return `**#${index + 1}** <@${entry[0]}> : **${entry[1]} Invites**`;
        }).join('\n');

        if (!lbString) lbString = "No invites found yet.";

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🏆 Invitation Leaderboard')
            .setDescription(lbString)
            .setTimestamp();
        return message.channel.send({ embeds: [embed] });
    }
});

client.login(CONFIG.TOKEN);
