# Local Codex history

This fork adds **Codex on this computer** to the side panel's **History** tab. Connect the
extension to Browsentic Bridge, open History, and select a saved Codex chat. Send a message
to continue its original thread on the current browser tab. **Load more** pages through older
chats. Removing its browser-side entry does not delete the original Codex thread.

The Bridge reads the Codex installation's own history through `codex app-server`. Listing and
reading do not invoke the model, resume a thread, or run tools. Only text from user and assistant
messages is displayed; command outputs, reasoning, attachment bytes, and local paths are omitted.
The display includes at most the latest 200 text messages, each limited to 50,000 characters.
The original thread retains its full context independently of this display limit.

History access is limited to the paired extension's side panel. Content scripts, normal web
pages, and agent/MCP tools have no history-read operation. No transcript is uploaded to GitHub
or to a Browsentic service. The displayed copy is kept in the extension's local storage.

Continuing a desktop thread uses the contained `codex exec resume` runner because Codex's
dynamic tool list is fixed when a thread is created. Browsentic adds its own gated browser MCP
tools and keeps the shell, image viewer, external MCPs, connector apps, and local file writes
disabled. The default Codex app-server transport is retained for new Browsentic conversations.
Model, reasoning effort, and numeric context-window settings are carried over from Codex's
top-level configuration; its hooks, permissions, and external MCP configuration are not.

Keep the same conversation idle in other Codex clients while continuing it here. Browser
actions remain subject to Browsentic's approval policy. Page text remains untrusted even when
the conversation started in Codex.
