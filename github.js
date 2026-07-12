const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const DEFAULT_BRANCH = process.env.GITHUB_DEFAULT_BRANCH || 'main';

// Where the currently-active repo choice is persisted, so it survives bot restarts
// without needing to touch .env. Falls back to GITHUB_OWNER/GITHUB_REPO from .env
// the very first time the bot ever runs (or if this file gets deleted).
const STATE_FILE = path.join(__dirname, 'active-repo.json');

function loadActiveRepo() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.owner && parsed.repo) return parsed;
  } catch {
    // no state file yet, or it's corrupt — fall back to .env defaults below
  }
  return { owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO };
}

let activeRepo = loadActiveRepo();

/** Returns the repo that pushfile/pushtext currently target. */
function getActiveRepo() {
  return { ...activeRepo };
}

/**
 * Switches the repo that pushfile/pushtext target, and persists it to disk so
 * it's remembered across bot restarts — no .env edit or restart required.
 */
function setActiveRepo(owner, repo) {
  if (!owner || !repo) throw new Error('Both owner and repo are required.');
  activeRepo = { owner, repo };
  fs.writeFileSync(STATE_FILE, JSON.stringify(activeRepo, null, 2), 'utf8');
  return getActiveRepo();
}

/**
 * Normalizes a user-supplied path: strips leading slashes, backslashes -> slashes,
 * collapses accidental "//" and blocks path traversal ("..").
 * GitHub's Contents API treats the path as a full route including any folders,
 * e.g. "mods/conveyor/Conveyor.java" — the folders are created implicitly,
 * there is no separate "make a folder" step.
 */
function normalizePath(rawPath) {
  let p = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  p = p.replace(/\/{2,}/g, '/');
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error('Path traversal segments ("." or "..") are not allowed.');
  }
  if (!p) throw new Error('Path cannot be empty.');
  return p;
}

/**
 * Looks up the current file's SHA if it exists, so we can overwrite it.
 * Returns null if the file does not exist yet (so we create it fresh).
 */
async function getExistingFileSha(path, branch, ownerOverride, repoOverride) {
  const { owner, repo } = ownerOverride && repoOverride ? { owner: ownerOverride, repo: repoOverride } : getActiveRepo();
  try {
    const res = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });
    if (Array.isArray(res.data)) {
      throw new Error(`"${path}" is a directory, not a file.`);
    }
    return res.data.sha;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Creates the file if it doesn't exist, or overwrites it if it does.
 * contentBuffer: Buffer of the raw file bytes.
 * Pass `repoFull`/`owner` to target a repo for just this one call, without
 * changing the persisted active repo (setActiveRepo). Omit both to use the
 * current active repo.
 */
async function createOrOverwriteFile({ path, contentBuffer, message, branch, repoFull, owner: ownerInput }) {
  const cleanPath = normalizePath(path);
  const targetBranch = branch || DEFAULT_BRANCH;
  const { owner, repo } = resolveRepo(repoFull, ownerInput);

  const existingSha = await getExistingFileSha(cleanPath, targetBranch, owner, repo);

  const res = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: cleanPath,
    message: message || (existingSha ? `Update ${cleanPath}` : `Add ${cleanPath}`),
    content: contentBuffer.toString('base64'),
    branch: targetBranch,
    sha: existingSha || undefined, // omit for new files, required to overwrite existing ones
  });

  return {
    overwritten: Boolean(existingSha),
    path: cleanPath,
    owner,
    repo,
    commitUrl: res.data.commit.html_url,
    commitSha: res.data.commit.sha,
  };
}

/**
 * Resolves the target owner/repo from separate `owner` and `repo` option values.
 * Accepts either:
 *   - repo = "owner/repo" (combined form, owner param ignored)
 *   - repo = "reponame" + owner = "ownername" (split form)
 *   - repo = "reponame" only (owner param omitted) -> uses the active repo's owner
 *   - both omitted -> the current active repo entirely
 */
function resolveRepo(repoInput, ownerInput) {
  const repoTrimmed = (repoInput || '').trim();
  const ownerTrimmed = (ownerInput || '').trim();

  if (!repoTrimmed) {
    return getActiveRepo();
  }

  if (repoTrimmed.includes('/')) {
    const parts = repoTrimmed.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error('Repo must be in the form "owner/repo", e.g. "Anuken/Mindustry".');
    }
    return { owner: parts[0], repo: parts[1] };
  }

  const owner = ownerTrimmed || getActiveRepo().owner;
  if (!owner) {
    throw new Error('An owner is required — either pass owner:, or use "owner/repo" in repo:.');
  }
  return { owner, repo: repoTrimmed };
}

