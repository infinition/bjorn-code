<img width="128" height="128" alt="Bjorn Code" src="https://github.com/user-attachments/assets/b2e2e2ba-e4b3-4b3c-ba8a-a6b9f7566c88" />

# Bjorn Code

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) ![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white) [![Release](https://img.shields.io/github/v/release/infinition/bjorn-code?style=flat)](https://github.com/infinition/bjorn-code/releases) [![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/infinition)


A VS Code extension for bi-directional file synchronization between a local workspace and a remote host over SSH/SFTP. Built for remote development workflows where you edit locally and need changes on a Raspberry Pi or Linux server instantly.

Available on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nephystos.bjorn-code).

---

## Features

- Persistent SSH/SFTP connection with automatic reconnect and exponential backoff.
- Auto-sync on save with debounce and a bounded-concurrency transfer queue.
- Bi-directional sync: push local changes to remote or pull remote changes to local.
- Conflict detection: creates conflict artifacts for manual resolution when both sides change.
- Activity Bar sidebar with connection status, sync queue, workspace browser, and remote file browser.
- Drag-and-drop import into the workspace tree with auto-upload.
- SSH password or private key authentication.
- Run Python scripts remotely, manage systemd services, open SSH terminals, tail live logs.
- Diff any local file against its remote version using VS Code's built-in diff editor.
- Include/exclude globs with `mirror` or `selective` sync mode.
- Master toggle to enable or disable sync globally.

---

## Installation

Open the Extensions view (`Ctrl+Shift+X`), search for **Bjorn Code**, and click Install.

---

## Configuration

Set these in `settings.json` or via the extension settings UI:

| Setting | Default | Description |
|---------|---------|-------------|
| `bjornCode.enabled` | `false` | Master sync switch |
| `bjornCode.remoteIp` | `192.168.1.15` | Remote machine IP |
| `bjornCode.port` | `22` | SSH port |
| `bjornCode.username` | `bjorn` | SSH username |
| `bjornCode.password` | `""` | SSH password (or use key) |
| `bjornCode.remotePath` | `/home/bjorn` | Remote base path |

---

## Commands

Available from the Command Palette (`Ctrl+Shift+P`):

- Push to Remote / Pull from Remote
- Toggle Connection
- Sync This File or Folder (context menu)
- Download Remote Version
- Compare with Remote
- Add to Sync Scope / Exclude from Sync
- Run Python File Remotely

---

## Remote Tools (sidebar)

- SSH Terminal
- Restart Bjorn service
- Reboot Pi
- Service Status
- Tail Service Logs
- Live Logs Panel

---

## Development

```bash
git clone https://github.com/infinition/bjorn-code.git
cd bjorn-code
npm install
npm run compile
# Press F5 in VS Code to launch with the extension loaded
```

---

## Star History

<a href="https://www.star-history.com/?repos=infinition%2Fbjorn-code&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=infinition/bjorn-code&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=infinition/bjorn-code&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=infinition/bjorn-code&type=date&legend=top-left" />
 </picture>
</a>

---

## License

MIT. See [LICENSE](LICENSE).
