import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ConnectionState } from './core/ConnectionManager';

export enum SyncStatus {
    Synced = 'synced',
    Pending = 'pending',
    Modified = 'modified',
    Error = 'error',
    None = 'none'
}

export interface ConflictItem {
    sourcePath: string;
    localArtifact: string;
    remoteArtifact: string;
}

export class BjornFileItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly resourceUri: vscode.Uri,
        public readonly isDirectory: boolean,
        public status: SyncStatus = SyncStatus.None
    ) {
        super(label, collapsibleState);

        this.tooltip = `${this.label} - ${this.status}`;
        this.description = this.status === SyncStatus.None ? '' : this.status;

        if (!this.isDirectory) {
            this.command = {
                command: 'bjorn-code.openFile',
                title: 'Open File',
                arguments: [this.resourceUri]
            };
            this.contextValue = 'bjornFile';
        } else {
            this.contextValue = 'bjornFolder';
        }

        this.updateIcon();
    }

    public updateStatus(status: SyncStatus): void {
        this.status = status;
        this.description = this.status === SyncStatus.None ? '' : this.status;
        this.tooltip = `${this.label} - ${this.status}`;
        this.updateIcon();
    }

    private updateIcon(): void {
        if (this.isDirectory) {
            switch (this.status) {
                case SyncStatus.Pending:
                    this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
                    break;
                case SyncStatus.Modified:
                    this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
                    break;
                case SyncStatus.Error:
                    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
                    break;
                default:
                    this.iconPath = vscode.ThemeIcon.Folder;
                    break;
            }
            return;
        }

        switch (this.status) {
            case SyncStatus.Synced:
                this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
                break;
            case SyncStatus.Pending:
                this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
                break;
            case SyncStatus.Modified:
                this.iconPath = new vscode.ThemeIcon('edit', new vscode.ThemeColor('charts.yellow'));
                break;
            case SyncStatus.Error:
                this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
                break;
            default:
                this.iconPath = vscode.ThemeIcon.File;
                break;
        }
    }
}

export class BjornRemoteItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly remotePath: string,
        public readonly isDirectory: boolean,
        public readonly fileSize: number
    ) {
        super(
            label,
            isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );

        this.contextValue = isDirectory ? 'bjornRemoteFolder' : 'bjornRemoteFile';
        this.iconPath = isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
        this.tooltip = remotePath;

        if (!isDirectory && fileSize > 0) {
            this.description = formatFileSize(fileSize);
        }
    }
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

class BjornInfoItem extends vscode.TreeItem {
    constructor(
        label: string,
        iconId: string,
        colorId: string,
        tooltip: string,
        contextValue: string,
        command?: vscode.Command
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor(colorId));
        this.tooltip = tooltip;
        this.contextValue = contextValue;
        this.command = command;
    }
}

class BjornRootItem extends vscode.TreeItem {
    constructor(label: string, contextValue: string, collapsed = false) {
        super(label, collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = contextValue;
    }
}

export type BjornTreeElement = BjornRootItem | BjornInfoItem | BjornFileItem | BjornRemoteItem;

const BJORN_TREE_MIME = 'application/vnd.code.tree.bjornCodeExplorer';

type RemoteLister = (remoteDir: string) => Promise<{ name: string; isDirectory: boolean; size: number; mtime: number }[]>;

export class BjornTreeDataProvider implements vscode.TreeDataProvider<BjornTreeElement>, vscode.TreeDragAndDropController<BjornTreeElement> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<BjornTreeElement | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<BjornTreeElement | undefined | void> = this.onDidChangeTreeDataEmitter.event;
    private readonly onDidChangeStatusEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeStatus: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> = this.onDidChangeStatusEmitter.event;
    private readonly onFilesImportedEmitter = new vscode.EventEmitter<string[]>();
    readonly onFilesImported: vscode.Event<string[]> = this.onFilesImportedEmitter.event;
    readonly dropMimeTypes: readonly string[] = [BJORN_TREE_MIME, 'text/uri-list'];
    readonly dragMimeTypes: readonly string[] = [BJORN_TREE_MIME];