/**
 * Suggests repo names for autocomplete: lists repos under the given owner
 * (or the active repo's owner if none typed yet) and filters by the partial
 * text the user has typed so far.
 */
async function suggestRepoNames({ owner, typed }) {
  const effectiveOwner = (owner && owner.trim()) || getActiveRepo().owner;
  if (!effectiveOwner) return [];

  const repos = await listRepos({ owner: effectiveOwner });
  const q = (typed || '').trim().toLowerCase();
  const filtered = q ? repos.filter((r) => r.fullName.split('/')[1].toLowerCase().includes(q)) : repos;
  return filtered.slice(0, 25);
}

/**
 * Lists the immediate contents (files + folders) of a directory in any repo
 * the configured GITHUB_TOKEN can read (public repos are readable regardless
 * of token scope; private repos need the token to actually have access).
 */
async function listDirectory({ repoFull, owner: ownerInput, path, branch }) {
  const { owner, repo } = resolveRepo(repoFull, ownerInput);
  const cleanPath = path ? normalizePath(path) : '';

  const res = await octokit.repos.getContent({
    owner,
    repo,
    path: cleanPath,
    ref: branch || undefined,
  });

  const entries = Array.isArray(res.data) ? res.data : [res.data];
  return entries
    .map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Full-text-ish search across every file AND folder path in a repo, using the
 * git trees API (recursive) rather than GitHub's code search — this also
 * matches folder names and doesn't require the code-search index to be built,
 * which makes it more reliable for smaller/newer repos.
 */
async function searchFiles({ repoFull, owner: ownerInput, query, branch }) {
  const { owner, repo } = resolveRepo(repoFull, ownerInput);
  if (!query || !query.trim()) throw new Error('Search query cannot be empty.');

  const targetBranch = branch || DEFAULT_BRANCH;

  // Resolve the branch to a commit tree SHA first — the trees endpoint needs an actual SHA.
  const branchInfo = await octokit.repos.getBranch({ owner, repo, branch: targetBranch });
  const treeSha = branchInfo.data.commit.commit.tree.sha;

  const treeRes = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: '1',
  });

  const q = query.trim().toLowerCase();
  const matches = treeRes.data.tree
    .filter((item) => item.path.toLowerCase().includes(q))
    .map((item) => ({
      path: item.path,
      type: item.type === 'tree' ? 'dir' : 'file',
      size: item.size,
    }));

  return { matches, truncated: Boolean(treeRes.data.truncated), owner, repo, branch: targetBranch };
}

/**
 * Lists repos owned by a given user/org (or, if omitted, every repo the
 * GITHUB_TOKEN's own account can see — including private ones it has access to).
 */
async function listRepos({ owner } = {}) {
  let repos;
  if (owner && owner.trim()) {
    // A specific user/org was named — list their public repos (works for anyone, no auth needed).
    const res = await octokit.repos.listForUser({ username: owner.trim(), per_page: 100, sort: 'updated' });
    repos = res.data;
  } else {
    // No owner given — list repos the token's own account can see, private + public.
    const res = await octokit.repos.listForAuthenticatedUser({ per_page: 100, sort: 'updated' });
    repos = res.data;
  }

  return repos.map((r) => ({
    fullName: r.full_name,
    private: r.private,
    description: r.description,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
  }));
}

/**
 * Searches GitHub for repos by name/keyword using the code-search-adjacent
 * repo search API. This searches across ALL of GitHub (public repos), not
 * just one account — good for "is there a repo called X" style lookups.
 * Optionally scope to one owner with owner:<name>.
 */
async function searchRepos({ query, owner }) {
  if (!query || !query.trim()) throw new Error('Search query cannot be empty.');

  let q = query.trim();
  if (owner && owner.trim()) q += ` user:${owner.trim()}`;

  const res = await octokit.search.repos({ q, per_page: 25, sort: 'updated' });

  return res.data.items.map((r) => ({
    fullName: r.full_name,
    private: r.private,
    description: r.description,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
    stars: r.stargazers_count,
  }));
}

module.exports = {
  createOrOverwriteFile,
  normalizePath,
  resolveRepo,
  listDirectory,
  searchFiles,
  listRepos,
  searchRepos,
  suggestRepoNames,
  getActiveRepo,
  setActiveRepo,
  DEFAULT_BRANCH,
};
