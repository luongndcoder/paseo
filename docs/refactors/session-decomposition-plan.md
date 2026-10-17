# Session God-File Decomposition Plan

`packages/server/src/server/session.ts` was one `Session` class with 128 handlers, ~60 instance fields and 7 entangled domains. The goal is a **strictly behavior-preserving, incremental** decomposition. Most of it has shipped; `session.ts` is now ~5.9k lines and acts as the connection/dispatch shell.

## Shape that shipped

The plan originally sketched per-domain controllers with an owned-type `ReadonlySet` and a `dispatch(msg)` method (the `TerminalSessionController` idiom). What shipped is different and is the convention to follow:

- Each domain is a **deep module** at `session/<domain>/`, with a narrow **Host seam** interface the shell implements (`XSessionHost`). The module owns its state and handler bodies; it never reaches into `Session`.
- `session.ts` keeps one `dispatchXMessage` switch per group and delegates **per case** (`return this.xSession.handleFoo(msg)`). There is no owned-type set on the modules, except `TerminalSessionController` and `VoiceSessions`.
- `dispatchInboundMessage` builds `a() ?? b() ?? ...` and short-circuits on the first non-`undefined` Promise object. Message-type spaces are disjoint, so at most one dispatcher matches. Moving a case between dispatchers must be an atomic remove-and-add.
- Tests that patched moved private methods go through `asSessionInternals` in `session/test-utils/session-stubs.ts`, which forwards to the owning module.
- `cleanup()` stays the single ordered teardown on the shell; modules expose `dispose()`/`close()` that it calls at the position the inline teardown occupied.

Rejected alternatives: **feature-module** (free functions plus a wide context bag) cannot own live state machines and adds a second idiom; **mixin-composition** keeps the shared-`this` god object and forces ~325 private fields to `protected`.

## Module map and owned message types

This table is the source for the Rust edge routing table. "Via" is the dispatcher in `session.ts` that routes to the module. A type listed once is owned once.

