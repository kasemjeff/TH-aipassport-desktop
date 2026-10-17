// Log scrubbing — the shapes that look like live credentials never reach
// stdout / bridge.log. OWASP Logging Cheat Sheet: never log secrets. Sessions
// on disk intentionally keep the user's own text verbatim; logs do not need
// to, and a pasted key in a chat message is exactly the kind of thing that
// ends up on someone's screen while they debug.
//
// Its own module so the bridge's logger and the tests pin the same list —
// there is no second copy to drift.
export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9-_]{8,}/g,                    // OpenAI-style
  /xox[bap]-[A-Za-z0-9-]+/g,                  // Slack
  /ghp_[A-Za-z0-9]{8,}/g,                     // GitHub personal access token
  /gho_[A-Za-z0-9]{8,}/g,                     // GitHub OAuth token
  /AKIA[0-9A-Z]{12,}/g,                       // AWS access key id
  /AIza[0-9A-Za-z-_]{15,}/g,                  // Google API key
  /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi,       // authorization headers quoted in errors
];

export const scrubSecrets = (v) => (typeof v === 'string'
  ? SECRET_PATTERNS.reduce((s, re) => s.replace(re, '[redacted]'), v)
  : v);