    private readonly fileStatuses = new Map<string, SyncStatus>();
    private connectionState: ConnectionState = 'DISCONNECTED';
    private queueSnapshot = { pending: 0, inflight: 0, total: 0 };
    private readonly conflicts: ConflictItem[] = [];
    private remoteLister?: RemoteLister;
    private remotePath?: string;

    private readonly rootConnection = new BjornRootItem('Connection', 'bjornConnectionRoot');
    private readonly rootSync = new BjornRootItem('Sync', 'bjornSyncRoot');
    private readonly rootConflicts = new BjornRootItem('Conflicts', 'bjornConflictsRoot');
    private readonly rootWorkspace = new BjornRootItem('Workspace', 'bjornWorkspaceRoot');
    private readonly rootRemote = new BjornRootItem('Remote Files', 'bjornRemoteRoot', true);
    private readonly rootTools = new BjornRootItem('Remote Tools', 'bjornToolsRoot');

    constructor(private workspaceRoot: string | undefined) {}

    public setRemoteLister(lister: RemoteLister, remotePath: string): void {
        this.remoteLister = lister;
        this.remotePath = remotePath;
    }

    public refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    public updateWorkspaceRoot(root: string | undefined): void {
        this.workspaceRoot = root;
        this.refresh();
    }

    public setConnectionState(state: ConnectionState): void {
        this.connectionState = state;
        this.refresh();
    }

    public setQueueSnapshot(snapshot: { pending: number; inflight: number; total: number }): void {
        this.queueSnapshot = snapshot;
        this.refresh();
    }

    public addConflict(sourcePath: string, localArtifact: string, remoteArtifact: string): void {
        this.conflicts.unshift({ sourcePath, localArtifact, remoteArtifact });
        this.refresh();
    }

    public clearConflicts(): void {
        this.conflicts.length = 0;
        this.refresh();
    }

    private normalizePath(p: string): string {
        return vscode.Uri.file(p).fsPath;
    }

    public setFileStatus(filePath: string, status: SyncStatus): void {
        const normalizedPath = this.normalizePath(filePath);
        this.fileStatuses.set(normalizedPath, status);
        this.onDidChangeStatusEmitter.fire(vscode.Uri.file(normalizedPath));

        if (this.workspaceRoot) {
            this.recomputeAncestors(normalizedPath);
        }

        this.refresh();
    }

    private recomputeAncestors(filePath: string): void {
        if (!this.workspaceRoot) {
            return;
        }

        const normalizedRoot = this.normalizePath(this.workspaceRoot);
        let current = this.normalizePath(path.dirname(filePath));
        const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;

        while (current === normalizedRoot || current.startsWith(rootPrefix)) {
            const recomputed = this.computeDirectoryStatus(current);
            if (recomputed === SyncStatus.None) {
                this.fileStatuses.delete(current);
            } else {
                this.fileStatuses.set(current, recomputed);
            }

            if (current === normalizedRoot) {
                break;
            }

            const next = this.normalizePath(path.dirname(current));
            if (next === current) {
                break;
            }
            current = next;
        }
    }

    private computeDirectoryStatus(directoryPath: string): SyncStatus {
        // Use cached child statuses instead of reading filesystem for every status change.
        // Only check known file statuses whose paths start with this directory.
        const prefix = directoryPath.endsWith(path.sep) ? directoryPath : `${directoryPath}${path.sep}`;
        let hasError = false;
        let hasPending = false;
        let hasModified = false;
        let hasSynced = false;

        for (const [childPath, childStatus] of this.fileStatuses) {
            if (!childPath.startsWith(prefix)) {
                continue;
            }
            // Only check direct children (no sub-sub paths)
            const remainder = childPath.slice(prefix.length);
            if (remainder.includes(path.sep)) {
                continue;
            }

            if (childStatus === SyncStatus.Error) {
                hasError = true;
            } else if (childStatus === SyncStatus.Pending) {
                hasPending = true;
            } else if (childStatus === SyncStatus.Modified) {
                hasModified = true;
            } else if (childStatus === SyncStatus.Synced) {
                hasSynced = true;
            }
        }

        if (hasError) {
            return SyncStatus.Error;
        }
        if (hasPending) {
            return SyncStatus.Pending;
        }
        if (hasModified) {
            return SyncStatus.Modified;
        }
        if (hasSynced) {
            return SyncStatus.Synced;
        }

        return SyncStatus.None;
    }

