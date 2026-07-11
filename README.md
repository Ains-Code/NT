# Discord → GitHub File Writer Bot

A Discord bot with two slash commands that create **or overwrite** files in a GitHub repo,
including files nested in folders that don't exist yet — GitHub's Contents API creates
the folder path implicitly from the file path, so `mods/conveyor/Conveyor.java` just works,
no separate "make folder" step needed.

## Commands

### Write (locked to the current active repo, and to `ALLOWED_USER_IDS`)

- `/pushfile path:<repo/path/to/file.ext> file:<attachment>` — uploads a Discord attachment straight to the repo.
- `/pushtext path:<repo/path/to/file.ext> content:<paste>` — writes pasted text/code directly.
- `/setrepo repo:<owner/repo>` — switches which repo `pushfile`/`pushtext` target, **instantly, with no restart needed**. This choice is saved to `active-repo.json` next to the bot's code, so it's remembered even across restarts. `GITHUB_OWNER`/`GITHUB_REPO` in `.env` are only used the very first time the bot ever runs (before `active-repo.json` exists) — after that, `/setrepo` is the source of truth.

Both `pushfile`/`pushtext` accept optional `message:` (commit message) and `branch:` (defaults to your configured default branch).
Both **overwrite** the target file if it already exists (using its current SHA), or **create** it if it doesn't.

### Read-only browsing (works on *any* repo, not just the configured one)

- `/browse repo:<owner/repo optional> path:<optional> branch:<optional>` — lists the files and
  folders directly inside a directory. Omit `repo` to browse the configured repo; pass e.g.
  `Anuken/Mindustry` to browse a different one.
- `/findfile query:<text> repo:<owner/repo optional> branch:<optional>` — a "search bar" for the
  repo: matches your query as a substring against every file **and folder** path in the repo
  (via the git trees API), so you can find things without knowing the exact directory structure.

These two commands are open to anyone who can use slash commands in the server, since they
can't modify anything — only `pushfile`/`pushtext` are gated by `ALLOWED_USER_IDS`.

**Note on private repos:** `/browse` and `/findfile` use the same `GITHUB_TOKEN` as the write
commands. Public repos are readable regardless of the token's scope; to browse a *private*
repo other than the configured one, the token needs read access to it too.

### Log channel + self-cleaning replies

Every command's reply in the channel where it was run **auto-deletes itself** after
`REPLY_AUTO_DELETE_SECONDS` (default 5 seconds, set to `0` to disable). This keeps the
command channel tidy instead of filling up with bot output.

Meanwhile, a **permanent** record of every push is posted to the channel set in
`LOG_CHANNEL_ID`, in the format:

```
✅ Overwrite was successful 'mods/conveyor/Conveyor.java' — by @jayjay — https://github.com/.../commit/...
✅ Create was successful 'mods/conveyor/README.md' — by @jayjay — https://github.com/.../commit/...
❌ Push failed for command /pushfile by @jayjay: <error message>
```

To set it up:
1. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode).
2. Right-click the channel you want as your log channel → **Copy Channel ID** → paste into
   `LOG_CHANNEL_ID` in `.env`.
3. Make sure the bot has **View Channel** and **Send Messages** permission in that channel.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create a Discord application/bot**
   - https://discord.com/developers/applications → New Application
   - Bot tab → Reset Token → copy it → `DISCORD_TOKEN`
   - General Information tab → Application ID → `DISCORD_CLIENT_ID`
   - OAuth2 → URL Generator → scopes: `bot`, `applications.commands` → permission: `Send Messages` →
     open the generated URL to invite the bot to your server.

3. **Create a GitHub token**
   - GitHub → Settings → Developer settings → Fine-grained personal access tokens
   - Restrict it to **only** the target repo, with **Contents: Read and write** permission.
   - Copy it into `GITHUB_TOKEN`.

4. **Copy `.env.example` to `.env`** and fill in all values, including:
   - `GITHUB_OWNER` / `GITHUB_REPO` — the repo the bot is allowed to write to.
   - `ALLOWED_USER_IDS` — comma-separated Discord user IDs allowed to run the write commands.
     Leave blank only if you fully trust everyone in the server (not recommended).

5. **Register the slash commands**
   ```bash
   npm run deploy-commands
   ```
   Set `DISCORD_GUILD_ID` in `.env` while testing — guild-scoped commands update instantly,
   global commands can take up to an hour to propagate.

6. **Run the bot**
   ```bash
   npm start
   ```

## Security notes

- The bot only writes to the single repo configured in `.env` — it can't be pointed at
  an arbitrary repo from within Discord, which limits the blast radius of a compromised token.
- Keep `ALLOWED_USER_IDS` set. Anyone on that list can overwrite any file in the repo.
- The GitHub token should be **fine-grained** and scoped to just this repo, not a classic
  token with access to everything you own.
- File size is capped at 5 MB and pasted text at 200,000 characters — adjust `MAX_FILE_BYTES`
  / `MAX_TEXT_CHARS` in `index.js` if you need different limits.
- Path traversal segments (`.` / `..`) are rejected in `github.js`.
- Consider adding a confirmation step (e.g. a button) before overwriting files in production
  branches if you want extra protection against accidental overwrites.

## How the overwrite logic works (github.js)

1. Normalize the given path (strip leading slashes, block `..`).
2. Try to fetch the existing file's SHA via `repos.getContent`. A 404 means it doesn't exist yet.
3. Call `repos.createOrUpdateFileContents` with that SHA (or omit it for a brand-new file).
   GitHub requires the current SHA to overwrite a file — this is what prevents accidental
   clobbering of someone else's concurrent edit.