| Module (`session/<domain>/`) | Seam / entry | Owned inbound message types |
| --- | --- | --- |
| `agent-lifecycle/agent-lifecycle-session.ts` (+ `fetch-agents-entries.ts`) | `AgentLifecycleSession`, `AgentLifecycleSessionHost` | `fetch_agents_request`, `fetch_agent_history_request`, `fetch_recent_provider_sessions_request`, `fetch_agent_request`, `delete_agent_request`, `archive_agent_request`, `close_items_request`, `update_agent_request`, `send_agent_message_request`, `wait_for_finish_request`, `create_agent_request`, `resume_agent_request`, `import_agent_request`, `refresh_agent_request`, `cancel_agent_request`, `agent_permission_response`, `clear_agent_attention`, `agent.detach.request` |
| `agent-config/agent-config-session.ts` | `AgentConfigSession`, `AgentConfigSessionHost` + `AgentConfigOperations` | `set_agent_mode_request`, `set_agent_model_request`, `set_agent_feature_request`, `set_agent_thinking_request`, `agent.config.apply.request`, `list_commands_request` |
| `agent-updates/agent-updates-service.ts` | `createAgentUpdatesService` | none (outbound `agent_update` fan-out, filter matching, bootstrap buffering) |
| `checkout/checkout-session.ts` (+ `git-metadata-generator.ts`) | `CheckoutSession`, `CheckoutSessionHost`, port `CheckoutDiffSubscriber` | `checkout_status_request`, `checkout.commits.list.request`, `checkout.commits.file_diff.request`, `validate_branch_request`, `branch_suggestions_request`, `checkout.diff.get.request`, `subscribe_checkout_diff_request`, `unsubscribe_checkout_diff_request`, `checkout_switch_branch_request`, `checkout.rename_branch.request`, `checkout_commit_request`, `checkout_merge_request`, `checkout_merge_from_base_request`, `checkout_pull_request`, `checkout_push_request`, `checkout.refresh.request`, `checkout.discard_changes.request`, `checkout_pr_create_request`, `checkout_pr_merge_request`, `checkout.forge.set_auto_merge.request` / `checkout.github.set_auto_merge.request`, `checkout.forge.get_check_details.request` / `checkout.github.get_check_details.request`, `checkout_pr_status_request`, `pull_request_timeline_request`, `forge.search.request` / `github_search_request`, `stash_save_request`, `stash_pop_request`, `stash_list_request` |
| `workspace/workspace-session.ts` (+ `directory-suggestions.ts`) | `WorkspaceSession`, `WorkspaceSessionHost` | `fetch_workspaces_request`, `directory_suggestions_request`, `project.rename.request`, `project.icon.set.request`, `project.icon.get.request`, `workspace.recovery.inspect.request`, `workspace.recovery.restore.request` |
| `workspace-labels/workspace-label-session.ts` | `WorkspaceLabelSession`, `WorkspaceLabelSessionHost` | `workspace.label.list.request`, `workspace.label.assignment.set.request`, `workspace.label.update.request`, `workspace.label.delete.request`, `workspace.label.delete.inspect.request` |
| `workspace-recovery/`, `workspace-provisioning/`, `workspace-scripts/`, `workspace-git-observer/`, `git-mutation/` | `create*Service` factories with injected deps | none directly. They serve `WorkspaceSession`, creation flows and script handlers. The git observer calls `CheckoutSession.emitStatusUpdate` and the workspace update emitter through injected callbacks |
| `files/workspace-files-session.ts` | `WorkspaceFilesSession` | `file_explorer_request`, `fs.file.subscribe.request`, `fs.file.unsubscribe.request`, `fs.file.write.request`, `fs.entry.create.request`, `fs.entry.rename.request`, `fs.entry.duplicate.request`, `fs.entry.delete.request`, `project_icon_request`, `file_download_token_request`, `file.upload.request`, plus `file_transfer` binary frames |
| `provider/provider-catalog-session.ts` | `ProviderCatalogSession` | `list_provider_models_request`, `list_provider_modes_request`, `list_provider_features_request`, `list_available_providers_request`, `get_providers_snapshot_request`, `refresh_providers_snapshot_request`, `provider_diagnostic_request`; also owns the `providers_snapshot_update` push |
| `usage/usage-session.ts` | `UsageSession` | `provider.usage.list.request`, `usage.list_reports.request` |
| `voice/voice-session.ts`, `voice-turn-controller.ts`, `index.ts` | `VoiceSessions` (per-socket) wrapping `VoiceSession`, seam `VoiceSessionHost` | `voice_audio_chunk`, `abort_request`, `audio_played`, `set_voice_mode`, `dictation_stream_start`, `dictation_stream_chunk`, `dictation_stream_finish`, `dictation_stream_cancel`; owns `shouldAutoAllowVoicePermission` wiring |
| `schedule/schedule-session.ts` | `ScheduleSession`, `ScheduleSessionHost` | `schedule/create`, `schedule/list`, `schedule/inspect`, `schedule/logs`, `schedule/pause`, `schedule/resume`, `schedule/delete`, `schedule/run-once`, `schedule/update` |
| `daemon/daemon-session.ts` (+ self-update, diagnostics, npm-global-cli) | `DaemonSession` | `daemon.get_status.request`, `daemon.get_pairing_offer.request`, `daemon.config.reload.request`, `hub.management.daemon.connect.request`, `hub.management.daemon.get_status.request`, `hub.management.daemon.disconnect.request`, `hub.management.daemon.permissions.update.request`, `diagnostics.request`, `daemon.update.request` |
| `project-config/project-config-session.ts` | `ProjectConfigSession` | `read_project_config_request`, `write_project_config_request` |
| `owned-subscriptions/index.ts` | `SessionDelivery` | none (owned subscription lifecycle: `begin`, `release`, `subscriptionIds`) |
| `../terminal/terminal-session-controller.ts` | `TerminalSessionController`, owned-type set | `subscribe_terminals_request`, `unsubscribe_terminals_request`, `list_terminals_request`, `create_terminal_request`, `subscribe_terminal_request`, `unsubscribe_terminal_request`, `terminal_input`, `kill_terminal_request`, `capture_terminal_request`, `terminal.rename.request`, plus terminal binary frames |

### Still inline in `session.ts`

Handlers with no module yet. The Rust routing table treats these as shell-owned.

