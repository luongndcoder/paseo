import { useQuery } from "@tanstack/react-query";
import { isWeb } from "@/constants/platform";
import { getDesktopDaemonStatus, shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { useSessionStore } from "@/stores/session-store";

const DESKTOP_DAEMON_SERVER_ID_QUERY_KEY = ["desktop-daemon-server-id"] as const;

interface DesktopDaemonServerIdResult {
  serverId: string | null;
}

async function loadDesktopDaemonServerId(): Promise<DesktopDaemonServerIdResult> {
  const status = await getDesktopDaemonStatus();
  const serverId = status.serverId.trim();
  return {
    serverId: serverId.length > 0 ? serverId : null,
  };
}

function useLocalDaemonServerIdQuery() {
  const isDesktopApp = shouldUseDesktopDaemon();

  return useQuery({
    queryKey: DESKTOP_DAEMON_SERVER_ID_QUERY_KEY,
    queryFn: loadDesktopDaemonServerId,
    enabled: isDesktopApp,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchInterval: (activeQuery) => (activeQuery.state.data?.serverId ? false : 1000),
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useLocalDaemonServerId(): string | null {
  const isDesktopApp = shouldUseDesktopDaemon();
  const query = useLocalDaemonServerIdQuery();

  if (!isDesktopApp) {
    return null;
  }

  return query.data?.serverId ?? null;
}

export type LocalDaemonServerIdState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "resolved"; serverId: string | null };

export function useLocalDaemonServerIdState(): LocalDaemonServerIdState {
  const isDesktopApp = shouldUseDesktopDaemon();
  const query = useLocalDaemonServerIdQuery();

  if (!isDesktopApp) {
    return { status: "resolved", serverId: null };
  }
  if (query.isError) {
    return { status: "error" };
  }
  if (query.isSuccess) {
    return { status: "resolved", serverId: query.data.serverId };
  }
  return { status: "loading" };
}

export function useIsLocalDaemon(serverId: string): boolean {
  const normalizedServerId = serverId.trim();
  const localServerId = useLocalDaemonServerId();

  if (localServerId === null || normalizedServerId.length === 0) {
    return false;
  }

  return localServerId === normalizedServerId;
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  const trimmed = endpoint.trim().toLowerCase();
  return (
    trimmed === "localhost" ||
    trimmed.startsWith("localhost:") ||
    trimmed === "127.0.0.1" ||
    trimmed.startsWith("127.0.0.1:") ||
    trimmed === "[::1]" ||
    trimmed.startsWith("[::1]:") ||
    trimmed === "::1"
  );
}

export function useIsLocalExecution(serverId: string): boolean {
  const isDesktopDaemon = useIsLocalDaemon(serverId);
  const normalizedServerId = serverId.trim();
  const hasSessionClient = useSessionStore((state) =>
    normalizedServerId.length > 0 ? Boolean(state.sessions[normalizedServerId]?.client) : false,
  );

  if (isDesktopDaemon) {
    return true;
  }
  if (!isWeb || normalizedServerId.length === 0) {
    return false;
  }
  if (
    hasSessionClient &&
    typeof window !== "undefined" &&
    isLoopbackEndpoint(window.location.hostname)
  ) {
    return true;
  }
  return false;
}
