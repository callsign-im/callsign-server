// Removes credentials from text before it leaves the machine. What reaches a live session is a
// short summary of each step, but commands and their output can still carry keys.

const PATTERNS: [RegExp, string][] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[private key]",
  ],
  [/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-(proj-)?[A-Za-z0-9_-]{16,})/g, "[secret]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[secret]"],
  [/\b(csk|csr)_[A-Za-z0-9_-]{16,}/g, "[secret]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[secret]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[secret]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[secret]"],
  [/\b(re|whsec|sk_live|sk_test|rk_live)_[A-Za-z0-9]{16,}/g, "[secret]"],
  [/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [secret]"],
  [/(:\/\/[^:/\s]+:)[^@/\s]+@/g, "$1[secret]@"],
  [
    /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/gi,
    "$1$2[secret]",
  ],
];

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|DSN|DATABASE_URL)/i;

// Values of secret-looking environment variables, longest first so overlapping ones are replaced fully.
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(
      ([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8,
    )
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

export function scrub(text: string, values: string[] = secretValues()): string {
  let clean = text;
  for (const value of values) clean = clean.split(value).join("[secret]");
  for (const [pattern, replacement] of PATTERNS) clean = clean.replace(pattern, replacement);
  return clean;
}

const SECRET_FILE =
  /(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)|[^/]+\.(pem|key|p12|pfx)|credentials(\.json)?)$/i;

export function isSecretFile(path: string): boolean {
  return SECRET_FILE.test(path);
}
