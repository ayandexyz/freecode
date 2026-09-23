# Omacode: an Omarchy-native coding experience

Date: 2026-09-24  
Status: product proposal. Integration features below are recommendations unless marked **Done**; live theme following (§2) is built.  
Reviewed: FreeCode `fdb68367`, local Omarchy checkout `c7e973e8` at `/home/ayan-de/Projects/githubProjects/omarchy`.

## Direction

Make Omacode feel like a coding workspace that participates in the desktop: launch it through familiar controls, leave it working while you use another workspace, answer a question from the bar, and return directly to the relevant code.

The ASCII identity is a good foundation. The next investment should be continuity between the terminal, desktop, editor, and project. Keep one coding engine with two integration profiles: normal and Omarchy. Omarchy users get native presentation and desktop connections; everyone gets the same coding capabilities.

Omarchy describes its approach as curated defaults that users remain free to change. Its public site also emphasizes agents helping users understand and shape the computer. These are useful product principles for Omacode, rather than a reason to copy every OS feature into the agent. [Official Omarchy site](https://omarchy.org/)

## What is already there

| Area | Observed implementation | Opportunity |
| --- | --- | --- |
| Identity | The TUI has an eight-line ASCII logo and an `OmaCode` subtitle. | Keep the welcome identity; offer a compact header when working in a small tile. |
| OS palette | `utils/omarchy-theme.ts` detects the active theme file and calls `omarchy-theme-color --all`, with a normal palette fallback. | **Done (2026-09-24):** `watchOmarchyTheme` follows changes during a running session. |
| Theme lifetime | The palette is a stable facade whose paints resolve at call time; `refreshPalette()` swaps the colours behind it. | **Done (2026-09-24):** a theme switch repaints in place. No restart. |
| Activity visibility | The TUI has conditional `/shells` and `/agents` chips. | Carry the same restrained approach into desktop status. |
| Questions | Core emits `question_asked`; the protocol exposes `question.answer` and `question.reject`. | A desktop panel can become another question surface after a local bridge is added. |
| Tasks | `tools/todo.ts` owns session tasks and persists them to `todos.json`. | Publish a supported task snapshot and change feed for the panel. |
| Skills | FreeCode already scans global `~/.agents/skills`, among other locations. | Verify discovery of Omarchy's installed skills instead of duplicating their instructions. |

The inspected code confirms automatic Omarchy theming, and a live theme subscription now exists. It does not establish a complete desktop integration profile or a multi-client desktop bridge.

## Translate the philosophy into behavior

| Omarchy principle, interpreted from its manual | Omacode behavior |
| --- | --- |
| A complete, curated starting point | One recommended Omarchy preset with useful defaults and a short setup. |
| Keyboard-centered work | Every panel action has keyboard navigation; shortcuts remain discoverable from menus. |
| A coherent visual system | Use the current OS palette, semantic status colors, and typography conventions. |
| Tiling and workspace fluency | Work well at narrow widths, focus the correct terminal, and support scratchpad use. |
| User-owned configuration | Human-readable settings, explicit overrides, and removable integration files. |
| Small tools that work together | Reuse the chosen terminal, editor, browser, notifications, and existing Omarchy commands. |
| An adaptable computer | Help users create themes, plugins, and system changes using the installed Omarchy skills. |

These are design interpretations of the local manual, not a claim that Omarchy prescribes this exact product design.

## 1. Build an Omacode top-bar companion

This is the strongest extension of the proposed todo/question plugin. Treat “top nav” as Omarchy's desktop bar; the same information should remain reachable in the TUI.

Use one compact indicator with a dropdown panel. Show a count of sessions that need attention, with text as well as color. Hide it when there is nothing to show unless the user pins it.

Suggested panel sections:

| Section | What the user sees | Primary action |
| --- | --- | --- |
| Needs you | Pending questions, permission requests, and failures, grouped by project | Answer a question or open the relevant session |
| Tasks | Current step, blocked items, completed count | Jump to the task's session |
| Sessions | Project, branch, state, and last activity | Focus its terminal or resume its conversation |
| Running | Background shells, development servers, and subagents | Inspect them; add explicit stop controls later |

Start with **Needs you** and **Sessions**. Add Tasks next. This makes the first version useful without building a large dashboard.

For questions, allow option selection and free-text input. Submission must be explicit. A question answered in the TUI disappears from the panel, and vice versa. A stale panel must never answer a newer request that happens to have similar wording.

For permissions, the first version should take the user to the full TUI prompt. Inline desktop approval can come later when it can show the exact operation, scope, and existing allow/deny choices. A click on a generic notification is not sufficient context for an approval.

Keep task completion owned by the agent workflow. Selecting a task in the panel navigates to it; it does not mark unfinished work complete. Preserve the existing distinction between pending, in progress, blocked, completed, and cancelled.

**Important fit with the OS:** this Omarchy checkout already has an `omarchy.agents` panel for subscription and token usage. That panel is a display of usage records, not an interactive session controller. Build a separate Omacode work companion and contribute usage data to the existing agents panel where appropriate. A third-party plugin must use its own namespace, for example `omacode.work`, because `omarchy.*` is reserved.

## 2. Make the visual integration live

**Theme following is built (2026-09-24).** Switching the OS theme repaints the
running TUI: logo, selection, code blocks, input, status chips, and question
panels.

`watchOmarchyTheme` watches `~/.local/state/omarchy/current/` — the parent, not
`theme/colors.toml`, because a switch replaces the theme directory and a watch
on a file inside it is left on a stale inode and silently never fires again.
Events are debounced 150ms and the watcher reattaches if the directory is
replaced under it. A failed read keeps the last valid palette, so a half-written
theme cannot flash the UI back to the defaults.

The cached-style problem the audit predicted was real and wider than the
mode-line: ten call sites capture paints at module scope. Rather than rewrite
them, `palette` became a **stable facade** whose paints resolve against the
current theme when called, so a captured reference follows the theme for free.
`palette.segments`/`shimmer` keep object identity and are mutated in place;
`segmentFree` is a getter, since a hoisted string cannot be made live.

Still open: a user-pinned theme override. OS following is the only behaviour
today.

Let users explicitly pin a theme. OS following should be the Omarchy default, while a chosen override remains respected. In narrow tiles, collapse the large logo into a one-line identity and keep the current task visible.

## 3. Make launching and returning feel native

Provide an Omarchy menu entry and a desktop launcher that use the user's default terminal. Offer a configurable shortcut rather than taking over an existing binding.

Support three entry points:

- **Open project:** choose a recent project and launch or resume Omacode there.
- **Return to work:** focus the terminal for a selected active session, even on another workspace.
- **Quick question:** summon a compact session in the existing scratchpad workflow.

Record the session-to-window association explicitly. Do not infer the project from an arbitrary focused window title. If its terminal no longer exists, offer to resume the saved conversation; do not imply its old running processes survived.

The local Omarchy manual explicitly describes the scratchpad as useful for an agent terminal. This makes scratchpad support a natural fit without inventing another desktop overlay.

**Default-agent integration is a separate compatibility task.** The inspected `omarchy-default-agent` command has an explicit accepted-agent list and does not include Omacode. A menu extension alone cannot add it to that list. Ship the independent launcher first; propose upstream support for default-agent selection, prompt forwarding, installation, and crash handoff afterward. Preserve Omacode's permission policy rather than copying another agent's unattended flags.

## 4. Notify only when attention is useful

Use `omarchy-notification-send` for “question waiting”, “run failed”, and “ready for review”. Clicking a notification should return to the correct session. Respect desktop quiet settings and avoid duplicate notifications when the user is already watching that session.

Keep intermediate tool activity in the panel. A completed tool call is rarely a reason to interrupt the desktop. Make sounds optional.

Show short, project-scoped messages by default; full question text belongs in the opened panel or TUI. This also avoids broadcasting source snippets or sensitive command arguments onto the desktop.

## 5. Hand work to the user's existing tools

| Integration | Example experience | Scope |
| --- | --- | --- |
| Default editor | Select a changed file and open it at the relevant line. | Resolve the OS editor preference; line targeting needs editor-specific support. |
| Browser preview | Open the development server associated with this session. | Use an explicit known URL; do not guess from arbitrary tool output. |
| Terminal | Open a project shell beside the agent. | Use the chosen terminal and correct working directory. |
| Diff review | Open the project's diff in a configured review tool. | Preserve the user's existing editor/reviewer choice. |
| Screenshot or selection | Send a deliberately selected image or text to a chosen session. | Preview the attachment and destination before submitting. |

The intended feeling is “my existing workspace is cooperating”. There is no need to embed an editor, browser, or file manager into the TUI to achieve it.

## 6. Become a good agent for the OS itself

Expose a small set of discoverable workflows: explain a setting, draft a theme, build a shell plugin, diagnose a crash, or inspect a development environment problem.

Reuse Omarchy's installed skills and current local documentation. FreeCode already scans the shared skills location, so first verify symlink discovery, precedence, and invocation with the actual installation. Avoid maintaining a copied Omarchy manual in the system prompt.

For system customization, show the affected config paths and proposed changes before applying them through the existing permission system. Prefer user extensions over edits to package-owned defaults.

Keep recovery promises precise: FreeCode's project checkpoints undo file changes within their supported project scope. They are not OS snapshots and cannot generally reverse package installs, services, or changes elsewhere in the home directory. An OS customization workflow needs its own scoped backup and recovery procedure.

Once default-agent compatibility exists, Omarchy's existing crash-diagnosis handoff becomes another natural entry point. Do not build a second crash monitor.

## 7. Fit into existing usage and reminder surfaces

Add a usage collector compatible with the existing Omarchy agents record contract. Show recorded token usage and known cost; leave unavailable subscription allowances unknown. Omacode supports multiple providers, so one invented “remaining quota” number would be misleading. Avoid double-counting usage already attributed to the same subscription by another collector.

Offer **Remind me later** on a blocked task as an explicit action. Keep agent tasks and personal reminders distinct: a temporary coding checklist should not automatically flood the OS reminder list. Store a link back to the project and session.

These are useful follow-on integrations after the attention panel works reliably.

## Preserve normal mode

Use one core with an integration preference conceptually equivalent to `auto`, `normal`, or `omarchy`; these are proposed configuration values, not existing flags.

| Behavior | Normal profile | Omarchy profile |
| --- | --- | --- |
| Coding, models, sessions, tasks, questions | Full functionality | Same functionality |
| Theme | App default or user selection | Follow OS by default, with override |
| Navigation | TUI and portable launch behavior | TUI plus optional desktop companion and menu |
| Notifications | Optional portable integration | Native Omarchy delivery |
| System workflows | Relevant installed skills | Omarchy skills when available |

Detect capabilities independently. A theme file demonstrates that a palette is available; it does not prove a live local Quickshell desktop exists. SSH, tmux, containers, and older Omarchy versions should retain a working TUI even when focusing windows or opening panels is unavailable.

## Architecture and plugin boundaries

Follow the existing thin-client architecture: all session state, questions, task transitions, permissions, and action validation belong in `apps/core`. The TUI and Quickshell plugin render state and send actions. Shared contracts belong in `packages/shared`.

There are two distinct extension types: Omarchy shell plugins provide desktop UI; FreeCode skills, hooks, and MCP tools extend the coding engine. Installing one should not implicitly grant capabilities to the other.

The desktop integration needs a new local transport because the existing stdin/stdout connection to a TUI process is not a ready-made multi-client desktop endpoint. Proposed design:

1. Each active core process registers a local endpoint and publishes a versioned session summary. A small desktop adapter discovers and aggregates those instances.
2. The companion gets an initial snapshot, then changes. Include instance ID, session ID, request ID, revision, and last-seen time so multiple projects cannot be confused.
3. Actions return to the owning core process, which validates current state and resolves each pending request once. Another client receives the resulting update.
4. On disconnect, show a disconnected session instead of “working”. On reconnect, refresh from a snapshot before accepting actions.
5. Start with a user-scoped local socket and private runtime files. Keep credentials and full transcripts out of bar status records. Local access is a user-account boundary, not a sandbox against arbitrary code running as that user.

New work includes the local transport, task snapshot/change contract, pending-request synchronization, and window association. Existing question methods and bus events are building blocks, not evidence that the complete companion already works.

Keep the first plugin small and user-installable through Omarchy's plugin mechanism. Use the supported third-party interface rather than reaching into private built-in services. A broader Omacode UI plugin platform can wait until several real integrations establish what extension points are needed.

## Suggested delivery order

| Stage | Deliverable | Done when |
| --- | --- | --- |
| 1: Native feel | ~~Live theme updates~~ (done), compact tile layout, menu launcher, targeted notifications | Theme changes repaint an active session; launch uses the selected project and terminal; normal mode still works. |
| 2: Desktop awareness | Companion with session list, waiting badge, and focus action | Two projects are distinguished correctly; a crashed process stops looking active; the correct terminal receives focus. |
| 3: Desktop interaction | Question answers and task view | Answering in either surface resolves the other; stale answers are rejected; reconnect restores the current task state. |
| 4: Workspace continuity | Editor/file handoff, preview URL, scratchpad, selected-context capture | A user can move from an OS entry point to the relevant session, file, or preview without reselecting the project. |
| 5: Ecosystem fit | Usage collector, default-agent proposal, OS workflows, reminder handoff | Each uses the OS's existing contract and has a clear behavior when its dependency is unavailable. |

The first signature demo should be: **start work in a terminal, switch workspaces, answer a question from the bar, then jump to the changed file in your editor.** Add a live theme switch during that flow. That demonstrates the sense of the whole OS participating more clearly than another decorative screen.

## Source map

FreeCode sources, relative to this document:

- [ASCII logo](../apps/tui/src/assets/logo.ts), [logo header](../apps/tui/src/components/logo-header.ts), [palette](../apps/tui/src/palette.ts), [Omarchy palette loader](../apps/tui/src/utils/omarchy-theme.ts), [activity chips](../apps/tui/src/components/mode-line.ts).
- [Task state and persistence](../apps/core/src/tools/todo.ts), [question tool](../apps/core/src/tools/question.ts), [bus bridge](../apps/core/src/bus/bridge.ts), [IPC protocol](../packages/shared/src/ipc/protocol.ts), [skill discovery](../apps/core/src/skills/loader.ts).
- [Architecture v4](specs/2026-05-25-architecture-v4.md). Its thin-client boundary informs this proposal; its historical implementation-status tables are not treated as a current inventory.

Omarchy sources below refer to the local checkout reviewed for this proposal. Its contracts may differ from other installed versions:

- [Welcome and philosophy](/home/ayan-de/Projects/githubProjects/omarchy/manual/01-welcome-to-omarchy.md), [keyboard navigation and scratchpad](/home/ayan-de/Projects/githubProjects/omarchy/manual/04-navigation.md), [theme behavior](/home/ayan-de/Projects/githubProjects/omarchy/manual/06-themes.md).
- [AI integration and skills](/home/ayan-de/Projects/githubProjects/omarchy/manual/17-ai.md), [shell plugin model](/home/ayan-de/Projects/githubProjects/omarchy/manual/32-shell-plugins.md), [agents usage panel](/home/ayan-de/Projects/githubProjects/omarchy/shell/plugins/agents/README.md).
- [Menu extension contract](/home/ayan-de/Projects/githubProjects/omarchy/docs/menu.md), [theme hook sample](/home/ayan-de/Projects/githubProjects/omarchy/config/omarchy/hooks/theme-set.d/show-theme-notification.sample), [notification command](/home/ayan-de/Projects/githubProjects/omarchy/bin/omarchy-notification-send).
- [Default-agent selection](/home/ayan-de/Projects/githubProjects/omarchy/bin/omarchy-default-agent), [agent launcher](/home/ayan-de/Projects/githubProjects/omarchy/bin/omarchy-agent).
