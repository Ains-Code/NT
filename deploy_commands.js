require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('pushfile')
    .setDescription('Upload an attached file to a path in the configured GitHub repo (creates or overwrites).')
    .addAttachmentOption((opt) =>
      opt.setName('file').setDescription('The file to upload').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('path')
        .setDescription('Repo path, e.g. mods/conveyor/Conveyor.java (folders are created automatically)')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Commit message (optional)').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('branch').setDescription('Target branch (defaults to configured default branch)').setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('pushtext')
    .setDescription('Write pasted text/code to a path in the configured GitHub repo (creates or overwrites).')
    .addStringOption((opt) =>
      opt
        .setName('path')
        .setDescription('Repo path, e.g. mods/conveyor/README.md (folders are created automatically)')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('content').setDescription('The text/code content to write').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Commit message (optional)').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('branch').setDescription('Target branch (defaults to configured default branch)').setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('browse')
    .setDescription('List files and folders at a path in any GitHub repo (read-only).')
    .addStringOption((opt) =>
      opt
        .setName('repo')
        .setDescription('owner/repo, e.g. Anuken/Mindustry (defaults to the configured repo)')
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('path').setDescription('Folder path (leave blank for repo root)').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('branch').setDescription('Branch or tag (defaults to the repo default branch)').setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('findfile')
    .setDescription('Search file/folder names in a GitHub repo (like a search bar for the repo tree).')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Text to search for in file/folder paths').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('repo')
        .setDescription('owner/repo, e.g. Anuken/Mindustry (defaults to the configured repo)')
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('branch').setDescription('Branch or tag (defaults to the repo default branch)').setRequired(false)
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const route = process.env.DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID)
      : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);

    console.log(`Registering ${commands.length} commands ${process.env.DISCORD_GUILD_ID ? '(guild-scoped, instant)' : '(global, may take up to 1hr)'}...`);
    await rest.put(route, { body: commands });
    console.log('Done.');
  } catch (err) {
    console.error(err);
  }
})();
