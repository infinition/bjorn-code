import * as vscode from 'vscode';
import * as path from 'path';
import { SyncEngine } from './syncEngine';
import { BjornTreeDataProvider, BjornFileItem, SyncStatus } from './treeDataProvider';
import { Logger } from './core/Logger';
import { RemoteRunner } from './remoteRunner';
import { getWorkspaceTarget } from './core/Config';
import { BjornFileDecorationProvider } from './fileDecorations';
import { ConnectionManager } from './core/ConnectionManager';
import { LiveLogsPanel } from './liveLogsPanel';

let syncEngine: SyncEngine;
let statusBarItem: vscode.StatusBarItem;
let treeDataProvider: BjornTreeDataProvider;

function resolveResourceArg(arg: unknown): vscode.Uri | undefined {
    if (!arg) {
        return undefined;
    }
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    if (arg instanceof BjornFileItem) {
        return arg.resourceUri;
    }
    if (typeof arg === 'object' && arg !== null && 'resourceUri' in arg) {
        const value = (arg as { resourceUri?: vscode.Uri }).resourceUri;
        if (value instanceof vscode.Uri) {
            return value;
        }
    }
    return undefined;
}

async function resolveFolderFromArg(arg: unknown): Promise<vscode.Uri | undefined> {
    const candidate = resolveResourceArg(arg) ?? vscode.Uri.file(getWorkspaceTarget()?.workspaceRoot ?? '');
    if (!candidate.fsPath) {
        return undefined;
    }
    try {
        const stat = await vscode.workspace.fs.stat(candidate);
        if (stat.type & vscode.FileType.Directory) {
            return candidate;
        }
        return vscode.Uri.file(path.dirname(candidate.fsPath));
    } catch {
        return undefined;
    }
}

