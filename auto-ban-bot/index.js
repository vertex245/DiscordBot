require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
const clientId = process.env.CLIENT_ID;
const requiredRoleId = process.env.REQUIRED_ROLE_ID;
const exemptRoleIds = (process.env.EXEMPT_ROLE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DRY_RUN = String(process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const SCAN_ON_READY = String(process.env.SCAN_ON_READY || 'false').toLowerCase() === 'true';

if (!token || !guildId || !requiredRoleId || !clientId) {
  console.error('❌ Missing environment variables. Check DISCORD_TOKEN, GUILD_ID, CLIENT_ID, REQUIRED_ROLE_ID.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.GuildMember]
});

// Helper: safe ban
async function safeBanMember(guild, member, reason = 'Matched target role only') {
  if (!member) return;
  if (member.user?.bot) return;
  if (member.id === guild.ownerId) return;

  // Member must have the target role
  if (!member.roles.cache.has(process.env.TARGET_ROLE_ID)) return;

  // Count roles excluding @everyone
  const rolesExcludingEveryone = member.roles.cache.filter(r => r.id !== guild.id);

  // If they have ONLY the target role (and nothing else), ban
  if (rolesExcludingEveryone.size !== 1) return;

  const me = await guild.members.fetchMe();
  const canBan =
    me.permissions.has(PermissionsBitField.Flags.BanMembers) &&
    me.roles.highest.position > member.roles.highest.position;

  if (!canBan) return;

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would ban ${member.user.tag} (${member.id}) for: ${reason}`);
  } else {
    try {
      await member.ban({ reason });
      console.log(`✅ Banned ${member.user.tag} (${member.id}) for: ${reason}`);
    } catch (err) {
      console.error(`❌ Failed to ban ${member.user.tag}:`, err);
    }
  }
}


// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('purgeunverified')
    .setDescription('Ban all members without the required role.'),
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete recent messages in this channel.')
    .addIntegerOption(opt =>
      opt.setName('amount')
        .setDescription('Number of messages to delete (1–100)')
        .setRequired(true)
    )
].map(cmd => cmd.toJSON());

// Deploy slash commands
const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
})();

// Handle slash commands
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'purgeunverified') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      return interaction.reply({ content: '🚫 You lack `Ban Members` permission.', ephemeral: true });
    }

    await interaction.reply({ content: '🔍 Scanning for unverified members...', ephemeral: true });

    try {
      const guild = await client.guilds.fetch(guildId);
      const members = await guild.members.fetch();
      let count = 0;

      for (const member of members.values()) {
        if (member.user.bot) continue;
        if (member.id === guild.ownerId) continue;
        if (exemptRoleIds.length && member.roles.cache.some(r => exemptRoleIds.includes(r.id))) continue;
        if (!member.roles.cache.has(requiredRoleId)) {
          await safeBanMember(guild, member, 'Purged by command: missing required role');
          count++;
        }
      }

      await interaction.followUp(`✅ Purge complete. Processed ${count} members (DRY_RUN=${DRY_RUN}).`);
    } catch (err) {
      console.error(err);
      await interaction.followUp('❌ Error during purge.');
    }
  }

  if (interaction.commandName === 'purge') {
    const amount = interaction.options.getInteger('amount');
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return interaction.reply({ content: '🚫 You lack `Manage Messages` permission.', ephemeral: true });
    }
    if (amount < 1 || amount > 100) {
      return interaction.reply({ content: '⚠️ Amount must be between 1 and 100.', ephemeral: true });
    }
    try {
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.reply({ content: `✅ Purged ${deleted.size} messages.`, ephemeral: true });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: '❌ Failed to purge messages.', ephemeral: true });
    }
  }
});

// On startup
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  if (SCAN_ON_READY) {
    console.log('🔍 Running startup scan for unverified members...');
    try {
      const guild = await client.guilds.fetch(guildId);
      const members = await guild.members.fetch();
      let count = 0;

      for (const member of members.values()) {
        if (member.user.bot) continue;
        if (member.id === guild.ownerId) continue;
        if (exemptRoleIds.length && member.roles.cache.some(r => exemptRoleIds.includes(r.id))) continue;
        if (!member.roles.cache.has(requiredRoleId)) {
          await safeBanMember(guild, member, 'Startup scan: missing required role');
          count++;
        }
      }

      console.log(`✅ Startup scan complete. Processed ${count} members (DRY_RUN=${DRY_RUN}).`);
    } catch (err) {
      console.error('❌ Error during startup scan:', err);
    }
  }
});

client.login(token);
