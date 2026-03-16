<img width="128" height="128" alt="Bjorn Code" src="https://github.com/user-attachments/assets/b2e2e2ba-e4b3-4b3c-ba8a-a6b9f7566c88" />

# Bjorn Code

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/nephystos.bjorn-code.svg)](https://marketplace.visualstudio.com/items?itemName=nephystos.bjorn-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Bjorn Code** is a VS Code extension for bi-directional file synchronization between your local workspace and a remote host over SSH/SFTP. It is designed for seamless remote development workflows — edit locally, sync instantly to a Raspberry Pi or any Linux server.

## Features

- **Sync Engine v2**: Persistent SSH/SFTP connection with automatic reconnect, retries with exponential backoff, debounced auto-sync, and a bounded-concurrency transfer queue.
- **Bi-directional Sync**: Push local changes to remote or pull remote changes to local.
- **Auto-Sync on Save**: Automatically push changes on file save (debounced, configurable).
- **Conflict Detection**: Detects concurrent edits and creates conflict artifacts for manual resolution.
- **Activity Bar Sidebar**: Dedicated panel for connection status, sync queue, workspace browser, remote file browser, and remote tools.
- **Drag & Drop Import**: Drag files or folders into the workspace tree to import and auto-upload.
- **SSH Support**: Password or private key authentication with persistent session handling.
- **Remote Dev Tools**: Run Python scripts remotely, manage systemd services, open SSH terminals, and tail live logs.
- **Diff with Remote**: Compare any local file against its remote version using VS Code's built-in diff editor.
- **Scope Control**: Include/exclude globs with `mirror` or `selective` sync mode.
- **Master Toggle**: Enable or disable synchronization globally with a single click.

## Installation

1. Open **VS Code**.
2. Go to the **Extensions** view (`Ctrl+Shift+X`).
3. Search for **Bjorn Code**.
4. Click **Install**.

## Configuration

Configure Bjorn Code in your VS Code settings (`settings.json`) or via the extension's settings UI:

| Setting | Default | Description |
|---------|---------|-------------|
| `bjornCode.enabled` | `false` | Master switch to enable/disable synchronization. |
| `bjornCode.remoteIp` | `192.168.1.15` | IP address of the remote machine. |
| `bjornCode.port` | `22` | SSH port. |
| `bjornCode.username` | `bjorn` | SSH username. |
| `bjornCode.password` | `bjorn` | SSH password (if not using private key). |
| `bjornCode.privateKeyPath` | `~/.ssh/id_rsa` | Path to your private SSH key. |
| `bjornCode.remotePath` | `/home/bjorn/Bjorn` | Target path on the remote machine. |
| `bjornCode.localPath` | `""` | Local path to sync. If empty, auto-creates `.bjorn-code/Bjorn_YYYYMMDD_HHMMSS` inside the workspace. |
| `bjornCode.autoSync` | `true` | Enable automatic sync on file change. |
| `bjornCode.exclusions` | `[...]` | List of files/directories to exclude. |
| `bjornCode.includes` | `["**/*"]` | Include globs used by selective mode. |
| `bjornCode.syncMode` | `"mirror"` | `mirror` (all files) or `selective` (only matching includes). |
| `bjornCode.maxConcurrency` | `3` | Maximum parallel transfers. |
| `bjornCode.maxRetries` | `3` | Retries per transfer job. |
| `bjornCode.connectTimeoutMs` | `20000` | SSH connect timeout in milliseconds. |
| `bjornCode.operationTimeoutMs` | `30000` | SFTP operation timeout in milliseconds. |
| `bjornCode.pollingIntervalSec` | `10` | Polling interval for remote change detection (seconds). |
| `bjornCode.pythonPath` | `/usr/bin/python3` | Remote Python interpreter path. |
| `bjornCode.sudoByDefault` | `false` | Use sudo by default for remote commands. |
| `bjornCode.services` | `[]` | List of systemd services for service commands. |
| `bjornCode.logLevel` | `"info"` | Log verbosity level (`debug`, `info`, `warn`, `error`). |
| `bjornCode.bjornServiceName` | `"bjorn"` | Name of the systemd service for quick restart. |

## Usage

### Sync Controls

Access the **Bjorn Code** icon in the Activity Bar to:
- **Push to Remote**: Manually push local changes (incremental or full scan).
- **Pull from Remote**: Fetch the latest changes from the remote server.
- **Toggle Connection**: Connect or disconnect the SSH session.
- **Open Settings**: Quickly access the extension configuration.

### Explorer Context Actions
- **Bjorn Code: Sync This File/Folder** — Push a specific file or folder.
- **Bjorn Code: Download Remote Version** — Pull a specific file from remote.
- **Bjorn Code: Compare with Remote** — Diff local vs. remote.
- **Bjorn Code: Add to Sync Scope (include)** — Add a path to the include list.
- **Bjorn Code: Exclude from Sync** — Add a path to the exclusion list.
- **Bjorn Code: Run Python File Remotely** — Execute a Python script on the remote host.

### Remote Tools

Available in the sidebar under **Remote Tools**:
- **Run Python** — Execute the active Python file on the remote host.
- **SSH Terminal** — Open an interactive SSH terminal.
- **Restart Bjorn** — Restart a configured systemd service.
- **Reboot Pi** — Reboot the remote machine.
- **Service Status** — Check systemd service status.
- **Tail Service Logs** — Stream journalctl output.
- **Live Logs Panel** — Real-time log viewer in a webview panel.

### Status Bar

The status bar shows the current connection state with a quick-action menu for common operations.

## Development

To build and run the extension locally:

1. Clone the repository.
2. Run `npm install` to install dependencies.
3. Run `npm run compile` to build the extension.
4. Press `F5` in VS Code to open a new window with the extension loaded.

## License

This project is licensed under the [MIT License](https://github.com/infinition/BjornCode/blob/main/LICENSE).
