require('dotenv').config();
const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');
const {
  createOrOverwriteFile,
  listDirectory,
  searchFiles,
  listRepos,
  searchRepos,
  suggestRepoNames,
  getActiveRepo,
  setActiveRepo,
} = require('./github');

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

// Basic safety limits.
// MAX_FILE_BYTES is set to GitHub's own hard ceiling for the Contents API
// (createOrUpdateFileContents) — GitHub enforces 100 MB per file and rejects
// anything larger, so this isn't an arbitrary app-side cap anymore, it's the
// real maximum. (Discord's own attachment size limit — 25MB by default, more
// with server boosts — still applies on the upload side; that's outside
// this bot's control.)
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB — GitHub's hard limit

const DISCORD_MSG_LIMIT = 2000; // Discord's hard limit on a single message's content

/**
 * Sends a (potentially long) list of lines to Discord without silently
 * truncating results. Instead of capping at a fixed count:
 *  - Small result sets are sent as one message.
 *  - Medium result sets are paginated across multiple follow-up messages,
 *    each packed to fit Discord's 2000-char message limit.
 *  - Very large result sets are sent as a downloadable .txt attachment
 *    instead of dozens of chat messages.
 */
async function sendListReply(interaction, header, lines, { asFileThreshold = 300 } = {}) {
  if (lines.length === 0) {
    await interaction.editReply(header);
    return;
  }

  if (lines.length > asFileThreshold) {
    const buffer = Buffer.from(lines.join('\n'), 'utf8');
    await interaction.editReply({
      content: `${header}\n📎 ${lines.length} results — attached as a file (too many to paginate cleanly in chat).`,
      files: [{ attachment: buffer, name: 'results.txt' }],
    });
    return;
  }

  const codeBlockOverhead = 8; // "```\n" + "\n```"
  const budget = DISCORD_MSG_LIMIT - codeBlockOverhead;

  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const line of lines) {
    const lineLen = line.length + 1; // + newline
    if (current.length && currentLen + lineLen > budget) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length) chunks.push(current);

  const pageSuffix = chunks.length > 1 ? ` (page 1/${chunks.length})` : '';
  await interaction.editReply(`${header}${pageSuffix}\n\`\`\`\n${chunks[0].join('\n')}\n\`\`\``);
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp(`(page ${i + 1}/${chunks.length})\n\`\`\`\n${chunks[i].join('\n')}\n\`\`\``);
  }
}

