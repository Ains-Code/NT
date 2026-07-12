# Discord → GitHub File Writer Bot

A Discord bot that creates **or overwrites** files in GitHub repos — including files nested in
folders that don't exist yet — and can also browse, search, and switch between repos, all
without ever leaving Discord.

## The owner:/repo: pattern (every command)

Every command shares the same two optional options:

- `owner:` — a GitHub username or org (e.g. `jayjay`)
- `repo:` — a repo name (autocompletes live as you type, showing repos under `owner:`), or a
  combined `owner/repo` string (in which case `owner:` is ignored)

Leave both blank and the command uses whatever repo is currently **active** — see `/setrepo`
below. This means `/pushfile`, `/pushtext`, `/browse`, and `/findfile` can all target a repo
other than the active one for a single call, without switching the active repo.

## Commands

- `/pushfile owner: repo: path: file:` — uploads a Discord attachment to a repo. Creates the
  file if it doesn't exist, or **overwrites** it if it does. `path:` shows live suggestions of
  existing files/folders as you type, handy for picking exactly what to overwrite.
- `/pushtext owner: repo: path: content:` — same, but for pasted text/code instead of an
  attachment. `path:` also autocompletes.
- `/setrepo owner: repo:` — switches which repo `pushfile`/`pushtext` target **by default**
  when no `owner:`/`repo:` is given on that call. Takes effect instantly, no restart needed,
  and is remembered even across bot restarts (saved to `active-repo.json` next to the code).
- `/browse owner: repo: path: branch:` — lists files and folders at a path in any repo.
  `path:` autocompletes with matching files/folders too. Read-only.
- `/findfile owner: repo: query: branch:` — searches every file **and folder** path in a repo
  for a substring match. Live suggestions appear as you type `query:`. Read-only.
- `/listrepos owner:` — lists every repo under a user/org (or your own token's account if
  `owner:` is left blank, including private repos it can see). Read-only.
- `/searchrepo query: owner:` — searches **all of GitHub** for repos by name/keyword, with live
  suggestions as you type. Read-only.

Both `pushfile`/`pushtext` accept optional `message:` (commit message) and `branch:` (defaults
to the target repo's default branch).

## Permissions

Only `pushfile`, `pushtext`, and `setrepo` are gated by `ALLOWED_USER_IDS` in `.env`, since
those are the only commands that change something. `browse`, `findfile`, `listrepos`, and
`searchrepo` are read-only and open to anyone who can use slash commands in the server.

**Note on private repos:** all commands use the same `GITHUB_TOKEN`. Public repos are readable
regardless of the token's scope; a private repo needs the token to actually have read (or
read+write, for pushes) access to it.

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
   - Restrict it to the repo(s) you want writable, with **Contents: Read and write** permission.
   - Copy it into `GITHUB_TOKEN`.

4. **Copy `.env.example` to `.env`** and fill in all values, including:
   - `GITHUB_OWNER` / `GITHUB_REPO` — the repo used as the very first active repo (before
     `/setrepo` has ever been used).
   - `ALLOWED_USER_IDS` — comma-separated Discord user IDs allowed to run write commands.

5. **Register the slash commands**
   ```bash
   npm run deploy-commands
   ```
   Re-run this any time the command definitions change (e.g. after this update). Set
   `DISCORD_GUILD_ID` in `.env` while testing — guild-scoped commands update instantly, global
   commands can take up to an hour to propagate.

6. **Run the bot**
   ```bash
   npm start
   ```

## Log channel + self-cleaning replies

Every command's reply in the channel where it was run auto-deletes itself after
`REPLY_AUTO_DELETE_SECONDS` (default 5 seconds, set to `0` to disable). A **permanent** record of
every push and repo switch is posted to `LOG_CHANNEL_ID` instead, e.g.:

```
✅ Overwrite was successful 'mods/conveyor/Conveyor.java' in 'jayjay/mod-mindustry' — by @jayjay — https://github.com/.../commit/...
🔀 Target repo switched to 'jayjay/Nyakk' by @jayjay
❌ Push failed for command /pushfile by @jayjay: Not Found
```

## Security notes

- The bot only writes to whatever repo is currently active, or one explicitly named via
  `owner:`/`repo:` on the call itself — it can't be pointed anywhere your `GITHUB_TOKEN` doesn't
  already have access to.
- Keep `ALLOWED_USER_IDS` set. Anyone on that list can overwrite any file in any repo the token
  can write to, and can change the active repo.
- File size is capped at 5 MB and pasted text at 200,000 characters — adjust `MAX_FILE_BYTES` /
  `MAX_TEXT_CHARS` in `index.js` if you need different limits.
- Path traversal segments (`.` / `..`) are rejected in `github.js`.  / `MAX_TEXT_CHARS` in `index.js` if you need different limits.
- Path traversal segments (`.` / `..`) are rejected in `github.js`.
- Consider adding a confirmation step (e.g. a button) before overwriting files in production
  branches if you want extra protection against accidental overwrites.

## How the overwrite logic works (github.js)

1. Normalize the given path (strip leading slashes, block `..`).
2. Try to fetch the existing file's SHA via `repos.getContent`. A 404 means it doesn't exist yet.
3. Call `repos.createOrUpdateFileContents` with that SHA (or omit it for a brand-new file).
   GitHub requires the current SHA to overwrite a file — this is what prevents accidental
   clobbering of someone else's concurrent edit.