    getTreeItem(element: BjornTreeElement): vscode.TreeItem {
        return element;
    }

    public getFileStatus(filePath: string): SyncStatus | undefined {
        return this.fileStatuses.get(this.normalizePath(filePath));
    }

    public async handleDrag(source: readonly BjornTreeElement[], dataTransfer: vscode.DataTransfer): Promise<void> {
        const uris = source
            .filter((item): item is BjornFileItem => item instanceof BjornFileItem)
            .map((item) => item.resourceUri.toString());

        if (uris.length > 0) {
            dataTransfer.set(BJORN_TREE_MIME, new vscode.DataTransferItem(JSON.stringify(uris)));
        }
    }

    public async handleDrop(target: BjornTreeElement | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        const targetFolder = this.resolveDropTarget(target);
        if (!targetFolder) {
            return;
        }

        const internalTransfer = dataTransfer.get(BJORN_TREE_MIME);
        if (internalTransfer) {
            const raw = await internalTransfer.asString();
            const uris = JSON.parse(raw) as string[];
            const movedFiles: string[] = [];
            for (const uriString of uris) {
                const src = vscode.Uri.parse(uriString).fsPath;
                const dst = path.join(targetFolder, path.basename(src));
                await this.movePath(src, dst);
                movedFiles.push(...await this.collectAllFiles(dst));
            }
            this.refresh();
            if (movedFiles.length > 0) {
                this.onFilesImportedEmitter.fire(movedFiles);
            }
            return;
        }

        const externalTransfer = dataTransfer.get('text/uri-list');
        if (externalTransfer) {
            const raw = await externalTransfer.asString();
            const uriStrings = raw.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
            const importedFiles: string[] = [];
            for (const uriString of uriStrings) {
                try {
                    const srcUri = vscode.Uri.parse(uriString);
                    if (srcUri.scheme !== 'file') {
                        continue;
                    }
                    const src = srcUri.fsPath;
                    const dst = path.join(targetFolder, path.basename(src));
                    await this.copyPath(src, dst);
                    importedFiles.push(...await this.collectAllFiles(dst));
                } catch {
                    continue;
                }
            }
            this.refresh();
            if (importedFiles.length > 0) {
                this.onFilesImportedEmitter.fire(importedFiles);
            }
        }
    }