| Group | Message types |
| --- | --- |
| Voice-adjacent control | `restart_server_request`, `shutdown_server_request`, `client_heartbeat`, `ping` |
| Subscriptions and browser host | `browser.host.register.request`, `browser.automation.execute.response`, `subscription.release.request`, `session.events.set_subscription.request`, `agent.timeline.set_subscription.request` |
| Agent timeline, rewind, fork | `agent.rewind.request`, `fetch_agent_timeline_request`, `agent.timeline.append.request`, `agent.timeline.search.request`, `agent.timeline.list_prompts.request`, `agent.provider_subagents.list.request`, `agent.provider_subagents.timeline.get.request`, `agent.fork_context.request` |
| Creation flows | `agent.create.request`, `creation.subscribe.request`, `workspace.create.request` |
| Hub execution | `hub.execution.agent.create.request`, `hub.execution.agent.validate.request`, `hub.execution.control.request` |
| Workspace and project (remaining) | `project.list.request`, `project.remove.request`, `project.add.request`, `project.create_directory.request`, `project.github.clone.request`, `workspace.github.search_repositories.request`, `open_project_request`, `paseo_worktree_list_request`, `paseo_worktree_archive_request`, `create_paseo_worktree_request`, `archive_workspace_request`, `workspace.title.set.request`, `workspace.pin.set.request`, `workspace.clear_attention.request`, `workspace.mark_unread.request`, `workspace_setup_status_request`, `workspace.setup.run.request` |
| Legacy editor RPCs | `list_available_editors_request`, `open_in_editor_request` (tagged `COMPAT(desktopEditorBridge)`) |
| Workspace scripts | `start_workspace_script_request`, `workspace.script.list.request`, `workspace.script.start.request`, `workspace.script.stop.request` (handlers on the shell, backed by `workspace-scripts-service`) |
| Daemon config | `get_daemon_config_request`, `set_daemon_config_request` |
| Orchestration skills | `agent.skills.get_status.request`, `agent.skills.reconcile.request`, `agent.skills.uninstall.request`, `agent.skills.save_selection.request`, `agent.skills.import_legacy_selection.request` |
| Plugins | `plugin.list.request`, `plugin.logs.get.request`, `plugin.reload.request`, `plugin.enable.request`, `plugin.disable.request`, `plugin.remove.request`, `plugin.catalog.get.request`, `plugin.rpc.invoke.request`, `plugin.source.install.request`, `plugin.source.status.request`, `plugin.source.update.preview.request`, `plugin.source.update.apply.request`, `plugin.source.update.request`, `plugin.directory.install.request`, `plugin.directory.inspect.request` |
| Push tokens | `register_push_token`, `push.unregister.request` |

## Slice status

| Slice | Subject | Status | Landed as |
| --- | --- | --- | --- |
| 2 | Provider catalog | shipped | `ProviderCatalogSession` |
| 3 | Observer seams (workspace-git observer callbacks, agent-subscribe split) | shipped | `workspace-git-observer-service.ts`, `subscribeToAgentEvents` router |
| 4 | Git checkout | shipped | `CheckoutSession` (read side first, #1644, then the write handlers) |
| 5 | Workspace | shipped in parts | `WorkspaceLabelSession`, `WorkspaceSession`; remaining handlers listed above |
| 6 | Voice prerequisites (emit purity, abort ownership) | shipped | folded into the voice carve |
| 7 | Voice | shipped | `VoiceSession` (#1640) and per-socket `VoiceSessions` |
| 8a | Agent config setters | shipped | `AgentConfigSession` |
| 8b | Agent lifecycle | shipped | `AgentLifecycleSession`, `AgentUpdatesService` |
| - | Schedule, daemon, usage, project config, files | shipped | `ScheduleSession`, `DaemonSession`, `UsageSession`, `ProjectConfigSession`, `WorkspaceFilesSession` |

Remaining candidates, each a separate carve behind its own Host seam: the workspace/project handlers still inline (they need agent, terminal and setup deps; `archive_workspace_request` is the hardest), agent timeline/rewind/fork, creation flows, plugins, orchestration skills.

## Constraints that still apply

- **Provider COMPAT correctness.** The `providers_snapshot_update` push and the pull handlers call the same visibility/downgrade closures and read `appVersion` live (it is mutated by `updateAppVersion` after construction). Keep the `COMPAT(providersSnapshot)` and `COMPAT(customModeIcons)` comments verbatim.
- **Workspace updates.** The `workspaceUpdatesSubscription` machine moves whole. The agent fan-out writes into it through `emitWorkspaceUpdateForWorkspaceId` on the host.
- **Voice.** Keep `emit` (with the universal trace) on the shell and inject it; do not inject the `AbortController` by value. `ttsDebugStreams.clear()` is tied to abort-controller reassignment, so the two move together. A barge-in must abort the new run's signal.
- **Checkout.** The git observer delegates `emitStatusUpdate` and `scheduleDiffRefresh` to `CheckoutSession`. `checkoutDiffSubscriptions` teardown runs from `cleanup()`.
- **Agent lifecycle.** `handleCloseItemsRequest` has a terminal-kill half and an agent-archive half; they stay separated behind the host.

## Cross-cutting invariants (every slice)

- Run `npm run typecheck` and `npm run lint` after each slice; run `npm run build:server` before diagnosing cross-package type errors.
- No try/catch is added in a module's handlers for dispatch purposes; error handling stays in `handleMessage`.
- Move domain error emitters verbatim. A cross-domain emitter merge is a separate, test-guarded change.
- Add a per-failure test when a shared envelope is introduced (see `agent-config-session.test.ts`).
- Never run the full suite locally; run only the touched files with `--bail=1`.
