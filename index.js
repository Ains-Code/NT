require('dotenv').config();
const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');
const { createOrOverwriteFile, listDirectory, searchFiles, getActiveRepo, setActiveRepo } = require('./github');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const REPLY_AUTO_DELETE_SECONDS = Number(process.env.REPLY_AUTO_DELETE_SECONDS ?? 5);

/**
 * Sends a permanent record to the configured log channel. Failures here are
 * only logged to the console — a broken log channel shouldn't break the command.
 */
async function logToChannel(text) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send(text);
    }
  } catch (err) {
    console.error('Failed to send to log channel:', err.message);
  }
}

/**
 * Auto-deletes the bot's own reply in the command channel after a delay, so the
 * channel where people run commands stays clean — the permanent record lives
 * in the log channel instead. Set REPLY_AUTO_DELETE_SECONDS=0 to disable.
 */
function scheduleAutoDelete(interaction) {
  if (!REPLY_AUTO_DELETE_SECONDS || REPLY_AUTO_DELETE_SECONDS <= 0) return;
  setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, REPLY_AUTO_DELETE_SECONDS * 1000);
}

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowed(userId) {
  if (ALLOWED_USER_IDS.length === 0) return true; // no allowlist configured
  return ALLOWED_USER_IDS.includes(userId);
}

// Basic safety limits
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_TEXT_CHARS = 200_000;

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const commandName = interaction.commandName;
  if (!['pushfile', 'pushtext', 'browse', 'findfile', 'setrepo'].includes(commandName)) return;

  // Only the write commands (including setrepo, since it changes where writes go)
  // require the allowlist — browse/findfile are read-only and safe to expose more broadly.
  const isWriteCommand = ['pushfile', 'pushtext', 'setrepo'].includes(commandName);
  if (isWriteCommand && !isAllowed(interaction.user.id)) {
    await interaction.reply({
      content: '⛔ You are not authorized to write to the connected GitHub repo.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  if (commandName === 'browse') {
    try {
      const repo = interaction.options.getString('repo') || undefined;
      const path = interaction.options.getString('path') || '';
      const branch = interaction.options.getString('branch') || undefined;

      const entries = await listDirectory({ repoFull: repo, path, branch });

      if (entries.length === 0) {
        await interaction.editReply(`📁 \`${path || '/'}\` is empty.`);
        scheduleAutoDelete(interaction);
        return;
      }

      const lines = entries
        .slice(0, 50)
        .map((e) => (e.type === 'dir' ? `📁 ${e.name}/` : `📄 ${e.name}  (${e.size} bytes)`));

      const header = `**${repo || 'configured repo'}${branch ? ` @ ${branch}` : ''}** — \`${path || '/'}\``;
      const extra = entries.length > 50 ? `\n…and ${entries.length - 50} more.` : '';

      await interaction.editReply(`${header}\n\`\`\`\n${lines.join('\n')}\n\`\`\`${extra}`);
    } catch (err) {
      console.error(err);
      await interaction.editReply(`❌ Failed: ${err?.message || 'Unknown error'}`);
    }
    scheduleAutoDelete(interaction);
    return;
  }

  if (commandName === 'findfile') {
    try {
      const query = interaction.options.getString('query', true);
      const repo = interaction.options.getString('repo') || undefined;
      const branch = interaction.options.getString('branch') || undefined;

      const { matches, truncated, owner, repo: repoName, branch: usedBranch } = await searchFiles({
        repoFull: repo,
        query,
        branch,
      });

      if (matches.length === 0) {
        await interaction.editReply(`🔍 No files or folders matching \`${query}\` in **${owner}/${repoName}**.`);
        scheduleAutoDelete(interaction);
        return;
      }

      const lines = matches
        .slice(0, 50)
        .map((m) => (m.type === 'dir' ? `📁 ${m.path}/` : `📄 ${m.path}`));

      const extra = matches.length > 50 ? `\n…and ${matches.length - 50} more matches.` : '';
      const truncNote = truncated ? '\n⚠️ Repo tree was truncated by GitHub (very large repo) — results may be incomplete.' : '';

      await interaction.editReply(
        `**${owner}/${repoName}** @ ${usedBranch} — ${matches.length} match(es) for \`${query}\`:\n` +
          `\`\`\`\n${lines.join('\n')}\n\`\`\`${extra}${truncNote}`
      );
    } catch (err) {
      console.error(err);
      await interaction.editReply(`❌ Failed: ${err?.message || 'Unknown error'}`);
    }
    scheduleAutoDelete(interaction);
    return;
  }

  if (commandName === 'setrepo') {
    try {
      const repoFull = interaction.options.getString('repo', true).trim();
      const parts = repoFull.replace(/^\/+|\/+$/g, '').split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        await interaction.editReply('❌ Repo must be in the form `owner/repo`, e.g. `jayjay/mod-mindustry`.');
        scheduleAutoDelete(interaction);
        return;
      }

      const updated = setActiveRepo(parts[0], parts[1]);
      await interaction.editReply(
        `✅ Target repo switched to **${updated.owner}/${updated.repo}**\n` +
          `\`/pushfile\` and \`/pushtext\` will write here from now on — no restart needed, and this is remembered even if the bot restarts.`
      );
      await logToChannel(`🔀 Target repo switched to '${updated.owner}/${updated.repo}' by <@${interaction.user.id}>`);
    } catch (err) {
      console.error(err);
      await interaction.editReply(`❌ Failed: ${err?.message || 'Unknown error'}`);
    }
    scheduleAutoDelete(interaction);
    return;
  }

  try {
    const path = interaction.options.getString('path', true);
    const message = interaction.options.getString('message') || undefined;
    const branch = interaction.options.getString('branch') || undefined;

    let contentBuffer;

    if (interaction.commandName === 'pushfile') {
      const attachment = interaction.options.getAttachment('file', true);

      if (attachment.size > MAX_FILE_BYTES) {
        await interaction.editReply(`❌ File is too large (${attachment.size} bytes). Limit is ${MAX_FILE_BYTES} bytes.`);
        scheduleAutoDelete(interaction);
        return;
      }

      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`Failed to download attachment (HTTP ${res.status})`);
      const arrayBuffer = await res.arrayBuffer();
      contentBuffer = Buffer.from(arrayBuffer);
    } else {
      const text = interaction.options.getString('content', true);
      if (text.length > MAX_TEXT_CHARS) {
        await interaction.editReply(`❌ Content is too long (${text.length} chars). Limit is ${MAX_TEXT_CHARS}.`);
        scheduleAutoDelete(interaction);
        return;
      }
      contentBuffer = Buffer.from(text, 'utf8');
    }

    const result = await createOrOverwriteFile({ path, contentBuffer, message, branch });

    await interaction.editReply(
      `✅ ${result.overwritten ? 'Overwrote' : 'Created'} \`${result.path}\`\n` +
        `Commit: ${result.commitUrl}`
    );

    const actionWord = result.overwritten ? 'Overwrite' : 'Create';
    await logToChannel(
      `✅ ${actionWord} was successful '${result.path}' — by <@${interaction.user.id}> — ${result.commitUrl}`
    );
  } catch (err) {
    console.error(err);
    const msg = err?.message || 'Unknown error';
    await interaction.editReply(`❌ Failed: ${msg}`);
    await logToChannel(`❌ Push failed for command \`/${interaction.commandName}\` by <@${interaction.user.id}>: ${msg}`);
  }
  scheduleAutoDelete(interaction);
});

