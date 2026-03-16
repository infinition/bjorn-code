import * as vscode from 'vscode';
import { ConnectionManager } from './core/ConnectionManager';
import { Logger } from './core/Logger';
import { getWorkspaceTarget } from './core/Config';

export class LiveLogsPanel {
    private static currentPanel: LiveLogsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposed = false;
    private stream: any;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly logger: Logger
    ) {
        this.panel = panel;

        this.panel.onDidDispose(() => {
            this.disposed = true;
            this.stopStream();
            LiveLogsPanel.currentPanel = undefined;
        });

        this.panel.webview.onDidReceiveMessage((msg) => {
            if (msg.command === 'clear') {
                this.panel.webview.postMessage({ command: 'clear' });
            } else if (msg.command === 'stop') {
                this.stopStream();
            } else if (msg.command === 'start') {
                void this.startStream(msg.service);
            }
        });
    }

    public static createOrShow(logger: Logger): LiveLogsPanel {
        if (LiveLogsPanel.currentPanel) {
            LiveLogsPanel.currentPanel.panel.reveal(vscode.ViewColumn.Two);
            return LiveLogsPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'bjornCodeLiveLogs',
            'Bjorn Live Logs',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        LiveLogsPanel.currentPanel = new LiveLogsPanel(panel, logger);
        LiveLogsPanel.currentPanel.panel.webview.html = LiveLogsPanel.getHtml();
        return LiveLogsPanel.currentPanel;
    }

    public async startStream(serviceName?: string): Promise<void> {
        this.stopStream();

        const target = getWorkspaceTarget();
        if (!target || !target.settings.enabled) {
            this.appendLine('[ERROR] Bjorn Code is disabled.');
            return;
        }

        const service = serviceName || target.settings.bjornServiceName;
        const manager = ConnectionManager.getOrCreate(
            {
                host: target.settings.host,
                port: target.settings.port,
                username: target.settings.username,
                remotePath: target.settings.remotePath
            },
            target.settings,
            this.logger
        );

        try {
            await manager.getSftp();
        } catch (err: any) {
            this.appendLine(`[ERROR] Cannot connect: ${err.message}`);
            return;
        }

        const client = (manager as any).conn?.client;
        if (!client) {
            this.appendLine('[ERROR] No SSH client.');
            return;
        }

        this.appendLine(`[INFO] Tailing logs for service: ${service}`);

        client.exec(`journalctl -f -u ${service} --no-pager -n 50`, (err: Error | undefined, stream: any) => {
            if (err) {
                this.appendLine(`[ERROR] ${err.message}`);
                return;
            }

            this.stream = stream;

            stream.on('data', (data: Buffer) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    if (line.trim()) {
                        this.appendLine(line);
                    }
                }
            });

            stream.stderr?.on('data', (data: Buffer) => {
                this.appendLine(`[STDERR] ${data.toString().trim()}`);
            });

            stream.on('close', () => {
                this.appendLine('[INFO] Log stream closed.');
                this.stream = undefined;
            });
        });
    }

    private stopStream(): void {
        if (this.stream) {
            this.stream.close();
            this.stream = undefined;
        }
    }

    private appendLine(text: string): void {
        if (!this.disposed) {
            this.panel.webview.postMessage({ command: 'append', text });
        }
    }

    private static getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    body {
        margin: 0;
        padding: 8px;
        font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
        font-size: 12px;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
    }
    #controls {
        display: flex;
        gap: 8px;
        margin-bottom: 8px;
        align-items: center;
    }
    #controls button {
        padding: 4px 12px;
        border: 1px solid var(--vscode-button-border, #444);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
        border-radius: 3px;
        font-size: 12px;
    }
    #controls button:hover {
        background: var(--vscode-button-hoverBackground);
    }
    #controls input {
        padding: 4px 8px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #444);
        border-radius: 3px;
        font-size: 12px;
    }
    #log {
        white-space: pre-wrap;
        word-break: break-all;
        overflow-y: auto;
        height: calc(100vh - 60px);
        padding: 4px;
        border: 1px solid var(--vscode-panel-border, #333);
        border-radius: 3px;
    }
    .line-error { color: #f44747; }
    .line-warn { color: #cca700; }
    .line-info { color: #3dc9b0; }
    .line-debug { color: #888; }
</style>
</head>
<body>
<div id="controls">
    <input id="serviceInput" placeholder="bjorn" value="bjorn" />
    <button onclick="startStream()">Start</button>
    <button onclick="stopStream()">Stop</button>
    <button onclick="clearLog()">Clear</button>
    <span id="status" style="color: var(--vscode-descriptionForeground)">Idle</span>
</div>
<div id="log"></div>
<script>
    const vscode = acquireVsCodeApi();
    const logEl = document.getElementById('log');
    const statusEl = document.getElementById('status');
    let autoScroll = true;

    logEl.addEventListener('scroll', () => {
        autoScroll = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
    });

    function startStream() {
        const service = document.getElementById('serviceInput').value.trim() || 'bjorn';
        vscode.postMessage({ command: 'start', service });
        statusEl.textContent = 'Streaming...';
    }

    function stopStream() {
        vscode.postMessage({ command: 'stop' });
        statusEl.textContent = 'Stopped';
    }

    function clearLog() {
        logEl.innerHTML = '';
    }

    function classifyLine(text) {
        const lower = text.toLowerCase();
        if (lower.includes('error') || lower.includes('exception') || lower.includes('failed') || lower.includes('critical')) return 'line-error';
        if (lower.includes('warn')) return 'line-warn';
        if (lower.includes('debug')) return 'line-debug';
        if (lower.includes('info')) return 'line-info';
        return '';
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.command === 'append') {
            const span = document.createElement('div');
            span.className = classifyLine(msg.text);
            span.textContent = msg.text;
            logEl.appendChild(span);
            // Keep max 5000 lines
            while (logEl.childElementCount > 5000) {
                logEl.removeChild(logEl.firstChild);
            }
            if (autoScroll) {
                logEl.scrollTop = logEl.scrollHeight;
            }
        } else if (msg.command === 'clear') {
            logEl.innerHTML = '';
        }
    });
</script>
</body>
</html>`;
    }
}
