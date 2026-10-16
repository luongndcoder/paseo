/**
 * P4 WP0: golden dump of the daemon authorization tables
 * (INBOUND_PERMISSION / OUTBOUND_PERMISSION via requiredPermissionFor*),
 * the allow matrix per permission set, the outbound `status` special case,
 * legacy hub scopes and SessionAuthorization behavior.
 *
 *   tsx scripts/capture-authz-fixtures.ts --out <fixtures/p4>
 */
import {
  DAEMON_PERMISSIONS,
  OWNER_PERMISSIONS,
  SessionAuthorization,
  parseDaemonPermissions,
  permissionsForLegacyHubScopes,
  type DaemonPermission,
} from "../src/server/authorization/index.js";
import {
  requiredPermissionForInbound,
  requiredPermissionForOutbound,
} from "../src/server/authorization/operation-permissions.js";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
} from "../src/server/messages.js";
import { areaDir, errorSummary, resolveOutRoot, writeJson } from "./p4-fixture-utils.js";

const inboundTypes: string[] = SessionInboundMessageSchema.options.map(
  (option) => option.shape.type.value,
);
const outboundTypes: string[] = SessionOutboundMessageSchema.options.map(
  (option) => option.shape.type.value,
);

function describeRequirement(requirement: unknown): { kind: string; permissions: string[] } {
  if (requirement === null) return { kind: "always", permissions: [] };
  if (typeof requirement === "string") return { kind: "one", permissions: [requirement] };
  if (Array.isArray(requirement)) return { kind: "any", permissions: [...requirement] };
  return { kind: "undefined", permissions: [] };
}

const inbound = inboundTypes.map((type) => ({
  type,
  requirement: describeRequirement(
    requiredPermissionForInbound(type as SessionInboundMessage["type"]),
  ),
}));
// For `status` the table entry is the default; the special case is separate.
const outbound = outboundTypes.map((type) => {
  const message = (type === "status"
    ? { type, payload: { status: "other", requestId: "x" } }
    : { type }) as unknown as SessionOutboundMessage;
  return { type, requirement: describeRequirement(requiredPermissionForOutbound(message)) };
});

const statusCases = [
  "agent_created",
  "agent_create_failed",
  "daemon_config_updated",
  "other",
  undefined as unknown as string,
].map((status) => ({
  status: status ?? null,
  requirement: describeRequirement(
    requiredPermissionForOutbound({
      type: "status",
      payload: status === undefined ? {} : { status },
    } as unknown as SessionOutboundMessage),
  ),
}));

const permissionSets: Array<{ name: string; permissions: DaemonPermission[] }> = [
  { name: "owner", permissions: [...OWNER_PERMISSIONS] },
  { name: "none", permissions: [] },
  ...DAEMON_PERMISSIONS.map((permission) => ({
    name: `only:${permission}`,
    permissions: [permission],
  })),
  { name: "hub_execute_and_read", permissions: ["hub.execute", "workspace.read"] },
  { name: "workspace_rw", permissions: ["workspace.read", "workspace.write"] },
  { name: "daemon_rw", permissions: ["daemon.read", "daemon.manage"] },
];

const matrix = permissionSets.map(({ name, permissions }) => {
  const authorization = new SessionAuthorization(permissions);
  return {
    name,
    permissions,
    allowedInbound: inboundTypes.filter((type) =>
      authorization.allowsInbound({ type } as SessionInboundMessage),
    ),
    allowedOutbound: outboundTypes.filter((type) =>
      authorization.allowsOutbound(
        (type === "status"
          ? { type, payload: { status: "other", requestId: "x" } }
          : { type }) as unknown as SessionOutboundMessage,
      ),
    ),
    statusAgentCreatedAllowed: authorization.allowsOutbound({
      type: "status",
      payload: { status: "agent_created" },
    } as unknown as SessionOutboundMessage),
  };
});

function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: errorSummary(error) };
  }
}

const unmappedAuthorization = new SessionAuthorization(OWNER_PERMISSIONS);
const unmapped = {
  inbound: attempt(() =>
    unmappedAuthorization.allowsInbound({ type: "definitely_not_a_message" } as never),
  ),
  outbound: attempt(() =>
    unmappedAuthorization.allowsOutbound({ type: "definitely_not_a_message" } as never),
  ),
};

const replaceAuthorization = new SessionAuthorization([
  "workspace.read",
  "daemon.read",
  "workspace.read",
]);
const beforeReplace = replaceAuthorization.listPermissions();
replaceAuthorization.replacePermissions(["hub.execute", "workspace.write", "hub.execute"]);
const session = {
  initialListedPermissions: beforeReplace,
  afterReplaceListedPermissions: replaceAuthorization.listPermissions(),
  allowsPermission: DAEMON_PERMISSIONS.map((permission) => ({
    permission,
    allowed: replaceAuthorization.allowsPermission(permission),
  })),
};

const parseCases: Array<{ input: string[] }> = [
  { input: [] },
  { input: ["workspace.read", "daemon.read"] },
  { input: ["workspace.read", "workspace.read", "daemon.read", "workspace.read"] },
  { input: ["workspace.read", "bogus.perm"] },
  { input: ["hub.execution.*"] },
  { input: [""] },
].map(({ input }) => ({ input, result: attempt(() => parseDaemonPermissions(input)) }) as never);

const legacyScopes = [
  [],
  ["hub.execution.*"],
  ["hub.execution.*", "other"],
  ["other"],
  ["hub.execution.agent.create"],
  ["workspace.read", "hub.execution.*"],
].map((scopes) => ({ scopes, permissions: [...permissionsForLegacyHubScopes(scopes)] }));

const dir = areaDir(resolveOutRoot(), "authz");
writeJson(dir, "permissions.json", {
  note: "requirement.kind: always (null; no permission needed), one (single permission), any (any-of list). Types come from SessionInbound/OutboundMessageSchema options, so a new unmapped protocol type changes this file. `status` outbound is evaluated with payload.status=other for the table row; the special case is under statusSpecialCase.",
  daemonPermissions: [...DAEMON_PERMISSIONS],
  ownerPermissions: [...OWNER_PERMISSIONS],
  inbound,
  outbound,
  statusSpecialCase: statusCases,
});
writeJson(dir, "allow-matrix.json", {
  note: "allowedInbound/allowedOutbound list the message types a principal holding exactly `permissions` may send/receive, in schema order.",
  matrix,
});
writeJson(dir, "behavior.json", {
  note: "unmapped: TS throws on a type missing from the tables (Rust must deny instead). session: replace() semantics and Set ordering. parse/legacy: permission parsing helpers.",
  unmapped,
  session,
  parseCases,
  legacyScopes,
});
