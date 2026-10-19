const MAX_MENTIONED_DIRECTORIES = 5;

// Rooted tokens only: `/a/b`, `~/a`, `C:\a`. The leading delimiter keeps `and/or` and URLs out.
const ROOTED_TOKEN = /(?:^|[\s`'"([<])((?:~|\/|[A-Za-z]:[\\/])[^\s`'"()[\]<>,;]*)/g;
const FILE_NAME_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

function normalizeToken(rawToken: string): string | null {
  let token = rawToken
    .replace(/\\/g, "/")
    .replace(/[#:]\d.*$/, "")
    .replace(/#.*$/, "")
    .replace(/[.:!?]+$/, "")
    .replace(/\/+$/, "");
  if (token.startsWith("//")) {
    return null;
  }
  if (token === "~") {
    return token;
  }
  const segments = token.split("/").filter(Boolean);
  const isHome = token.startsWith("~/");
  const isDrive = /^[A-Za-z]:\//.test(token);
  // A bare `/foo` is more often a slash command or a route than a directory.
  if (!isHome && !isDrive && segments.length < 2) {
    return null;
  }
  token = token.replace(/\/{2,}/g, "/");
  const lastSegment = segments[segments.length - 1] ?? "";
  if (FILE_NAME_EXTENSION.test(lastSegment) && segments.length > 1) {
    const lastSlash = token.lastIndexOf("/");
    token = token.slice(0, lastSlash) || "/";
  }
  return token === "/" ? null : token;
}

/**
 * Absolute (or `~`) directories an assistant message talks about, in order of appearance.
 * A relative file link that the workspace does not contain is usually relative to one of these.
 */
export function extractMentionedDirectories(
  text: string | undefined,
  workspaceRoot?: string,
): string[] {
  if (!text) {
    return [];
  }
  const root = workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of text.matchAll(ROOTED_TOKEN)) {
    const directory = normalizeToken(match[1] ?? "");
    if (!directory || directory === root || seen.has(directory)) {
      continue;
    }
    seen.add(directory);
    result.push(directory);
    if (result.length >= MAX_MENTIONED_DIRECTORIES) {
      break;
    }
  }
  return result;
}