    private async collectAllFiles(filePath: string): Promise<string[]> {
        try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isDirectory()) {
                return [filePath];
            }
            const files: string[] = [];
            const entries = await fs.promises.readdir(filePath, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(filePath, entry.name);
                if (entry.isDirectory()) {
                    files.push(...await this.collectAllFiles(full));
                } else {
                    files.push(full);
                }
            }
            return files;
        } catch {
            return [];
        }
    }

    getChildren(element?: BjornTreeElement): Thenable<BjornTreeElement[]> {
        if (!element) {
            return Promise.resolve([
                this.rootConnection,
                this.rootSync,
                this.rootConflicts,
                this.rootWorkspace,
                this.rootRemote,
                this.rootTools
            ]);
        }

        if (element === this.rootConnection) {
            return Promise.resolve([this.buildConnectionItem()]);
        }

        if (element === this.rootSync) {
            return Promise.resolve([
                new BjornInfoItem(
                    `Queue: ${this.queueSnapshot.total} (${this.queueSnapshot.inflight} running)`,
                    'list-ordered',
                    'charts.blue',
                    'Live transfer queue status',
                    'bjornQueue'
                )
            ]);
        }

        if (element === this.rootConflicts) {
            if (this.conflicts.length === 0) {
                return Promise.resolve([
                    new BjornInfoItem('No conflicts', 'pass-filled', 'testing.iconPassed', 'No conflict detected', 'bjornConflictEmpty')
                ]);
            }

            return Promise.resolve(
                this.conflicts.slice(0, 30).map((conflict) => {
                    const item = new BjornInfoItem(
                        path.basename(conflict.sourcePath),
                        'warning',
                        'charts.yellow',
                        `${conflict.localArtifact}\n${conflict.remoteArtifact}`,
                        'bjornConflict',
                        {
                            command: 'bjorn-code.openFile',
                            title: 'Open local conflict',
                            arguments: [vscode.Uri.file(conflict.localArtifact)]
                        }
                    );
                    item.description = 'conflict';
                    return item;
                })
            );
        }

        if (element === this.rootWorkspace) {
            if (!this.workspaceRoot) {
                return Promise.resolve([]);
            }
            return this.getFsChildren(this.workspaceRoot);
        }

        if (element === this.rootRemote) {
            if (!this.remoteLister || !this.remotePath) {
                return Promise.resolve([
                    new BjornInfoItem('Not connected', 'debug-disconnect', 'charts.red', 'Connect first to browse remote files', 'bjornRemoteDisconnected')
                ]);
            }
            return this.getRemoteChildren(this.remotePath);
        }

        if (element instanceof BjornRemoteItem && element.isDirectory) {
            if (!this.remoteLister) {
                return Promise.resolve([]);
            }
            return this.getRemoteChildren(element.remotePath);
        }

        if (element === this.rootTools) {
            return Promise.resolve([
                new BjornInfoItem('Run Python', 'play-circle', 'charts.blue', 'Run current Python file remotely', 'bjornToolRunPython', {
                    command: 'bjorn-code.runPythonRemote',
                    title: 'Run Python'
                }),
                new BjornInfoItem('SSH Terminal', 'terminal', 'charts.green', 'Open SSH terminal to Pi', 'bjornToolSshTerminal', {
                    command: 'bjorn-code.openSshTerminal',
                    title: 'SSH Terminal'
                }),
                new BjornInfoItem('Restart Bjorn', 'debug-restart', 'charts.orange', 'Restart Bjorn service', 'bjornToolRestartService', {
                    command: 'bjorn-code.restartBjorn',
                    title: 'Restart Bjorn'
                }),
                new BjornInfoItem('Reboot Pi', 'vm-connect', 'testing.iconFailed', 'Reboot the Raspberry Pi', 'bjornToolReboot', {
                    command: 'bjorn-code.rebootPi',
                    title: 'Reboot Pi'
                }),
                new BjornInfoItem('Service Status', 'server-process', 'charts.green', 'Check systemd service', 'bjornToolServiceStatus', {
                    command: 'bjorn-code.service.status',
                    title: 'Service Status'
                }),
                new BjornInfoItem('Tail Service Logs', 'list-tree', 'charts.orange', 'Tail journalctl logs', 'bjornToolServiceTail', {
                    command: 'bjorn-code.service.tail',
                    title: 'Tail Logs'
                }),
                new BjornInfoItem('Live Logs Panel', 'open-preview', 'charts.blue', 'Open live logs webview', 'bjornToolLiveLogs', {
                    command: 'bjorn-code.openLiveLogs',
                    title: 'Live Logs'
                })
            ]);
        }

        if (element instanceof BjornFileItem && element.isDirectory) {
            return this.getFsChildren(element.resourceUri.fsPath);
        }

        return Promise.resolve([]);
    }

    private async getRemoteChildren(remoteDir: string): Promise<BjornTreeElement[]> {
        if (!this.remoteLister) {
            return [];
        }
        try {
            const entries = await this.remoteLister(remoteDir);
            return entries.map((e) => {
                const remotePath = remoteDir.endsWith('/')
                    ? `${remoteDir}${e.name}`
                    : `${remoteDir}/${e.name}`;
                return new BjornRemoteItem(e.name, remotePath, e.isDirectory, e.size);
            });
        } catch {
            return [
                new BjornInfoItem('Error loading remote files', 'error', 'testing.iconFailed', 'Check connection', 'bjornRemoteError')
            ];
        }
    }

    private buildConnectionItem(): BjornInfoItem {
        switch (this.connectionState) {
            case 'CONNECTED':
                return new BjornInfoItem('Connected', 'vm-active', 'testing.iconPassed', 'SSH+SFTP connected', 'bjornConnectionConnected');
            case 'CONNECTING':
                return new BjornInfoItem('Connecting...', 'sync~spin', 'charts.blue', 'Connecting to remote host', 'bjornConnectionConnecting');
            case 'SYNCING':
                return new BjornInfoItem('Syncing...', 'sync~spin', 'charts.blue', 'Transfers in progress', 'bjornConnectionSyncing');
            case 'ERROR':
                return new BjornInfoItem('Connection error', 'error', 'testing.iconFailed', 'Connection is in error state', 'bjornConnectionError');
            default:
                return new BjornInfoItem('Disconnected', 'debug-disconnect', 'charts.red', 'Not connected', 'bjornConnectionDisconnected');
        }
    }

    private getFsChildren(folderPath: string): Promise<BjornTreeElement[]> {
        try {
            if (!fs.existsSync(folderPath)) {
                return Promise.resolve([]);
            }

            const files = fs.readdirSync(folderPath).filter((file) => !this.isInternalTempName(file));
            const items = files.map((file) => {
                const itemPath = path.join(folderPath, file);
                const normalizedItemPath = this.normalizePath(itemPath);
                const stats = fs.statSync(itemPath);
                const isDirectory = stats.isDirectory();
                const collapsibleState = isDirectory
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None;

                const status = this.fileStatuses.get(normalizedItemPath) || SyncStatus.None;
                return new BjornFileItem(file, collapsibleState, vscode.Uri.file(itemPath), isDirectory, status);
            });

            return Promise.resolve(
                items.sort((a, b) => {
                    if (a.isDirectory === b.isDirectory) {
                        return a.label.toString().localeCompare(b.label.toString());
                    }
                    return a.isDirectory ? -1 : 1;
                })
            );
        } catch {
            return Promise.resolve([]);
        }
    }

    private resolveDropTarget(target?: BjornTreeElement): string | undefined {
        if (!this.workspaceRoot) {
            return undefined;
        }
        if (!target || target === this.rootWorkspace) {
            return this.workspaceRoot;
        }
        if (target instanceof BjornFileItem) {
            if (target.isDirectory) {
                return target.resourceUri.fsPath;
            }
            return path.dirname(target.resourceUri.fsPath);
        }
        return undefined;
    }

    private async movePath(source: string, destination: string): Promise<void> {
        if (this.normalizePath(source) === this.normalizePath(destination)) {
            return;
        }
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        try {
            await fs.promises.rename(source, destination);
        } catch {
            await this.copyPath(source, destination);
            await fs.promises.rm(source, { recursive: true, force: true });
        }
    }

    private async copyPath(source: string, destination: string): Promise<void> {
        const stat = await fs.promises.stat(source);
        if (stat.isDirectory()) {
            await fs.promises.mkdir(destination, { recursive: true });
            const entries = await fs.promises.readdir(source);
            for (const entry of entries) {
                await this.copyPath(path.join(source, entry), path.join(destination, entry));
            }
            return;
        }
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.copyFile(source, destination);
    }

    private isInternalTempName(name: string): boolean {
        const lower = name.toLowerCase();
        return lower.endsWith('.__uploading__') || lower.endsWith('.__downloading__');
    }
}
