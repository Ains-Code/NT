require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

// Every command below shares the same owner:/repo: pattern:
//   - owner: optional GitHub username/org
//   - repo:  optional repo name (autocompletes as you type, showing repos under `owner`)
// Leave both blank to use whatever repo is currently active (see /setrepo).
// You can also just type "owner/repo" directly into repo: — owner: is then ignored.
function addOwnerRepoOptions(builder, { repoRequired = false } = {}) {
  return builder
    .addStringOption((opt) =>
      opt
        .setName('owner')
        .setDescription('GitHub username or org (optional — narrows the repo: suggestions)')
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('repo')
        .setDescription('Repo name, or "owner/repo" (leave blank to use the current active repo)')
        .setRequired(repoRequired)
        .setAutocomplete(true)
    );
}

const commands = [
  addOwnerRepoOptions(
    new SlashCommandBuilder()
      .setName('pushfile')
      .setDescription('Upload an attached file to a path in a GitHub repo (creates or overwrites).')
      .addAttachmentOption((opt) =>
        opt.setName('file').setDescription('The file to upload').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('path')
          .setDescription('Repo path, e.g. mods/conveyor/Conveyor.java (folders are created automatically)')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName('message').setDescription('Commit message (optional)').setRequired(false)
      )
      .addStringOption((opt) =>
        opt.setName('branch').setDescription('Target branch (defaults to the repo default branch)').setRequired(false)
      )
  ).toJSON(),

  addOwnerRepoOptions(
    new SlashCommandBuilder()
      .setName('pushtext')
      .setDescription('Write pasted text/code to a path in a GitHub repo (creates or overwrites).')
      .addStringOption((opt) =>
        opt
          .setName('path')
          .setDescription('Repo path, e.g. mods/conveyor/README.md (folders are created automatically)')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName('content').setDescription('The text/code content to write').setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName('message').setDescription('Commit message (optional)').setRequired(false)
      )
      .addStringOption((opt) =>
        opt.setName('branch').setDescription('Target branch (defaults to the repo default branch)').setRequired(false)
      )
  ).toJSON(),

  addOwnerRepoOptions(
    new SlashCommandBuilder()
      .setName('browse')
      .setDescription('List files and folders at a path in any GitHub repo (read-only).')
      .addStringOption((opt) =>
        opt.setName('path').setDescription('Folder path (leave blank for repo root)').setRequired(false).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName('branch').setDescription('Branch or tag (defaults to the repo default branch)').setRequired(false)
      )
  ).toJSON(),

  addOwnerRepoOptions(
    new SlashCommandBuilder()
      .setName('findfile')
      .setDescription('Search file/folder names in a GitHub repo (like a search bar for the repo tree).')
      .addStringOption((opt) =>
        opt.setName('query').setDescription('Text to search for in file/folder paths').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName('branch').setDescription('Branch or tag (defaults to the repo default branch)').setRequired(false)
      )
  ).toJSON(),

  addOwnerRepoOptions(
    new SlashCommandBuilder()
      .setName('setrepo')
      .setDescription('Switch which GitHub repo pushfile/pushtext target — no restart needed.'),
    { repoRequired: true }
  ).toJSON(),

  new SlashCommandBuilder()
    .setName('listrepos')
    .setDescription('List repos owned by a user/org (or your own account if left blank).')
    .addStringOption((opt) =>
      opt
        .setName('owner')
        .setDescription("GitHub username or org (leave blank to list your own token's account repos)")
        .setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('searchrepo')
    .setDescription('Search GitHub for repos by name/keyword across all of GitHub.')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Repo name or keyword to search for').setRequired(true).setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt.setName('owner').setDescription('Optional: restrict results to this user/org').setRequired(false)
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
