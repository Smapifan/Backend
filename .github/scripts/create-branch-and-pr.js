/**
 * create-branch-and-pr.js
 *
 * Creates a feature branch and draft PR for a newly-opened GitHub issue.
 *
 * Features:
 *  - Full debug logging via the `core` toolkit (enable with ACTIONS_STEP_DEBUG=true)
 *  - Exponential-back-off retry for GitHub API rate-limit / server errors
 *    → safe to trigger for up to 50 issues in rapid succession (≥ 3 s apart)
 *  - Idempotent: skips branch / PR creation if they already exist
 *
 * Usage (from actions/github-script):
 *   const run = require('./.github/scripts/create-branch-and-pr.js');
 *   await run({ github, context, core });
 *
 * @param {{ github: import('@octokit/rest').Octokit, context: object, core: object }} params
 */
module.exports = async function createBranchAndPR({ github, context, core }) {
  const issue = context.payload.issue;
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const branchName = `issue-${issue.number}`;

  // ── Structured logger ────────────────────────────────────────────────────────
  const ts = () => new Date().toISOString();
  const log = {
    debug: (msg) => core.debug(`[${ts()}] ${msg}`),
    info:  (msg) => core.info(`[${ts()}] ${msg}`),
    warn:  (msg) => core.warning(`[${ts()}] ${msg}`),
    error: (msg) => core.error(`[${ts()}] ${msg}`),
  };

  // ── Retry helper (exponential back-off, respects Retry-After header) ─────────
  async function withRetry(label, fn, maxAttempts = 6) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        log.debug(`${label} – attempt ${attempt}/${maxAttempts}`);
        const result = await fn();
        log.debug(`${label} – OK (attempt ${attempt})`);
        return result;
      } catch (err) {
        const isRateLimit =
          err.status === 429 ||
          (err.status === 403 && /rate.?limit/i.test(err.message)) ||
          (err.status === 403 && /secondary.?rate/i.test(err.message));
        const isServerError = err.status >= 500;

        if ((isRateLimit || isServerError) && attempt < maxAttempts) {
          // Honour the Retry-After / x-ratelimit-reset header when present
          const retryAfterRaw =
            err.response?.headers?.['retry-after'] ||
            err.response?.headers?.['x-ratelimit-reset'];

          let delayMs;
          if (retryAfterRaw) {
            const asInt = parseInt(retryAfterRaw, 10);
            // If it looks like a Unix timestamp convert to relative ms; else treat as seconds
            delayMs = asInt > 1_000_000_000
              ? Math.max((asInt - Math.floor(Date.now() / 1000)) * 1000, 1000)
              : asInt * 1000;
          } else {
            // 1 s → 2 s → 4 s → 8 s → 16 s (capped at 32 s)
            delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 32_000);
          }

          log.warn(
            `${label} – HTTP ${err.status} (${err.message}). ` +
            `Retrying in ${delayMs} ms (attempt ${attempt}/${maxAttempts})…`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else {
          log.error(`${label} – failed after ${attempt} attempt(s): ${err.message}`);
          throw err;
        }
      }
    }
  }

  // ── Start ────────────────────────────────────────────────────────────────────
  log.info(`=== Automation start – issue #${issue.number}: "${issue.title}" ===`);
  log.debug(`Repository : ${repo.owner}/${repo.repo}`);
  log.debug(`Issue URL  : ${issue.html_url}`);
  log.debug(`Opened by  : @${issue.user.login}`);
  log.debug(`Branch     : ${branchName}`);

  // ── 1. Resolve default branch ────────────────────────────────────────────────
  log.debug('Resolving default branch…');
  const { data: repoData } = await withRetry('repos.get', () =>
    github.rest.repos.get(repo)
  );
  const defaultBranch = repoData.default_branch;
  log.info(`Default branch: ${defaultBranch}`);

  // ── 2. Get HEAD SHA ──────────────────────────────────────────────────────────
  log.debug(`Fetching HEAD SHA for refs/heads/${defaultBranch}…`);
  const { data: refData } = await withRetry('git.getRef', () =>
    github.rest.git.getRef({ ...repo, ref: `heads/${defaultBranch}` })
  );
  const baseSha = refData.object.sha;
  log.info(`Base SHA: ${baseSha}`);

  // ── 3. Create feature branch ─────────────────────────────────────────────────
  log.debug(`Creating branch "${branchName}" at ${baseSha}…`);
  try {
    await withRetry('git.createRef', () =>
      github.rest.git.createRef({
        ...repo,
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
      })
    );
    log.info(`Branch created: ${branchName}`);
  } catch (err) {
    if (err.status === 422) {
      log.warn(`Branch "${branchName}" already exists – skipping.`);
    } else {
      throw err;
    }
  }

  // ── 4. Commit a tracking file ────────────────────────────────────────────────
  const trackingPath = `.github/issues/issue-${issue.number}.md`;
  const fileContent = [
    `# Issue #${issue.number}: ${issue.title}`,
    ``,
    `**Opened by:** @${issue.user.login}`,
    `**URL:** ${issue.html_url}`,
    ``,
    `## Description`,
    ``,
    `<!-- profile-yaml-b64 -->`,
    issue.body || '_No description provided._',
  ].join('\n');

  log.debug(`Writing tracking file: ${trackingPath}`);
  try {
    await withRetry('repos.createOrUpdateFileContents', () =>
      github.rest.repos.createOrUpdateFileContents({
        ...repo,
        path: trackingPath,
        message: `chore: track issue #${issue.number} – ${issue.title}`,
        content: Buffer.from(fileContent).toString('base64'),
        branch: branchName,
        committer: {
          name: 'github-actions[bot]',
          email: 'github-actions[bot]@users.noreply.github.com',
        },
        author: {
          name: 'github-actions[bot]',
          email: 'github-actions[bot]@users.noreply.github.com',
        },
      })
    );
    log.info(`Tracking file committed: ${trackingPath}`);
  } catch (err) {
    log.warn(`Could not commit tracking file: ${err.message}`);
  }

  // ── 4b. Decode and store the profile YAML ────────────────────────────────────
  const b64Body = (issue.body || '').trim();
  if (b64Body) {
    let profileYaml;
    try {
      profileYaml = Buffer.from(b64Body, 'base64').toString('utf8');
    } catch (err) {
      log.warn(`Could not decode base64 body for issue #${issue.number}: ${err.message}`);
    }

    if (profileYaml) {
      // Extract the username field from the decoded YAML.
      // Handles plain scalars and single/double-quoted YAML strings.
      const usernameMatch = profileYaml.match(/^username:\s*(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/m);
      const username = usernameMatch
        ? (usernameMatch[1] ?? usernameMatch[2] ?? usernameMatch[3] ?? '').trim() || null
        : null;

      if (username) {
        const profilePath = `profiles/${username}/profile.yml`;
        log.debug(`Writing profile file: ${profilePath}`);
        try {
          // Check if file already exists (to get its SHA for updates)
          let existingSha;
          try {
            const { data: existing } = await withRetry('repos.getContent (profile)', () =>
              github.rest.repos.getContent({ ...repo, path: profilePath, ref: branchName })
            );
            existingSha = existing.sha;
            log.debug(`Profile file already exists (SHA: ${existingSha}) – will update.`);
          } catch (e) {
            if (e.status !== 404) throw e;
          }

          await withRetry('repos.createOrUpdateFileContents (profile)', () =>
            github.rest.repos.createOrUpdateFileContents({
              ...repo,
              path: profilePath,
              message: `feat: add profile for ${username} (issue #${issue.number})`,
              content: Buffer.from(profileYaml).toString('base64'),
              branch: branchName,
              ...(existingSha ? { sha: existingSha } : {}),
              committer: {
                name: 'github-actions[bot]',
                email: 'github-actions[bot]@users.noreply.github.com',
              },
              author: {
                name: 'github-actions[bot]',
                email: 'github-actions[bot]@users.noreply.github.com',
              },
            })
          );
          log.info(`Profile file committed: ${profilePath}`);
        } catch (err) {
          log.warn(`Could not commit profile file: ${err.message}`);
        }
      } else {
        log.warn(`Could not extract username from decoded profile YAML for issue #${issue.number}`);
      }
    }
  }

  // ── 5. Create draft PR ───────────────────────────────────────────────────────
  const prBody = [
    `Closes #${issue.number}`,
    ``,
    `---`,
    `> 🤖 This pull request was automatically generated for issue #${issue.number}.`,
    `> Implement your changes on the \`${branchName}\` branch, then mark this PR as ready for review.`,
  ].join('\n');

  log.debug(`Creating draft PR: ${branchName} → ${defaultBranch}…`);
  let pr;
  try {
    const { data } = await withRetry('pulls.create', () =>
      github.rest.pulls.create({
        ...repo,
        title: `fix: resolve issue #${issue.number} – ${issue.title}`,
        body: prBody,
        head: branchName,
        base: defaultBranch,
        draft: true,
      })
    );
    pr = data;
    log.info(`Draft PR created: #${pr.number} – ${pr.html_url}`);
  } catch (err) {
    log.error(`Could not create PR: ${err.message}`);
    return;
  }

  // ── 6. Comment on the issue ──────────────────────────────────────────────────
  log.debug(`Posting comment on issue #${issue.number}…`);
  await withRetry('issues.createComment', () =>
    github.rest.issues.createComment({
      ...repo,
      issue_number: issue.number,
      body: [
        `🤖 **Automated setup complete!**`,
        ``,
        `| | |`,
        `|---|---|`,
        `| **Branch** | [\`${branchName}\`](${pr.html_url}) |`,
        `| **Pull Request** | [#${pr.number}](${pr.html_url}) |`,
        ``,
        `Push your changes to \`${branchName}\` and the PR will be ready for review.`,
        `The issue will be closed automatically when the PR is merged.`,
      ].join('\n'),
    })
  );
  log.info(`Comment posted on issue #${issue.number}`);

  log.info(`=== Automation complete – issue #${issue.number} ===`);
};
