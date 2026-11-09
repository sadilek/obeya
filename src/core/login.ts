/**
 * Whether a message says Claude Code is not (or no longer) logged in, as Claude Code words it: in
 * its API errors and turn results ("Not logged in · Please run /login", "Failed to authenticate: OAuth
 * session expired …"), in its hints ("claude auth login"), and on stderr as its process exits ("Claude
 * Code process exited with code 1. stderr: not logged in"). Server and UI decide by this alone. Words
 * other tools use as well (an OAuth token expired, gh's "not logged in") count only after Claude
 * Code's own exit message, so another tool's login error offers no Claude login.
 */
export function claudeLoginFailed(message: string): boolean {
  return /\brun [`"“]?\/login\b|\bclaude auth login\b|\bfailed to authenticate(?:: oauth\b|\. api error: 401\b)|\bclaude code process exited with code \d+\. stderr:[^]*\bnot logged in\b/i.test(message);
}

/**
 * Whether a message says Codex lost its login, as Obeya words that failure (`notLoggedIn` in the
 * server's Codex runtime), and where: the host's name, or null for the machine Obeya runs on.
 */
export function codexLoginLost(message: string): { host: string | null } | null {
  const m = /^Codex is not logged in on (this machine|\S+)\. \(/.exec(message);
  return m ? { host: m[1] === 'this machine' ? null : m[1]! } : null;
}
