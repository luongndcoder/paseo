import { homedir } from "node:os";
import { join } from "node:path";
import type { DirectorySuggestionsRequest, SessionOutboundMessage } from "../../messages.js";
import { expandTilde } from "../../../utils/path.js";
import {
  searchDirectoryEntries,
  WORKSPACE_SEARCH_HIDDEN_DIRECTORIES,
} from "../../../utils/directory-suggestions.js";

export async function handleDirectorySuggestionsRequest(
  msg: DirectorySuggestionsRequest,
  emit: (message: SessionOutboundMessage) => void,
): Promise<void> {
  const { query, limit, requestId, cwd, includeFiles, includeDirectories, matchMode } = msg;

  try {
    const workspaceCwd = cwd?.trim();
    const searchesWorkspace = Boolean(workspaceCwd);
    const homeRoot = process.env.HOME ?? homedir();
    // readdir on TCC-protected folders under ~/Library blocks forever for a process that cannot
    // show a consent prompt, and each blocked call holds a libuv threadpool thread.
    const excludedDiscoveryPaths =
      !searchesWorkspace && process.platform === "darwin" ? [join(homeRoot, "Library")] : [];
    const entries = await searchDirectoryEntries({
      root: workspaceCwd ? expandTilde(workspaceCwd) : homeRoot,
      query,
      pathFormat: searchesWorkspace ? "relative" : "absolute",
      pathQueryPolicy: searchesWorkspace ? "slashes" : "rooted",
      blankQueryBehavior: searchesWorkspace ? "children" : "none",
      rootAliases: searchesWorkspace ? [] : ["~"],
      traversableHiddenDirectoryNames: searchesWorkspace ? WORKSPACE_SEARCH_HIDDEN_DIRECTORIES : [],
      confidentResultScanThreshold: searchesWorkspace ? undefined : 5_000,
      respectGitIgnore: searchesWorkspace,
      excludedDiscoveryPaths,
      includeFiles,
      includeDirectories,
      matchMode,
      limit,
    });
    const directories = entries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => entry.path);
    emit({
      type: "directory_suggestions_response",
      payload: {
        directories,
        entries,
        error: null,
        requestId,
      },
    });
  } catch (error) {
    emit({
      type: "directory_suggestions_response",
      payload: {
        directories: [],
        entries: [],
        error: error instanceof Error ? error.message : String(error),
        requestId,
      },
    });
  }
}
