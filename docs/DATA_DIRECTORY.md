# Local Data Directory

Orbit is local-first. It stores product data on your machine under `~/.orbit`
and does not require a hosted service for workspaces, conversations, messages,
agent configuration, attachments, sessions, or terminal transcripts.

On Windows, the directory is usually:

```text
C:\Users\<you>\.orbit
```

On macOS and Linux, the directory is usually:

```text
/Users/<you>/.orbit
/home/<you>/.orbit
```

Orbit creates this directory when it first needs to persist local data. If it
does not exist yet, start Orbit once and create a workspace.

## What Is Stored

The data directory is organized by data type and workspace id:

```text
~/.orbit/
  workspaces/<workspace-id>/workspace.json
  workspaces/<workspace-id>/agents.json
  workspaces/<workspace-id>/config.json
  conversations/<workspace-id>/conversations.json
  conversations/<workspace-id>/<conversation-id>/messages/manifest.json
  conversations/<workspace-id>/<conversation-id>/messages/<YYYY-MM-DD>.ndjson
  sessions/<workspace-id>/<runtime>/<channel-id>/<conversation-id>/<agent-id>.json
  transcripts/<workspace-id>/<conversation-id>/<agent-id>/<YYYY-MM-DD>-<sequence>.log
  last-active.json
```

These files can contain project paths, conversation content, uploaded
attachments, digital employee configuration, CLI session identifiers, runtime
activity, and terminal output. Treat `~/.orbit` as private user data.

Orbit does not copy your source repository into `~/.orbit`; workspace metadata
stores a pointer to the project path.

## Back Up Data

Stop Orbit before copying the data directory so message shards, transcripts,
and configuration files are not changing while the backup is made.

Windows PowerShell:

```powershell
Copy-Item -Recurse -Force "$HOME\.orbit" "$HOME\orbit-backup"
```

macOS or Linux:

```bash
cp -a "$HOME/.orbit" "$HOME/orbit-backup"
```

For a release candidate, keep the backup until you have confirmed that the new
version starts, lists your workspaces, opens recent conversations, and can run a
small test task.

## Restore Data

Stop Orbit, then replace `~/.orbit` with the backup copy.

Windows PowerShell:

```powershell
Rename-Item "$HOME\.orbit" "$HOME\.orbit.before-restore"
Copy-Item -Recurse -Force "$HOME\orbit-backup" "$HOME\.orbit"
```

macOS or Linux:

```bash
mv "$HOME/.orbit" "$HOME/.orbit.before-restore"
cp -a "$HOME/orbit-backup" "$HOME/.orbit"
```

Start Orbit again and confirm the expected workspace and conversation appear.
If the restored data is not correct, stop Orbit and move
`~/.orbit.before-restore` back to `~/.orbit`.

## Delete Or Reset Local Data

Stop Orbit before deleting data.

To reset all Orbit local data, delete `~/.orbit`. This removes all Orbit
workspace metadata, conversations, messages, agent settings, uploaded
attachments, session records, and terminal transcripts. It does not delete your
source repositories.

To remove one workspace from the UI, use the workspace delete action in Orbit.
Deleting a workspace removes that workspace's Orbit metadata, conversations,
sessions, attachments, and transcripts from `~/.orbit`, but it does not delete
the project directory itself.

To remove one conversation, use the conversation delete action in Orbit. This
removes the conversation metadata, messages, attachments, sessions, and
transcripts for that conversation.

## Release Verification

Before Orbit 1.0, verify the local data directory behavior in the release
checklist:

- Ordinary restarts preserve messages, sessions, workspace config, agent
  config, attachments, and terminal transcripts.
- Failed startup does not corrupt `~/.orbit`.
- Crash or kill during running and queued work does not leave tasks permanently
  stuck after restart.
- Deleting a workspace or conversation removes only the intended Orbit data and
  does not delete the source repository.
