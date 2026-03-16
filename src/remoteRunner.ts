import * as vscode from 'vscode';
import { getWorkspaceTarget } from './core/Config';
import { ConnectionManager } from './core/ConnectionManager';
import { Logger } from './core/Logger';

function shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class RemoteRunner {
    constructor(private readonly output: vscode.OutputChannel, private readonly logger: Logger) {}

    private getManager(): { manager: ConnectionManager; target: ReturnType<typeof getWorkspaceTarget> } | undefined {
        const target = getWorkspaceTarget();
        if (!target || !target.settings.enabled) {
            vscode.window.showWarningMessage('Acid Bjorn is disabled.');
            return undefined;
        }

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

        return { manager, target };
    }

    public async runPython(resource?: vscode.Uri): Promise<void> {
        const ctx = this.getManager();
        if (!ctx) {
            return;
        }
        const { manager, target } = ctx;

        const editor = vscode.window.activeTextEditor;
        const fileUri = resource ?? editor?.document.uri;
        if (!fileUri) {
            vscode.window.showWarningMessage('No file selected to run remotely.');
            return;
        }

        const relativePath = vscode.workspace.asRelativePath(fileUri, false).replace(/\\/g, '/');
        const remoteFile = `${target!.settings.remotePath}/${relativePath}`;

        const argsInput = await vscode.window.showInputBox({
            prompt: 'Python arguments',
            placeHolder: '--flag value',
            value: ''
        });
        if (argsInput === undefined) {
            return;
        }

        // Use sudoByDefault setting as default choice
        const defaultSudo = target!.settings.sudoByDefault;
        const sudoChoice = await vscode.window.showQuickPick(
            defaultSudo
                ? ['Use sudo (default)', 'No sudo']
                : ['No sudo (default)', 'Use sudo'],
            { placeHolder: 'Execution mode' }
        );
        if (!sudoChoice) {
            return;
        }
        const useSudo = sudoChoice.startsWith('Use sudo');

        // Escape each argument individually to prevent injection
        const escapedArgs = argsInput.trim().length > 0
            ? ' ' + argsInput.trim().split(/\s+/).map(shellEscape).join(' ')
            : '';
        const baseCmd = `${shellEscape(target!.settings.pythonPath)} ${shellEscape(remoteFile)}${escapedArgs}`;
        const cmd = useSudo ? `sudo -n ${baseCmd}` : baseCmd;

        await manager.getSftp();

        const terminal = vscode.window.createTerminal({
            name: 'Acid Bjorn Remote Python'
        });
        terminal.show(true);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Acid Bjorn: Running Python remotely',
                cancellable: false
            },
            async () => {
                const result = await manager.execStreaming(
                    cmd,
                    target!.settings.operationTimeoutMs,
                    (stdoutChunk) => {
                        const text = stdoutChunk.replace(/\r?\n$/, '');
                        if (text.length > 0) {
                            this.output.appendLine(text);
                            terminal.sendText(`echo ${shellEscape(text)}`, true);
                        }
                    },
                    (stderrChunk) => {
                        const text = stderrChunk.replace(/\r?\n$/, '');
                        if (text.length > 0) {
                            this.output.appendLine(text);
                            terminal.sendText(`echo ${shellEscape(text)}`, true);
                        }
                    }
                );

                if ((result.code ?? 1) !== 0) {
                    vscode.window.showErrorMessage('Acid Bjorn: Remote Python execution failed.', 'Open Output Logs').then((action) => {
                        if (action === 'Open Output Logs') {
                            this.output.show(true);
                        }
                    });
                    return;
                }

                vscode.window.showInformationMessage('Acid Bjorn: Remote Python execution completed.');
            }
        );
    }

    public async runServiceAction(action: 'start' | 'stop' | 'restart' | 'status' | 'enable' | 'disable' | 'tail'): Promise<void> {
        const ctx = this.getManager();
        if (!ctx) {
            return;
        }
        const { manager, target } = ctx;

        const services = target!.settings.services;
        if (services.length === 0) {
            vscode.window.showWarningMessage('Configure acidBjorn.services first.');
            return;
        }

        const selected = services.length === 1
            ? services[0]
            : await vscode.window.showQuickPick(services, { placeHolder: 'Select service' });
        if (!selected) {
            return;
        }

        await manager.getSftp();

        const command = action === 'tail'
            ? `journalctl -fu ${shellEscape(selected)}`
            : `sudo -n systemctl ${action} ${shellEscape(selected)}`;

        let stdout = '';
        let stderr = '';
        const result = await manager.execStreaming(
            command,
            action === 'tail' ? 120000 : target!.settings.operationTimeoutMs,
            (chunk) => {
                stdout += chunk;
                const text = chunk.replace(/\r?\n$/, '');
                if (text.length > 0) {
                    this.output.appendLine(text);
                }
            },
            (chunk) => {
                stderr += chunk;
                const text = chunk.replace(/\r?\n$/, '');
                if (text.length > 0) {
                    this.output.appendLine(text);
                }
            }
        );

        if ((result.code ?? 1) !== 0) {
            vscode.window.showErrorMessage(`Acid Bjorn: Service ${action} failed for ${selected}.`, 'Open Output Logs').then((choice) => {
                if (choice === 'Open Output Logs') {
                    this.output.show(true);
                }
            });
            return;
        }

        if (stdout.trim().length > 0 || stderr.trim().length > 0) {
            this.logger.debug(`Service ${action} output captured for ${selected}`);
        }
        vscode.window.showInformationMessage(`Acid Bjorn: Service ${selected} ${action} done.`);
    }

    /**
     * Restart the Bjorn service specifically (quick action button).
     */
    public async restartBjornService(): Promise<void> {
        const ctx = this.getManager();
        if (!ctx) {
            return;
        }
        const { manager, target } = ctx;

        const serviceName = target!.settings.bjornServiceName;
        await manager.getSftp();

        const confirm = await vscode.window.showWarningMessage(
            `Restart service "${serviceName}" on ${target!.settings.host}?`,
            { modal: false },
            'Restart'
        );
        if (confirm !== 'Restart') {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Acid Bjorn: Restarting ${serviceName}...`,
                cancellable: false
            },
            async () => {
                const result = await manager.withExec(
                    `sudo -n systemctl restart ${shellEscape(serviceName)}`,
                    target!.settings.operationTimeoutMs
                );
                if ((result.code ?? 1) !== 0) {
                    this.logger.error(`Restart ${serviceName} failed: ${result.stderr}`);
                    vscode.window.showErrorMessage(`Acid Bjorn: Failed to restart ${serviceName}. ${result.stderr.trim()}`);
                } else {
                    vscode.window.showInformationMessage(`Acid Bjorn: ${serviceName} restarted.`);
                }
            }
        );
    }

    /**
     * Reboot the Raspberry Pi.
     */
    public async rebootPi(): Promise<void> {
        const ctx = this.getManager();
        if (!ctx) {
            return;
        }
        const { manager, target } = ctx;

        await manager.getSftp();

        const confirm = await vscode.window.showWarningMessage(
            `REBOOT ${target!.settings.host}? The Pi will go offline for ~30-60 seconds.`,
            { modal: true },
            'Reboot Now'
        );
        if (confirm !== 'Reboot Now') {
            return;
        }

        try {
            // Send reboot command — connection will drop immediately
            await manager.withExec('sudo -n reboot', 5000).catch(() => {
                // Expected: connection drops on reboot
            });

            vscode.window.showInformationMessage('Acid Bjorn: Reboot command sent. Waiting for Pi to come back...');

            // Wait and attempt reconnect
            await new Promise<void>((resolve) => setTimeout(resolve, 15000));

            let reconnected = false;
            for (let attempt = 0; attempt < 10; attempt++) {
                try {
                    // Create a fresh connection since the old one is dead
                    const freshManager = ConnectionManager.getOrCreate(
                        {
                            host: target!.settings.host,
                            port: target!.settings.port,
                            username: target!.settings.username,
                            remotePath: target!.settings.remotePath
                        },
                        target!.settings,
                        this.logger
                    );
                    await freshManager.getSftp();
                    reconnected = true;
                    break;
                } catch {
                    await new Promise<void>((resolve) => setTimeout(resolve, 5000));
                }
            }

            if (reconnected) {
                vscode.window.showInformationMessage('Acid Bjorn: Pi is back online!');
            } else {
                vscode.window.showWarningMessage('Acid Bjorn: Pi has not come back yet. Try reconnecting manually.');
            }
        } catch (err: any) {
            this.logger.error(`Reboot error: ${err.message}`);
        }
    }

    /**
     * Open an SSH terminal (pseudo-terminal piped through ssh2).
     */
    public async openSshTerminal(): Promise<void> {
        const ctx = this.getManager();
        if (!ctx) {
            return;
        }
        const { manager, target } = ctx;

        await manager.getSftp();

        const client = (manager as any).conn?.client;
        if (!client) {
            vscode.window.showErrorMessage('Acid Bjorn: No SSH client available.');
            return;
        }

        const writeEmitter = new vscode.EventEmitter<string>();
        const closeEmitter = new vscode.EventEmitter<number | void>();

        let shellStream: any;

        const pty: vscode.Pseudoterminal = {
            onDidWrite: writeEmitter.event,
            onDidClose: closeEmitter.event,
            open: (initialDimensions) => {
                const cols = initialDimensions?.columns ?? 80;
                const rows = initialDimensions?.rows ?? 24;

                client.shell({ term: 'xterm-256color', cols, rows }, (err: Error | undefined, stream: any) => {
                    if (err) {
                        writeEmitter.fire(`Error: ${err.message}\r\n`);
                        closeEmitter.fire(1);
                        return;
                    }

                    shellStream = stream;

                    stream.on('data', (data: Buffer) => {
                        writeEmitter.fire(data.toString());
                    });

                    stream.stderr?.on('data', (data: Buffer) => {
                        writeEmitter.fire(data.toString());
                    });

                    stream.on('close', () => {
                        closeEmitter.fire(0);
                    });
                });
            },
            close: () => {
                if (shellStream) {
                    shellStream.end();
                    shellStream = undefined;
                }
            },
            handleInput: (data: string) => {
                if (shellStream) {
                    shellStream.write(data);
                }
            },
            setDimensions: (dimensions: vscode.TerminalDimensions) => {
                if (shellStream && shellStream.setWindow) {
                    shellStream.setWindow(dimensions.rows, dimensions.columns, 0, 0);
                }
            }
        };

        const terminal = vscode.window.createTerminal({
            name: `SSH ${target!.settings.username}@${target!.settings.host}`,
            pty
        });
        terminal.show();
    }
}