function statusConfig(state: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'SYNCING' | 'ERROR', enabled: boolean): {
    text: string;
    color?: vscode.ThemeColor;
    tooltip: string;
} {
    if (!enabled) {
        return {
            text: '$(circle-slash) Bjorn Code: Disabled',
            color: new vscode.ThemeColor('disabledForeground'),
            tooltip: 'Bjorn Code disabled'
        };
    }

    switch (state) {
        case 'CONNECTED':
            return {
                text: '$(circle-filled) Bjorn Code: Connected',
                color: new vscode.ThemeColor('testing.iconPassed'),
                tooltip: 'Connected and idle'
            };
        case 'SYNCING':
            return {
                text: '$(sync~spin) Bjorn Code: Syncing',
                color: new vscode.ThemeColor('charts.blue'),
                tooltip: 'Syncing / transferring'
            };
        case 'CONNECTING':
            return {
                text: '$(sync~spin) Bjorn Code: Connecting',
                color: new vscode.ThemeColor('charts.yellow'),
                tooltip: 'Connecting'
            };
        case 'ERROR':
            return {
                text: '$(error) Bjorn Code: Error',
                color: new vscode.ThemeColor('testing.iconFailed'),
                tooltip: 'Connection error'
            };
        default:
            return {
                text: '$(debug-disconnect) Bjorn Code: Offline',
                color: new vscode.ThemeColor('charts.red'),
                tooltip: 'Disconnected'
            };
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel('Bjorn Code');
    const logger = new Logger(outputChannel);

    // Apply log level from settings
    const initialTarget = getWorkspaceTarget();
    if (initialTarget) {
        logger.setLevel(initialTarget.settings.logLevel);
    }

    const workspaceRoot = initialTarget?.workspaceRoot;

    treeDataProvider = new BjornTreeDataProvider(workspaceRoot);
    const treeView = vscode.window.createTreeView('bjornCodeExplorer', {
        treeDataProvider,
        dragAndDropController: treeDataProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);
    const fileDecorationProvider = new BjornFileDecorationProvider(treeDataProvider);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(fileDecorationProvider));

    syncEngine = new SyncEngine(outputChannel, treeDataProvider);
    const remoteRunner = new RemoteRunner(outputChannel, logger);

    outputChannel.appendLine('Bjorn Code activated');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'bjorn-code.statusActions';
    statusBarItem.show();

    const refreshStatusBar = () => {
        const enabled = vscode.workspace.getConfiguration('bjornCode').get<boolean>('enabled', false);
        void vscode.commands.executeCommand('setContext', 'bjornCode.enabled', enabled);
        void vscode.commands.executeCommand('setContext', 'bjornCode.connected', syncEngine.connectionState === 'CONNECTED' || syncEngine.connectionState === 'SYNCING' || syncEngine.connectionState === 'CONNECTING');
        void vscode.commands.executeCommand('setContext', 'bjornCode.state', syncEngine.connectionState.toLowerCase());
        const ui = statusConfig(syncEngine.connectionState, enabled);
        statusBarItem.text = ui.text;
        statusBarItem.color = ui.color;
        statusBarItem.tooltip = ui.tooltip;

        // Update remote file browser when connected
        const target = getWorkspaceTarget();
        if (target && (syncEngine.connectionState === 'CONNECTED' || syncEngine.connectionState === 'SYNCING')) {
            treeDataProvider.setRemoteLister(
                (dir) => syncEngine.listRemoteDirectory(dir),
                target.settings.remotePath
            );
        }
    };

    refreshStatusBar();
    context.subscriptions.push(statusBarItem);

    // ── Status Actions ──
    const statusActions = vscode.commands.registerCommand('bjorn-code.statusActions', async () => {
        const enabled = vscode.workspace.getConfiguration('bjornCode').get<boolean>('enabled', false);

        if (!enabled) {
            const action = await vscode.window.showQuickPick(['Enable Bjorn Code', 'Open Settings'], {
                placeHolder: 'Bjorn Code actions'
            });
            if (action === 'Enable Bjorn Code') {
                await vscode.workspace.getConfiguration('bjornCode').update('enabled', true, vscode.ConfigurationTarget.Workspace);
            } else if (action === 'Open Settings') {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'bjornCode');
            }
            return;
        }

        const action = await vscode.window.showQuickPick(
            [
                'Connect/Retry',
                'Disconnect',
                'Push (incremental)',
                'Push (full scan)',
                'Pull',
                'Sync Summary',
                'SSH Terminal',
                'Restart Bjorn',
                'Reboot Pi',
                'Run Python',
                'Service Status',
                'Live Logs',
                'Open Logs',
                'Disable Bjorn Code'
            ],
            { placeHolder: 'Bjorn Code actions' }
        );

        switch (action) {
            case 'Connect/Retry':
                await syncEngine.connect();
                break;
            case 'Disconnect':
                syncEngine.disconnect();
                break;
            case 'Push (incremental)':
                await syncEngine.syncAll();
                break;
            case 'Push (full scan)':
                await syncEngine.fullSync();
                break;
            case 'Pull':
                await syncEngine.syncPull();
                break;
            case 'Sync Summary': {
                const summary = syncEngine.getSyncSummary();
                const total = summary.added.length + summary.modified.length + summary.deleted.length;
                if (total === 0) {
                    vscode.window.showInformationMessage('Bjorn Code: No pending changes.');
                } else {
                    const lines = [];
                    if (summary.added.length > 0) {
                        lines.push(`+ ${summary.added.length} added`);
                    }
                    if (summary.modified.length > 0) {
                        lines.push(`~ ${summary.modified.length} modified`);
                    }
                    if (summary.deleted.length > 0) {
                        lines.push(`- ${summary.deleted.length} deleted`);
                    }
                    const choice = await vscode.window.showInformationMessage(
                        `Bjorn Code: ${lines.join(', ')} (${total} total)`,
                        'Push Now',
                        'Details'
                    );
                    if (choice === 'Push Now') {
                        await syncEngine.syncAll();
                    } else if (choice === 'Details') {
                        outputChannel.clear();
                        outputChannel.appendLine('=== Sync Summary ===');
                        for (const f of summary.added) {
                            outputChannel.appendLine(`  + ${f}`);
                        }
                        for (const f of summary.modified) {
                            outputChannel.appendLine(`  ~ ${f}`);
                        }
                        for (const f of summary.deleted) {
                            outputChannel.appendLine(`  - ${f}`);
                        }
                        outputChannel.show(true);
                    }
                }
                break;
            }
            case 'SSH Terminal':
                await remoteRunner.openSshTerminal();
                break;
            case 'Restart Bjorn':
                await remoteRunner.restartBjornService();
                break;
            case 'Reboot Pi':
                await remoteRunner.rebootPi();
                break;
            case 'Run Python':
                await remoteRunner.runPython();
                break;
            case 'Service Status':
                await remoteRunner.runServiceAction('status');
                break;
            case 'Live Logs': {
                const panel = LiveLogsPanel.createOrShow(logger);
                await panel.startStream();
                break;
            }
            case 'Open Logs':
                outputChannel.show(true);
                break;
            case 'Disable Bjorn Code':
                await vscode.workspace.getConfiguration('bjornCode').update('enabled', false, vscode.ConfigurationTarget.Workspace);
                break;
            default:
                break;
        }
    });

    // ── Basic commands ──
    const toggleEnabled = vscode.commands.registerCommand('bjorn-code.toggleEnabled', async () => {
        const cfg = vscode.workspace.getConfiguration('bjornCode');
        const current = cfg.get<boolean>('enabled', false);
        await cfg.update('enabled', !current, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`Bjorn Code ${!current ? 'enabled' : 'disabled'}.`);
    });

    const syncNowCommand = vscode.commands.registerCommand('bjorn-code.syncNow', async () => {
        outputChannel.appendLine('[Command] Push to Remote');
        await syncEngine.syncAll();
    });

    const fullSyncCommand = vscode.commands.registerCommand('bjorn-code.fullSync', async () => {
        outputChannel.appendLine('[Command] Full Push to Remote');
        await syncEngine.fullSync();
    });

    const connectCommand = vscode.commands.registerCommand('bjorn-code.connect', async () => {
        await syncEngine.connect();
        refreshStatusBar();
    });

    const disconnectCommand = vscode.commands.registerCommand('bjorn-code.disconnect', () => {
        syncEngine.disconnect();
        refreshStatusBar();
    });

    const doToggleConnection = async () => {
        if (syncEngine.connectionState === 'CONNECTED' || syncEngine.connectionState === 'SYNCING' || syncEngine.connectionState === 'CONNECTING') {
            syncEngine.disconnect();
        } else {
            await syncEngine.connect();
        }
        refreshStatusBar();
    };

    const toggleConnectionCommand = vscode.commands.registerCommand('bjorn-code.toggleConnection', doToggleConnection);
    const toggleConnectionConnected = vscode.commands.registerCommand('bjorn-code.toggleConnection.connected', doToggleConnection);
    const toggleConnectionSyncing = vscode.commands.registerCommand('bjorn-code.toggleConnection.syncing', doToggleConnection);
    const toggleConnectionDisconnected = vscode.commands.registerCommand('bjorn-code.toggleConnection.disconnected', doToggleConnection);
    const toggleConnectionError = vscode.commands.registerCommand('bjorn-code.toggleConnection.error', doToggleConnection);

    const openViewCommand = vscode.commands.registerCommand('bjorn-code.openView', async () => {
        await vscode.commands.executeCommand('workbench.view.extension.bjorn-code');
    });

    const syncPullCommand = vscode.commands.registerCommand('bjorn-code.syncPull', async () => {
        outputChannel.appendLine('[Command] Pull from Remote');
        await syncEngine.syncPull();
    });

    const openSettingsCommand = vscode.commands.registerCommand('bjorn-code.openSettings', async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'bjornCode');
    });

    const openFileCommand = vscode.commands.registerCommand('bjorn-code.openFile', async (arg: unknown) => {
        const resource = resolveResourceArg(arg);
        if (!resource) {
            return;
        }
        await vscode.window.showTextDocument(resource);
    });

    const toggleAutoSync = vscode.commands.registerCommand('bjorn-code.toggleAutoSync', async () => {
        const cfg = vscode.workspace.getConfiguration('bjornCode');
        const current = cfg.get<boolean>('autoSync', true);
        await cfg.update('autoSync', !current, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`Bjorn Code: Auto-sync ${!current ? 'enabled' : 'disabled'}.`);
    });

    const syncResourceCommand = vscode.commands.registerCommand('bjorn-code.syncResource', async (arg: unknown) => {
        const resource = resolveResourceArg(arg);
        if (!resource) {
            return;
        }
        await syncEngine.forcePushUri(resource);
    });

    const downloadResourceCommand = vscode.commands.registerCommand('bjorn-code.downloadResource', async (arg: unknown) => {
        const resource = resolveResourceArg(arg);
        if (!resource) {
            return;
        }
        await syncEngine.forcePullUri(resource);
    });

    const diffWithRemoteCommand = vscode.commands.registerCommand('bjorn-code.diffWithRemote', async (arg: unknown) => {
        const resource = resolveResourceArg(arg);
        if (!resource) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                await syncEngine.diffWithRemote(editor.document.uri);
            }
            return;
        }
        await syncEngine.diffWithRemote(resource);
    });

    const addIncludeCommand = vscode.commands.registerCommand('bjorn-code.addInclude', async (arg: unknown) => {
        const resource = resolveResourceArg(arg);
        if (!resource) {
            return;
        }
        const rel = vscode.workspace.asRelativePath(resource, false).replace(/\\/g, '/');
        const cfg = vscode.workspace.getConfiguration('bjornCode', resource);
        const includes = cfg.get<string[]>('includes', ['**/*']);
        if (!includes.includes(rel)) {
            includes.push(rel);
            await cfg.update('includes', includes, vscode.ConfigurationTarget.WorkspaceFolder);
            vscode.window.showInformationMessage(`Added include scope: ${rel}`);
        }
    });

    const addExcludeCommand = vscode.commands.registerCommand('bjorn-code.addExclusion', async (arg: unknown) => {
        const resource = resolveResourceArg(arg);
        if (!resource) {
            return;
        }
        const rel = vscode.workspace.asRelativePath(resource, false).replace(/\\/g, '/');
        const cfg = vscode.workspace.getConfiguration('bjornCode', resource);
        const exclusions = cfg.get<string[]>('exclusions', []);
        if (!exclusions.includes(rel)) {
            exclusions.push(rel);
            await cfg.update('exclusions', exclusions, vscode.ConfigurationTarget.WorkspaceFolder);
            vscode.window.showInformationMessage(`Added exclusion: ${rel}`);
        }
    });

    const runPythonRemoteCommand = vscode.commands.registerCommand('bjorn-code.runPythonRemote', async (resource?: vscode.Uri) => {
        await remoteRunner.runPython(resource);
    });

    // ── File management ──
    const renameResourceCommand = vscode.commands.registerCommand('bjorn-code.renameResource', async (arg: unknown) => {
        const resource = resolveResourceArg(arg);
        if (!resource) {
            return;
        }
        const currentName = resource.path.split('/').pop() ?? '';
        const newName = await vscode.window.showInputBox({
            prompt: `Rename ${currentName}`,
            value: currentName
        });
        if (!newName || newName.trim() === '' || newName === currentName) {
            return;
        }
        const target = resource.with({ path: resource.path.replace(/[^/]+$/, newName.trim()) });
        await vscode.workspace.fs.rename(resource, target, { overwrite: false });
    });

    const deleteResourceCommand = vscode.commands.registerCommand('bjorn-code.deleteResource', async (arg: unknown) => {
        const resource = resolveResourceArg(arg);
        if (!resource) {
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            `Delete ${resource.path.split('/').pop()}?`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') {
            return;
        }
        await vscode.workspace.fs.delete(resource, { recursive: true, useTrash: true });
        syncEngine.scheduleDelete(resource.fsPath);
    });

    const newFileCommand = vscode.commands.registerCommand('bjorn-code.newFile', async (arg: unknown) => {
        const folder = await resolveFolderFromArg(arg);
        if (!folder) {
            return;
        }
        const name = await vscode.window.showInputBox({ prompt: 'New file name' });
        if (!name || !name.trim()) {
            return;
        }
        const fileUri = vscode.Uri.file(path.join(folder.fsPath, name.trim()));
        await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
        await vscode.window.showTextDocument(fileUri);
        syncEngine.scheduleSyncFile(fileUri.fsPath, 'push');
    });

    const newFolderCommand = vscode.commands.registerCommand('bjorn-code.newFolder', async (arg: unknown) => {
        const folder = await resolveFolderFromArg(arg);
        if (!folder) {
            return;
        }
        const name = await vscode.window.showInputBox({ prompt: 'New folder name' });
        if (!name || !name.trim()) {
            return;
        }
        const folderUri = vscode.Uri.file(path.join(folder.fsPath, name.trim()));
        await vscode.workspace.fs.createDirectory(folderUri);
        treeDataProvider.refresh();
    });

    const importIntoFolderCommand = vscode.commands.registerCommand('bjorn-code.importIntoFolder', async (arg: unknown) => {
        const folder = await resolveFolderFromArg(arg);
        if (!folder) {
            return;
        }
        const picks = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: true,
            openLabel: 'Import into Bjorn Code folder'
        });
        if (!picks || picks.length === 0) {
            return;
        }
        for (const pick of picks) {
            const dst = vscode.Uri.file(path.join(folder.fsPath, path.basename(pick.fsPath) || 'imported'));
            await vscode.workspace.fs.copy(pick, dst, { overwrite: false });
            syncEngine.scheduleSyncFile(dst.fsPath, 'push');
        }
    });

    // ── Service commands ──
    const serviceStart = vscode.commands.registerCommand('bjorn-code.service.start', async () => remoteRunner.runServiceAction('start'));
    const serviceStop = vscode.commands.registerCommand('bjorn-code.service.stop', async () => remoteRunner.runServiceAction('stop'));
    const serviceRestart = vscode.commands.registerCommand('bjorn-code.service.restart', async () => remoteRunner.runServiceAction('restart'));
    const serviceStatus = vscode.commands.registerCommand('bjorn-code.service.status', async () => remoteRunner.runServiceAction('status'));
    const serviceEnable = vscode.commands.registerCommand('bjorn-code.service.enable', async () => remoteRunner.runServiceAction('enable'));
    const serviceDisable = vscode.commands.registerCommand('bjorn-code.service.disable', async () => remoteRunner.runServiceAction('disable'));
    const serviceTail = vscode.commands.registerCommand('bjorn-code.service.tail', async () => remoteRunner.runServiceAction('tail'));

    // ── New feature commands ──
    const restartBjornCommand = vscode.commands.registerCommand('bjorn-code.restartBjorn', () => remoteRunner.restartBjornService());
    const rebootPiCommand = vscode.commands.registerCommand('bjorn-code.rebootPi', () => remoteRunner.rebootPi());
    const openSshTerminalCommand = vscode.commands.registerCommand('bjorn-code.openSshTerminal', () => remoteRunner.openSshTerminal());

    const openLiveLogsCommand = vscode.commands.registerCommand('bjorn-code.openLiveLogs', async () => {
        const panel = LiveLogsPanel.createOrShow(logger);
        await panel.startStream();
    });

    const syncSummaryCommand = vscode.commands.registerCommand('bjorn-code.syncSummary', async () => {
        const summary = syncEngine.getSyncSummary();
        const total = summary.added.length + summary.modified.length + summary.deleted.length;
        if (total === 0) {
            vscode.window.showInformationMessage('Bjorn Code: No pending changes.');
        } else {
            outputChannel.clear();
            outputChannel.appendLine('=== Sync Summary ===');
            for (const f of summary.added) {
                outputChannel.appendLine(`  + ${f}`);
            }
            for (const f of summary.modified) {
                outputChannel.appendLine(`  ~ ${f}`);
            }
            for (const f of summary.deleted) {
                outputChannel.appendLine(`  - ${f}`);
            }
            outputChannel.show(true);
        }
    });

    const openConflictsView = vscode.commands.registerCommand('bjorn-code.openConflictsView', async () => {
        await vscode.commands.executeCommand('workbench.view.extension.bjorn-code');
    });

    // ── Register all subscriptions ──
    context.subscriptions.push(
        statusActions,
        toggleEnabled,
        syncNowCommand,
        fullSyncCommand,
        connectCommand,
        disconnectCommand,
        toggleConnectionCommand,
        toggleConnectionConnected,
        toggleConnectionSyncing,
        toggleConnectionDisconnected,
        toggleConnectionError,
        openViewCommand,
        syncPullCommand,
        openSettingsCommand,
        openFileCommand,
        toggleAutoSync,
        syncResourceCommand,
        downloadResourceCommand,
        diffWithRemoteCommand,
        renameResourceCommand,
        deleteResourceCommand,
        newFileCommand,
        newFolderCommand,
        importIntoFolderCommand,
        addIncludeCommand,
        addExcludeCommand,
        runPythonRemoteCommand,
        serviceStart,
        serviceStop,
        serviceRestart,
        serviceStatus,
        serviceEnable,
        serviceDisable,
        serviceTail,
        restartBjornCommand,
        rebootPiCommand,
        openSshTerminalCommand,
        openLiveLogsCommand,
        syncSummaryCommand,
        openConflictsView
    );

    // ── File system watchers ──
    const workspaceRootForWatcher = getWorkspaceTarget()?.workspaceRoot;
    const watchPattern = workspaceRootForWatcher
        ? new vscode.RelativePattern(workspaceRootForWatcher, '**/*')
        : '**/*';

    const watcher = vscode.workspace.createFileSystemWatcher(watchPattern);
    watcher.onDidChange((uri) => {
        if (syncEngine.shouldIgnoreWatcherEvent(uri.fsPath)) {
            return;
        }
        const cfg = vscode.workspace.getConfiguration('bjornCode');
        if (cfg.get<boolean>('enabled', false) && cfg.get<boolean>('autoSync', true)) {
            syncEngine.scheduleSyncFile(uri.fsPath, 'push');
        }
    });
    watcher.onDidCreate((uri) => {
        if (syncEngine.shouldIgnoreWatcherEvent(uri.fsPath)) {
            return;
        }
        const cfg = vscode.workspace.getConfiguration('bjornCode');
        if (cfg.get<boolean>('enabled', false) && cfg.get<boolean>('autoSync', true)) {
            syncEngine.scheduleSyncFile(uri.fsPath, 'push');
        }
    });
    watcher.onDidDelete((uri) => {
        if (syncEngine.shouldIgnoreWatcherEvent(uri.fsPath)) {
            return;
        }
        const cfg = vscode.workspace.getConfiguration('bjornCode');
        if (cfg.get<boolean>('enabled', false) && cfg.get<boolean>('autoSync', true)) {
            syncEngine.scheduleDelete(uri.fsPath);
        }
    });

    const saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!syncEngine.isManagedPath(doc.uri.fsPath)) {
            return;
        }
        const cfg = vscode.workspace.getConfiguration('bjornCode');
        if (cfg.get<boolean>('enabled', false) && cfg.get<boolean>('autoSync', true)) {
            syncEngine.scheduleSyncFile(doc.uri.fsPath, 'push');
        }
    });

    const dirtyListener = vscode.workspace.onDidChangeTextDocument((e) => {
        if (!syncEngine.isManagedPath(e.document.uri.fsPath)) {
            return;
        }
        const cfg = vscode.workspace.getConfiguration('bjornCode');
        if (cfg.get<boolean>('enabled', false) && e.document.isDirty) {
            treeDataProvider.setFileStatus(e.document.uri.fsPath, SyncStatus.Modified);
        }
    });

    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('bjornCode.localPath')) {
            treeDataProvider.updateWorkspaceRoot(getWorkspaceTarget()?.workspaceRoot);
        }

        if (e.affectsConfiguration('bjornCode.logLevel')) {
            const target = getWorkspaceTarget();
            if (target) {
                logger.setLevel(target.settings.logLevel);
            }
        }

        if (
            e.affectsConfiguration('bjornCode.enabled') ||
            e.affectsConfiguration('bjornCode.autoSync') ||
            e.affectsConfiguration('bjornCode.remoteIp')
        ) {
            refreshStatusBar();
        }
    });

    const engineStateListener = syncEngine.onStateChanged(() => refreshStatusBar());

    const dropImportListener = treeDataProvider.onFilesImported(async (filePaths) => {
        const cfg = vscode.workspace.getConfiguration('bjornCode');
        if (!cfg.get<boolean>('enabled', false)) {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Bjorn Code: Importing ${filePaths.length} file${filePaths.length > 1 ? 's' : ''}`,
                cancellable: false
            },
            async (progress) => {
                let done = 0;
                for (const filePath of filePaths) {
                    done++;
                    progress.report({
                        message: `${done}/${filePaths.length}: ${path.basename(filePath)}`,
                        increment: (1 / filePaths.length) * 100
                    });
                    syncEngine.scheduleSyncFile(filePath, 'push');
                }
            }
        );

        logger.info(`Drop import: queued ${filePaths.length} file(s) for upload`);
    });

    context.subscriptions.push(watcher, dirtyListener, saveListener, configListener, engineStateListener, dropImportListener, syncEngine);
}

export function deactivate(): void {
    if (syncEngine) {
        syncEngine.dispose();
    }
    ConnectionManager.disposeAll();
}