// Every command that takes owner:/repo: reads them the same way.
function getOwnerRepoOptions(interaction) {
  return {
    owner: interaction.options.getString('owner') || undefined,
    repo: interaction.options.getString('repo') || undefined,
  };
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    try {
      const focused = interaction.options.getFocused(true); // { name, value }
      const typed = focused.value || '';
      const commandName = interaction.commandName;

      // repo: autocomplete — shared by pushfile, browse, findfile, setrepo.
      if (focused.name === 'repo') {
        const owner = interaction.options.getString('owner') || undefined;
        const suggestions = await suggestRepoNames({ owner, typed });
        const choices = suggestions.map((r) => ({
          name: `${r.private ? '🔒' : '📦'} ${r.fullName}`.slice(0, 100),
          value: r.fullName.split('/')[1].slice(0, 100),
        }));
        await interaction.respond(choices);
        return;
      }

      // path: autocomplete — shared by pushfile, browse. Shows existing
      // files/folders in the target repo that match what's typed so far, so you
      // can browse into the right spot (or reuse an existing file to overwrite it)
      // without knowing the exact path by heart.
      if (focused.name === 'path') {
        const owner = interaction.options.getString('owner') || undefined;
        const repo = interaction.options.getString('repo') || undefined;
        if (!typed.trim()) {
          await interaction.respond([]);
          return;
        }
        const { matches } = await searchFiles({ repoFull: repo, owner, query: typed });
        const choices = matches.slice(0, 25).map((m) => ({
          name: (m.type === 'dir' ? `📁 ${m.path}/` : `📄 ${m.path}`).slice(0, 100),
          value: m.path.slice(0, 100),
        }));
        await interaction.respond(choices);
        return;
      }

      // query: autocomplete for findfile (matches file/folder paths in the target repo).
      if (commandName === 'findfile' && focused.name === 'query') {
        if (!typed.trim()) {
          await interaction.respond([]);
          return;
        }
        const { owner, repo } = getOwnerRepoOptions(interaction);
        const { matches } = await searchFiles({ repoFull: repo, owner, query: typed });
        const choices = matches.slice(0, 25).map((m) => ({
          name: (m.type === 'dir' ? `📁 ${m.path}/` : `📄 ${m.path}`).slice(0, 100),
          value: m.path.slice(0, 100),
        }));
        await interaction.respond(choices);
        return;
      }

      // query: autocomplete for searchrepo (matches repo names across GitHub).
      if (commandName === 'searchrepo' && focused.name === 'query') {
        if (!typed.trim()) {
          await interaction.respond([]);
          return;
        }
        const owner = interaction.options.getString('owner') || undefined;
        const repos = await searchRepos({ query: typed, owner });
        const choices = repos.slice(0, 25).map((r) => ({
          name: `${r.private ? '🔒' : '📦'} ${r.fullName}`.slice(0, 100),
          value: r.fullName.slice(0, 100),
        }));
        await interaction.respond(choices);
        return;
      }

      await interaction.respond([]);
    } catch (err) {
      console.error('Autocomplete error:', err.message);
      try {
        await interaction.respond([]);
      } catch {
        // interaction may have already expired — nothing more to do
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const commandName = interaction.commandName;
  if (!['pushfile', 'browse', 'findfile', 'setrepo', 'listrepos', 'searchrepo'].includes(commandName)) return;

  // Only the write commands (including setrepo, since it changes where writes go)
  // require the allowlist — browse/findfile/listrepos/searchrepo are read-only
  // and safe to expose more broadly, since they can't change anything in the repo.
  const isWriteCommand = ['pushfile', 'setrepo'].includes(commandName);
  if (isWriteCommand && !isAllowed(interaction.user.id)) {
    await interaction.reply({
      content: '⛔ You are not authorized to write to the connected GitHub repo.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  if (commandName === 'listrepos') {
    try {
      const owner = interaction.options.getString('owner') || undefined;
      const repos = await listRepos({ owner });

      if (repos.length === 0) {
        await interaction.editReply(`📂 No repos found${owner ? ` for **${owner}**` : ''}.`);
        scheduleAutoDelete(interaction);
        return;
      }

      const lines = repos.map((r) => `${r.private ? '🔒' : '📦'} ${r.fullName}${r.description ? ` — ${r.description}` : ''}`);
      const header = `**Repos${owner ? ` for ${owner}` : " for your token's account"}** (${repos.length}):`;

      await sendListReply(interaction, header, lines);
    } catch (err) {
      console.error(err);
      await interaction.editReply(`❌ Failed: ${err?.message || 'Unknown error'}`);
    }
    scheduleAutoDelete(interaction);
    return;
  }

  if (commandName === 'searchrepo') {
    try {
      const query = interaction.options.getString('query', true);
      const owner = interaction.options.getString('owner') || undefined;
      const repos = await searchRepos({ query, owner });

      if (repos.length === 0) {
        await interaction.editReply(`🔍 No repos found matching \`${query}\`${owner ? ` under **${owner}**` : ''}.`);
        scheduleAutoDelete(interaction);
        return;
      }

      const lines = repos.map((r) => `${r.private ? '🔒' : '📦'} ${r.fullName} ⭐${r.stars}${r.description ? ` — ${r.description}` : ''}`);
      const header = `🔍 ${repos.length} repo(s) matching \`${query}\`:`;

      await sendListReply(interaction, header, lines);
    } catch (err) {
      console.error(err);
      await interaction.editReply(`❌ Failed: ${err?.message || 'Unknown error'}`);
    }
    scheduleAutoDelete(interaction);
    return;
  }

  if (commandName === 'browse') {
    try {
      const { owner, repo } = getOwnerRepoOptions(interaction);
      const path = interaction.options.getString('path') || '';
      const branch = interaction.options.getString('branch') || undefined;

      const entries = await listDirectory({ repoFull: repo, owner, path, branch });

      if (entries.length === 0) {
        await interaction.editReply(`📁 \`${path || '/'}\` is empty.`);
        scheduleAutoDelete(interaction);
        return;
      }

      const lines = entries.map((e) => (e.type === 'dir' ? `📁 ${e.name}/` : `📄 ${e.name}  (${e.size} bytes)`));
      const repoLabel = repo ? (owner ? `${owner}/${repo}` : repo) : 'current active repo';
      const header = `**${repoLabel}${branch ? ` @ ${branch}` : ''}** — \`${path || '/'}\` (${entries.length}):`;

      await sendListReply(interaction, header, lines);
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
      const { owner, repo } = getOwnerRepoOptions(interaction);
      const branch = interaction.options.getString('branch') || undefined;

      const { matches, truncated, owner: usedOwner, repo: usedRepo, branch: usedBranch } = await searchFiles({
        repoFull: repo,
        owner,
        query,
        branch,
      });

      if (matches.length === 0) {
        await interaction.editReply(`🔍 No files or folders matching \`${query}\` in **${usedOwner}/${usedRepo}**.`);
        scheduleAutoDelete(interaction);
        return;
      }

      const lines = matches.map((m) => (m.type === 'dir' ? `📁 ${m.path}/` : `📄 ${m.path}`));
      const truncNote = truncated ? '\n⚠️ Repo tree was truncated by GitHub (very large repo) — results may be incomplete.' : '';
      const header = `**${usedOwner}/${usedRepo}** @ ${usedBranch} — ${matches.length} match(es) for \`${query}\`:${truncNote}`;

      await sendListReply(interaction, header, lines);
    } catch (err) {
      console.error(err);
      await interaction.editReply(`❌ Failed: ${err?.message || 'Unknown error'}`);
    }
    scheduleAutoDelete(interaction);
    return;
  }

  if (commandName === 'setrepo') {
    try {
      const { owner, repo } = getOwnerRepoOptions(interaction);

      let finalOwner = owner;
      let finalRepo = repo;
      if (repo && repo.includes('/')) {
        const parts = repo.replace(/^\/+|\/+$/g, '').split('/');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          await interaction.editReply('❌ Repo must be `reponame` (with owner:), or `owner/repo` combined.');
          scheduleAutoDelete(interaction);
          return;
        }
        [finalOwner, finalRepo] = parts;
      }

      if (!finalOwner || !finalRepo) {
        await interaction.editReply('❌ Provide both `owner:` and `repo:`, or `repo: owner/repo` combined.');
        scheduleAutoDelete(interaction);
        return;
      }

      const updated = setActiveRepo(finalOwner, finalRepo);
      await interaction.editReply(
        `✅ Target repo switched to **${updated.owner}/${updated.repo}**\n` +
          `\`/pushfile\` will write here from now on — no restart needed, and this is remembered even if the bot restarts.`
      );
      await logToChannel(`🔀 Target repo switched to '${updated.owner}/${updated.repo}' by <@${interaction.user.id}>`);
    } catch (err) {
      console.error(err);
      await interaction.editReply(`❌ Failed: ${err?.message || 'Unknown error'}`);
    }
    scheduleAutoDelete(interaction);
    return;
  }

  // pushfile
  try {
    const { owner, repo } = getOwnerRepoOptions(interaction);
    const path = interaction.options.getString('path', true);
    const message = interaction.options.getString('message') || undefined;
    const branch = interaction.options.getString('branch') || undefined;

    const attachment = interaction.options.getAttachment('file', true);

    if (attachment.size > MAX_FILE_BYTES) {
      await interaction.editReply(
        `❌ File is too large (${attachment.size} bytes). Limit is ${MAX_FILE_BYTES} bytes (100 MB) — this is GitHub's own hard cap, not something this bot can raise further.`
      );
      scheduleAutoDelete(interaction);
      return;
    }

    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`Failed to download attachment (HTTP ${res.status})`);
    const arrayBuffer = await res.arrayBuffer();
    const contentBuffer = Buffer.from(arrayBuffer);

    const result = await createOrOverwriteFile({ path, contentBuffer, message, branch, repoFull: repo, owner });

    await interaction.editReply(
      `✅ ${result.overwritten ? 'Overwrote' : 'Created'} \`${result.path}\` in **${result.owner}/${result.repo}**\n` +
        `Commit: ${result.commitUrl}`
    );

    const actionWord = result.overwritten ? 'Overwrite' : 'Create';
    await logToChannel(
      `✅ ${actionWord} was successful '${result.path}' in '${result.owner}/${result.repo}' — by <@${interaction.user.id}> — ${result.commitUrl}`
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
