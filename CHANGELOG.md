# Changelog

All notable changes to the "Bjorn Code" extension will be documented in this file.

## [2.0.0] - 2026-03-16

### Changed
- Renamed extension from "Acid Bjorn" to "Bjorn Code".
- All configuration keys now use the `bjornCode.*` prefix.
- All command IDs now use the `bjorn-code.*` prefix.
- Managed workspace directory renamed from `.acid-bjorn` to `.bjorn-code`.

### Added
- Sync Engine v2: persistent SSH/SFTP connection, bounded-concurrency transfer queue, retries with exponential backoff.
- Conflict detection with local/remote artifact creation.
- Remote file browser in the sidebar.
- Drag & drop file import with auto-upload.
- Diff with Remote: compare local files against their remote version.
- Live Logs Panel: real-time journalctl streaming in a webview.
- SSH Terminal: interactive pseudo-terminal over ssh2.
- Reboot Pi command with auto-reconnect.
- Service management commands (start, stop, restart, status, enable, disable, tail).
- File decoration badges (Synced, Pending, Modified, Error).
- State-specific connection indicator icons in the sidebar title bar.

## [0.0.1] - 2026-01-19

### Added
- Initial release.
- Bi-directional synchronization via SSH.
- Auto-sync on file save.
- Activity bar sidebar for sync controls.
- Status bar toggle for extension state.
- Support for SSH password and private key authentication.
- Configurable exclusion list.
