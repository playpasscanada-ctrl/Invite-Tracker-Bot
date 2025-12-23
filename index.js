const { Client, GatewayIntentBits, Collection, EmbedBuilder } = require('discord.js');
const http = require('http'); // 1. Ye line add ki

// --- RENDER PORT FIX (Fake Web Server) ---
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is alive!');
});
server.listen(process.env.PORT || 3000); // Render ka port sunega
// ------------------------------------------

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.MessageContent
    ]
});

// --- SETTINGS ---
const CONFIG = {
    TOKEN: process.env.TOKEN, 
    WELCOME_CHANNEL: "1440722692243198072", // Tumhari ID 1 (Check kar lena ye channel ID hai na?)
    RULES_CHANNEL: "1440017250345291918",   // Tumhari ID 2
    PREFIX: "!",
    ADMIN_ROLES: ["1440722692243198072", "1440017250345291918"] 
};

const inviteCache = new Collection();

// --- 1. Bot Start ---
client.on('ready', async () => {
    console.log(`✅ ${client.user.tag} is online & tracking invites!`);

    for (const [guildId, guild] of client.guilds.cache) {
        try {
            const currentInvites = await guild.invites.fetch();
            inviteCache.set(guildId, new Collection(currentInvites.map(invite => [invite.code, invite.uses])));
            console.log(`📥 ${guild.name}: Invites synced (Data Safe).`);
        } catch (err) {
            console.log(`❌ Error fetching invites for ${guild.name}`);
        }
    }
});

// --- 2. Welcome Logic ---
client.on('guildMemberAdd', async (member) => {
    const channel = member.guild.channels.cache.get(CONFIG.WELCOME_CHANNEL);
    
    const newInvites = await member.guild.invites.fetch();
    const oldInvites = inviteCache.get(member.guild.id);
    
    const invite = newInvites.find(i => i.uses > (oldInvites.get(i.code) || 0));

    let inviterMention = "Unknown";
    let inviteCode = "N/A";

    if (invite) {
        inviterMention = `<@${invite.inviter.id}>`;
        inviteCode = invite.code;
    }

    const memberCount = member.guild.memberCount;

    const welcomeEmbed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('📥 New Member Joined')
        .setDescription(`Swagat hai ${member}! Please read rules in <#${CONFIG.RULES_CHANNEL}>.`)
        .addFields(
            { name: 'Discord User', value: `${member} (\`${member.id}\`)`, inline: false },
            { name: 'Invited By', value: `${inviterMention}`, inline: false },
            { name: 'Invite Code', value: `\`${inviteCode}\``, inline: true },
            { name: 'Member Count', value: `#${memberCount}`, inline: true }
        )
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp();

    if (channel) {
        channel.send({ embeds: [welcomeEmbed] });
    }

    inviteCache.set(member.guild.id, new Collection(newInvites.map(i => [i.code, i.uses])));
});

// --- 3. Cache Updates ---
client.on('inviteCreate', (invite) => {
    const invites = inviteCache.get(invite.guild.id);
    if (invites) invites.set(invite.code, invite.uses);
});
client.on('inviteDelete', (invite) => {
    const invites = inviteCache.get(invite.guild.id);
    if (invites) invites.delete(invite.code);
});

// --- 4. Commands ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(CONFIG.PREFIX)) return;

    const args = message.content.slice(CONFIG.PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'invites' || command === 'myinvites') {
        const targetUser = message.mentions.users.first() || message.author;
        
        const invites = await message.guild.invites.fetch();
        const userInvites = invites.filter(i => i.inviter && i.inviter.id === targetUser.id);
        
        let totalUses = 0;
        userInvites.forEach(invite => totalUses += invite.uses);

        const inviteEmbed = new EmbedBuilder()
            .setColor('#2b2d31')
            .setAuthor({ name: 'Invitation Stats', iconURL: targetUser.displayAvatarURL() })
            .addFields(
                { name: 'User', value: `<@${targetUser.id}>`, inline: false },
                { name: 'Total Invites', value: `**${totalUses}**`, inline: false },
                { name: 'Active Codes', value: `${userInvites.size}`, inline: false }
            )
            .setFooter({ text: 'Data from Discord API' });

        return message.channel.send({ embeds: [inviteEmbed] });
    }

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

        const lbEmbed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🏆 Invitation Leaderboard')
            .setDescription(lbString)
            .setTimestamp();

        return message.channel.send({ embeds: [lbEmbed] });
    }
});

client.login(CONFIG.TOKEN);