client.login(process.env.DISCORD_TOKEN);    return;
  }

  if (commandName === 'findfile') {
    try {
      const query = interaction.options.getString('query', true);
      const repo = interaction.options.getString('repo') || undefined;
      const branch = interaction.options.getString('branch') || undefined;

      const { matches, truncated, owner, repo: repoName, branch: usedBranch } = await searchFiles({
        repoFull: repo,
        query,
        branch,
      });

      if (matches.length === 0) {
        await interaction.editReply(`🔍 No files or folders matching \`${query}\` in **${owner}/${repoName}**.`);
        scheduleAutoDelete(interaction);
        return;
      }

      const lines = matches
        .slice(0, 50)
        .map((m) => (m.type === 'dir' ? `📁 ${m.path}/` : `📄 ${m.path}`));

      const extra = matches.length > 50 ? `\n…and ${matches.length - 50} more matches.` : '';
      const truncNote = truncated ? '\n⚠️ Repo tree was truncated by GitHub (very large repo) — results may be incomplete.' : '';

      await interaction.editReply(
        `**${owner}/${repoName}** @ ${usedBranch} — ${matches.length} match(es) for \`${query}\`:\n` +
          `\`\`\`\n${lines.join('\n')}\n\`\`\`${extra}${truncNote}`
      );
    } catch (err) {
      console.error(err);
      await interaction.editReply(`❌ Failed: ${err?.message || 'Unknown error'}`);
    }
    scheduleAutoDelete(interaction);
    return;
  }

  try {
    const path = interaction.options.getString('path', true);
    const message = interaction.options.getString('message') || undefined;
    const branch = interaction.options.getString('branch') || undefined;

    let contentBuffer;

    if (interaction.commandName === 'pushfile') {
      const attachment = interaction.options.getAttachment('file', true);

      if (attachment.size > MAX_FILE_BYTES) {
        await interaction.editReply(`❌ File is too large (${attachment.size} bytes). Limit is ${MAX_FILE_BYTES} bytes.`);
        scheduleAutoDelete(interaction);
        return;
      }

      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`Failed to download attachment (HTTP ${res.status})`);
      const arrayBuffer = await res.arrayBuffer();
      contentBuffer = Buffer.from(arrayBuffer);
    } else {
      const text = interaction.options.getString('content', true);
      if (text.length > MAX_TEXT_CHARS) {
        await interaction.editReply(`❌ Content is too long (${text.length} chars). Limit is ${MAX_TEXT_CHARS}.`);
        scheduleAutoDelete(interaction);
        return;
      }
      contentBuffer = Buffer.from(text, 'utf8');
    }

    const result = await createOrOverwriteFile({ path, contentBuffer, message, branch });

    await interaction.editReply(
      `✅ ${result.overwritten ? 'Overwrote' : 'Created'} \`${result.path}\`\n` +
        `Commit: ${result.commitUrl}`
    );

    const actionWord = result.overwritten ? 'Overwrite' : 'Create';
    await logToChannel(
      `✅ ${actionWord} was successful '${result.path}' — by <@${interaction.user.id}> — ${result.commitUrl}`
    );
  } catch (err) {
    console.error(err);
    const msg = err?.message || 'Unknown error';
    await interaction.editReply(`❌ Failed: ${msg}`);
    await logToChannel(`❌ Push failed for command \`/${interaction.commandName}\` by <@${interaction.user.id}>: ${msg}`);
  }
  scheduleAutoDelete(interaction);
});

client.login(process.env.DISCORD_TOKEN);
