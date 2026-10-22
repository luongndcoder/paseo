import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import React from "react";
import type { ToastApi } from "@/components/toast-host";
import type { OpenFileDisposition } from "@/workspace/file-open";
import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkContext, GetDirectorySuggestions } from "./resolver";

export interface AssistantFileLinkDaemonClient {
  readFile?: import("@getpaseo/client/internal/daemon-client").DaemonClient["readFile"];
  getDirectorySuggestions: GetDirectorySuggestions;
}

export interface AssistantFileLinkResolverConfig {
  client?: AssistantFileLinkDaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
  // Text of the assistant message the links belong to; mentioned directories are fallback bases.
  messageText?: string;
  /** Directory relative paths in the message are resolved against. */
  relativePathBase?: string;
  onOpenWorkspaceFile?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  toast?: ToastApi | null;
}

export interface AssistantFileLinkResolverProviderProps extends AssistantFileLinkResolverConfig {
  children: ReactNode;
}

export interface AssistantFileLinkResolverContextValue {
  config: AssistantFileLinkResolverConfig;
  configRef: MutableRefObject<AssistantFileLinkResolverConfig>;
  getDirectorySuggestions: GetDirectorySuggestions;
}

const AssistantFileLinkResolverContext =
  createContext<AssistantFileLinkResolverContextValue | null>(null);

export function AssistantFileLinkResolverProvider({
  client,
  serverId,
  workspaceRoot,
  messageText,
  relativePathBase,
  onOpenWorkspaceFile,
  toast,
  children,
}: AssistantFileLinkResolverProviderProps) {
  const config = useMemo<AssistantFileLinkResolverConfig>(
    () => ({
      client,
      serverId,
      workspaceRoot,
      messageText,
      relativePathBase,
      onOpenWorkspaceFile,
      toast,
    }),
    [client, serverId, workspaceRoot, messageText, relativePathBase, onOpenWorkspaceFile, toast],
  );
  // Render reads go through `config`; async handlers read the latest committed config via the ref.
  const configRef = useRef<AssistantFileLinkResolverConfig>(config);
  useLayoutEffect(() => {
    configRef.current = config;
  }, [config]);

  const getDirectorySuggestions = useCallback<GetDirectorySuggestions>(async (input) => {
    const activeClient = configRef.current.client;
    if (!activeClient) {
      return { entries: [], error: null };
    }

    const result = await activeClient.getDirectorySuggestions(input);
    return { entries: result.entries, error: result.error };
  }, []);

  const value = useMemo<AssistantFileLinkResolverContextValue>(
    () => ({ config, configRef, getDirectorySuggestions }),
    [config, getDirectorySuggestions],
  );

  return (
    <AssistantFileLinkResolverContext.Provider value={value}>
      {children}
    </AssistantFileLinkResolverContext.Provider>
  );
}

export function useAssistantFileLinkResolverContext(): AssistantFileLinkResolverContextValue {
  const context = useContext(AssistantFileLinkResolverContext);
  return context ?? EMPTY_CONTEXT;
}

export type { AssistantFileLinkContext };

const EMPTY_CONTEXT: AssistantFileLinkResolverContextValue = {
  config: {},
  configRef: { current: {} },
  getDirectorySuggestions: async () => ({ entries: [], error: null }),
};

export function useAssistantFileLinkEnvironment() {
  return useAssistantFileLinkResolverContext().configRef.current;
}
