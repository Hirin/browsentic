# Local Codex projects and history

Connect the extension to Browsentic Bridge and choose a saved **Codex project** above the
chat. The choices come from the local Codex project catalog, with the same native project IDs
and folders used by Codex desktop. **History → Codex on this computer** lists chats for the
selected project. Open one to continue its original thread on the current browser tab, or start
a new chat in that project. **Load more** pages through older chats. Removing a browser-side
history entry does not delete the original Codex thread. **No project · browser only** starts
without local file tools. Create or register additional projects in Codex desktop first.

The agent can list folders, read UTF-8 text files, and propose line edits within the selected
project. Every edit shows its actual folder, path, line range, and before/after preview in the
extension. **Allow** writes only that prepared change. Approval is never remembered for future
file edits. If the file changes before approval, the agent must read it and propose a new edit.
Changing projects starts a fresh browser chat; an existing chat keeps its own project.

## Full access

The **Permissions** picker below the project offers **Review edits** (the default) and **Full
access**. Full access enables native Codex file tools, shell commands and network access without
per-action approval. The project is the initial working folder, not a filesystem boundary: native
tools can access files outside it under the current OS account. Workspace patches run immediately
and browser actions skip confirmation, while actions explicitly denied by browser policy remain
blocked. The scoped text tools retain their path, file-size and revision checks; native Codex tools
provide broader access. External MCP servers and apps/plugins stay disabled in the runner.

Select Full access explicitly in the side panel before sending a message. It applies to that turn,
does not modify global Codex settings. The extension does not restore the permission choice from
chat history, and scheduled, timer, phone or in-page runs cannot inherit it. The picker resets to Review edits when the panel reopens or its
project changes. Switching back applies read-only native permissions on the next turn, even in a
chat previously run with Full access; project edits then require approval again. A running turn
keeps the mode it started with, and the picker is disabled until it finishes or is cancelled.

The following scoped-file and approval boundaries describe **Review edits**. Prompt injection
still matters in Full access: the model has broad local capabilities, so approving that mode gives
untrusted page or repository text more opportunity to affect the machine if the model follows it.
See [OpenAI's permissions documentation](https://learn.chatgpt.com/docs/sandboxing).

Files are the same files on disk, so approved changes are immediately available to local tools.
Chats share their persisted native identity. **Sync chat** refreshes the text saved by another
Codex client; the extension also refreshes an idle Codex chat when its window regains focus.
Reopen or refresh the chat in desktop to load messages saved from the browser. This is not a
shared live model process: keep the same chat idle in other clients while a turn runs here.

The Bridge reads the Codex installation's own history through `codex app-server`. Listing and
reading do not invoke the model, resume a thread, or run tools. Only text from user and assistant
messages is displayed; command outputs, reasoning and attachment bytes are omitted. Project
labels and workspace paths are shown so the user can verify the selected folder.
The display includes at most the latest 200 text messages, each limited to 50,000 characters.
The original thread retains its full context independently of this display limit.

History access is limited to the paired extension's side panel. Content scripts, normal web
pages, and agent/MCP tools have no history-read operation. Project instructions, transcript
replay, synchronization and positive edit approvals require the extension's own UI; project
responses are not forwarded to in-page controls. No transcript is uploaded to GitHub
or to a Browsentic service. The displayed copy is kept in the extension's local storage.

Continuing a desktop thread uses the contained `codex exec resume` runner because Codex's
dynamic tool list is fixed when a thread is created. Browsentic adds its own gated browser MCP
tools and keeps the shell, image viewer, external MCPs and connector apps disabled. Project
file operations go through the Bridge's scoped tools rather than native shell commands. The
default Codex app-server transport is retained for new conversations and assigns their native
project ID and working folder. Project-scoped external MCP configurations are disabled too.
Model, reasoning effort, and numeric context-window settings are carried over from Codex's
top-level configuration; its hooks, permissions, and external MCP configuration are not.

File tools resolve their roots from native project metadata on the server, not an agent-supplied
absolute path. Parent traversal, symlinks, credential filenames, repository internals and
dependency folders are refused. A chat's Git worktree is accepted only when its repository and
selected subdirectory match the saved project. Text files are limited to 1 MiB, reads to 500
lines and 128 KiB, and patch previews to 128 KiB. Writes are atomic and check the original
SHA-256 revision again after approval. Scheduled and phone runs have no project file mode.

Workspace tools are offered only to a validated project run. External MCP clients cannot
acquire them through the ordinary browser tool list. Workspace results are always marked as
untrusted data, even when page fencing is disabled; recognizable credentials are masked.
Browser actions remain subject to Browsentic's approval policy. Page and repository text
remain untrusted, and cannot authorize another task or a file edit. These boundaries reduce
the impact of prompt injection; they do not establish that every injection will be detected.
