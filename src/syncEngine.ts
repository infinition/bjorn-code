import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SFTPWrapper, FileEntry, Stats } from 'ssh2';
import { BjornTreeDataProvider, SyncStatus } from './treeDataProvider';
import { ConnectionManager, ConnectionState } from './core/ConnectionManager';
import { TransferJob, TransferQueue } from './core/TransferQueue';
import { getWorkspaceTarget } from './core/Config';
import { Logger } from './core/Logger';

interface SyncSignature {
    size: number;
    mtimeSec: number;
}

type SyncDirection = 'push' | 'pull';
type PendingChangeType = 'upsert' | 'delete';

export class SyncEngine implements vscode.Disposable {
    private readonly logger: Logger;
    private connection?: ConnectionManager;
    private queue: TransferQueue;
    private debounceTimers = new Map<string, NodeJS.Timeout>();
    private syncing = false;
    private pullInProgress = false;
    private statusState: ConnectionState = 'DISCONNECTED';
    private lastSyncedSignature = new Map<string, SyncSignature>();
    private readonly ignoreWatcherUntil = new Map<string, number>();
    private readonly offlineJobs: TransferJob[] = [];
    private readonly pendingChanges = new Map<string, PendingChangeType>();
    private readonly onStateChangedEmitter = new vscode.EventEmitter<ConnectionState>();
    private readonly onQueueChangedEmitter = new vscode.EventEmitter<{ pending: number; inflight: number; total: number }>();

    public readonly onStateChanged = this.onStateChangedEmitter.event;
    public readonly onQueueChanged = this.onQueueChangedEmitter.event;

    constructor(
        private readonly outputChannel: vscode.OutputChannel,
        private readonly treeDataProvider: BjornTreeDataProvider
    ) {
        this.logger = new Logger(outputChannel);
        this.queue = new TransferQueue(3);
        this.bindQueueEvents();
    }

    public get connectionState(): ConnectionState {
        return this.statusState;
    }

    private updateState(state: ConnectionState): void {
        this.statusState = state;
        this.treeDataProvider.setConnectionState(state);
        this.onStateChangedEmitter.fire(state);
    }

    private bindQueueEvents(): void {
        this.queue.on('queueChanged', (snapshot: { pending: number; inflight: number; total: number }) => {
            this.treeDataProvider.setQueueSnapshot(snapshot);
            this.onQueueChangedEmitter.fire(snapshot);
            if (snapshot.total === 0 && this.statusState === 'SYNCING') {
                this.updateState('CONNECTED');
            }
        });

        this.queue.on('jobStarted', (job: TransferJob) => {
            this.updateState('SYNCING');
            if (job.localPath) {
                this.treeDataProvider.setFileStatus(job.localPath, SyncStatus.Pending);
            }
        });

        this.queue.on('jobCompleted', (job: TransferJob) => {
            if (job.localPath) {
                this.treeDataProvider.setFileStatus(job.localPath, SyncStatus.Synced);
            }
            if (this.queue.snapshot().total === 0) {
                this.updateState('CONNECTED');
            }
        });

        this.queue.on('jobRetry', (job: TransferJob, err: Error) => {
            this.logger.warn(`Retry ${job.retries}/${job.maxRetries} for ${job.key}: ${err.message}`);
            if (job.localPath) {
                this.treeDataProvider.setFileStatus(job.localPath, SyncStatus.Pending);
            }
        });

        this.queue.on('jobFailed', (job: TransferJob, err: Error) => {
            this.logger.error(`Job failed ${job.type} ${job.key}: ${err.message}`);
            if (job.localPath) {
                this.treeDataProvider.setFileStatus(job.localPath, SyncStatus.Error);
            }
            this.updateState('ERROR');
            void vscode.window
                .showErrorMessage(`Acid Bjorn: ${job.type} failed (${path.basename(job.key)})`, 'Open Output Logs')
                .then((action) => {
                    if (action === 'Open Output Logs') {
                        this.outputChannel.show(true);
                    }
                });
        });
    }

    private ensureConnectionForTarget(): ConnectionManager | undefined {
        const target = this.getManagedTarget();
        if (!target) {
            return undefined;
        }

        this.queue.updateConcurrency(target.settings.maxConcurrency);
        this.logger.setLevel(target.settings.logLevel);

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

        if (this.connection !== manager) {
            const previousConnection = this.connection;
            previousConnection?.removeAllListeners('stateChanged');
            previousConnection?.dispose();
            this.connection = manager;
            this.logger.info(`Using target ${target.settings.username}@${target.settings.host}:${target.settings.port}`);
            manager.on('stateChanged', (state: ConnectionState) => {
                this.updateState(state);
                this.queue.setOnline(state === 'CONNECTED' || state === 'SYNCING');
                if (state === 'CONNECTED' && this.offlineJobs.length > 0) {
                    const queued = [...this.offlineJobs];
                    this.offlineJobs.length = 0;
                    for (const job of queued) {
                        this.queue.enqueue(job);
                    }
                }
            });
        }

        return manager;
    }

    public async connect(_resource?: vscode.Uri): Promise<void> {
        const target = this.getManagedTarget();
        if (!target) {
            vscode.window.showWarningMessage('Acid Bjorn: No workspace found.');
            return;
        }

        if (!target.settings.enabled) {
            this.updateState('DISCONNECTED');
            return;
        }

        const manager = this.ensureConnectionForTarget();
        if (!manager) {
            return;
        }

        try {
            await manager.getSftp();
            this.updateState('CONNECTED');
        } catch (err: any) {
            this.updateState('ERROR');
            this.logger.error(`Connect failed: ${err.message}`);
            throw err;
        }
    }

    public disconnect(): void {
        this.connection?.disconnect();
        this.queue.setOnline(false);
        this.updateState('DISCONNECTED');
    }

    public scheduleSyncFile(localPath: string, direction: SyncDirection = 'push'): void {
        const normalized = vscode.Uri.file(localPath).fsPath;
        if (this.shouldIgnoreWatcherEvent(normalized)) {
            return;
        }
        if (direction === 'push') {
            this.pendingChanges.set(normalized, 'upsert');
        }
        if (this.debounceTimers.has(normalized)) {
            clearTimeout(this.debounceTimers.get(normalized)!);
        }

        this.debounceTimers.set(normalized, setTimeout(() => {
            this.debounceTimers.delete(normalized);
            void this.syncFile(normalized, direction);
        }, 500));
    }

    public scheduleDelete(localPath: string): void {
        const normalized = vscode.Uri.file(localPath).fsPath;
        if (this.shouldIgnoreWatcherEvent(normalized)) {
            return;
        }
        this.pendingChanges.set(normalized, 'delete');
        void this.syncDelete(normalized);
    }

    public async syncFile(localPath: string, direction: SyncDirection = 'push'): Promise<void> {
        const target = this.getManagedTarget();
        if (!target || !target.settings.enabled) {
            return;
        }

        if (!this.isPathInsideRoot(localPath, target.workspaceRoot)) {
            return;
        }

        const relativePath = path.relative(target.workspaceRoot, localPath).replace(/\\/g, '/');
        if (!relativePath || relativePath.startsWith('..') || this.isExcluded(relativePath, target.settings.exclusions)) {
            return;
        }

        const remotePath = path.posix.join(target.settings.remotePath, relativePath);
        const manager = this.ensureConnectionForTarget();
        if (!manager) {
            return;
        }

        await this.connect();

        if (direction === 'push') {
            const uploadJob = this.createUploadJob(localPath, remotePath, target.settings.maxRetries, target.settings.operationTimeoutMs);
            if (this.connectionState === 'CONNECTED' || this.connectionState === 'SYNCING') {
                this.queue.enqueue(uploadJob);
            } else {
                this.offlineJobs.push(uploadJob);
            }
        } else {
            const downloadJob = this.createDownloadJob(localPath, remotePath, target.settings.maxRetries, target.settings.operationTimeoutMs);
            if (this.connectionState === 'CONNECTED' || this.connectionState === 'SYNCING') {
                this.queue.enqueue(downloadJob);
            } else {
                this.offlineJobs.push(downloadJob);
            }
        }
    }

    /**
     * Push incremental changes (pendingChanges only).
     */
    public async syncAll(): Promise<void> {
        if (this.syncing) {
            return;
        }

        const target = getWorkspaceTarget();
        if (!target || !target.settings.enabled) {
            vscode.window.showWarningMessage('Acid Bjorn is disabled.');
            return;
        }

        await this.connect(target.workspaceFolder.uri);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Acid Bjorn: Push incremental to remote',
                cancellable: false
            },
            async (progress) => {
                this.syncing = true;
                try {
                    const changes = [...this.pendingChanges.entries()];
                    if (changes.length === 0) {
                        this.updateState('CONNECTED');
                        vscode.window.showInformationMessage('Acid Bjorn: nothing to push.');
                        return;
                    }

                    for (const [filePath, kind] of changes) {
                        if (!this.isPathInsideRoot(filePath, target.workspaceRoot)) {
                            continue;
                        }
                        const rel = path.relative(target.workspaceRoot, filePath).replace(/\\/g, '/');
                        if (!rel || rel.startsWith('..') || this.isExcluded(rel, target.settings.exclusions)) {
                            continue;
                        }
                        const remotePath = path.posix.join(target.settings.remotePath, rel);
                        progress.report({ message: `${kind}: ${rel}` });
                        if (kind === 'delete') {
                            this.queue.enqueue(this.createDeleteJob(filePath, remotePath, target.settings.maxRetries, target.settings.operationTimeoutMs));
                        } else {
                            this.queue.enqueue(this.createUploadJob(filePath, remotePath, target.settings.maxRetries, target.settings.operationTimeoutMs));
                        }
                    }

                    await this.waitForQueueDrain();
                    this.updateState('CONNECTED');
                    vscode.window.showInformationMessage('Acid Bjorn: Push completed.');
                } finally {
                    this.syncing = false;
                }
            }
        );
    }

    /**
     * Full sync: scan the entire local tree and push every file to remote.
     */
    public async fullSync(): Promise<void> {
        if (this.syncing) {
            return;
        }

        const target = getWorkspaceTarget();
        if (!target || !target.settings.enabled) {
            vscode.window.showWarningMessage('Acid Bjorn is disabled.');
            return;
        }

        await this.connect(target.workspaceFolder.uri);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Acid Bjorn: Full push to remote',
                cancellable: true
            },
            async (progress, token) => {
                this.syncing = true;
                try {
                    const files = this.collectLocalFiles(
                        target.workspaceRoot,
                        target.settings.exclusions,
                        target.settings.includes,
                        target.settings.syncMode
                    );
                    const total = files.length;
                    let queued = 0;

                    for (const filePath of files) {
                        if (token.isCancellationRequested) {
                            break;
                        }
                        const rel = path.relative(target.workspaceRoot, filePath).replace(/\\/g, '/');
                        const remotePath = path.posix.join(target.settings.remotePath, rel);
                        queued++;
                        progress.report({
                            message: `${queued}/${total}: ${rel}`,
                            increment: (1 / total) * 100
                        });
                        this.queue.enqueue(this.createUploadJob(filePath, remotePath, target.settings.maxRetries, target.settings.operationTimeoutMs));
                    }

                    await this.waitForQueueDrain();
                    this.updateState('CONNECTED');
                    vscode.window.showInformationMessage(`Acid Bjorn: Full push completed (${queued} files).`);
                } finally {
                    this.syncing = false;
                }
            }
        );
    }

    public async syncPull(): Promise<void> {
        if (this.syncing) {
            return;
        }

        const target = getWorkspaceTarget();
        if (!target || !target.settings.enabled) {
            vscode.window.showWarningMessage('Acid Bjorn is disabled.');
            return;
        }

        await this.connect(target.workspaceFolder.uri);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Acid Bjorn: Pull from remote',
                cancellable: true
            },
            async (progress, token) => {
                this.syncing = true;
                this.pullInProgress = true;
                try {
                    const files = await this.collectRemoteFiles(target.settings.remotePath, target.settings.exclusions);
                    const total = files.length;
                    let queued = 0;
                    for (const remotePath of files) {
                        if (token.isCancellationRequested) {
                            break;
                        }
                        const rel = path.posix.relative(target.settings.remotePath, remotePath);
                        const localPath = path.join(target.workspaceRoot, rel);
                        queued++;
                        progress.report({
                            message: `${queued}/${total}: ${rel}`,
                            increment: (1 / total) * 100
                        });
                        this.queue.enqueue(this.createDownloadJob(localPath, remotePath, target.settings.maxRetries, target.settings.operationTimeoutMs));
                    }

                    await this.waitForQueueDrain();
                    vscode.window.showInformationMessage(`Acid Bjorn: Pull completed (${queued} files).`);
                } finally {
                    this.syncing = false;
                    this.pullInProgress = false;
                }
            }
        );
    }

    /**
     * Diff a local file against the remote version using VS Code's built-in diff editor.
     */
    public async diffWithRemote(uri: vscode.Uri): Promise<void> {
        const target = this.getManagedTarget();
        if (!target || !target.settings.enabled) {
            vscode.window.showWarningMessage('Acid Bjorn is disabled.');
            return;
        }

        if (!this.isManagedPath(uri.fsPath)) {
            vscode.window.showWarningMessage('Acid Bjorn: path is outside configured sync root.');
            return;
        }

        const relativePath = path.relative(target.workspaceRoot, uri.fsPath).replace(/\\/g, '/');
        if (relativePath.startsWith('..')) {
            return;
        }
        const remotePath = path.posix.join(target.settings.remotePath, relativePath);

        await this.connect();

        const tmpDir = path.join(os.tmpdir(), 'acid-bjorn-diff');
        await fs.promises.mkdir(tmpDir, { recursive: true });
        const tempFile = path.join(tmpDir, `remote_${path.basename(uri.fsPath)}`);

        try {
            await this.fastGet(remotePath, tempFile, target.settings.operationTimeoutMs);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Acid Bjorn: Cannot fetch remote file: ${err.message}`);
            return;
        }

        const remoteUri = vscode.Uri.file(tempFile);
        const title = `${path.basename(uri.fsPath)} (Remote) ↔ ${path.basename(uri.fsPath)} (Local)`;
        await vscode.commands.executeCommand('vscode.diff', remoteUri, uri, title);
    }

    /**
     * Get a sync summary: what would be pushed (changed files).
     */
    public getSyncSummary(): { added: string[]; modified: string[]; deleted: string[] } {
        const target = this.getManagedTarget();
        const added: string[] = [];
        const modified: string[] = [];
        const deleted: string[] = [];

        if (!target) {
            return { added, modified, deleted };
        }

        for (const [filePath, kind] of this.pendingChanges.entries()) {
            const rel = path.relative(target.workspaceRoot, filePath).replace(/\\/g, '/');
            if (kind === 'delete') {
                deleted.push(rel);
            } else if (this.lastSyncedSignature.has(filePath)) {
                modified.push(rel);
            } else {
                added.push(rel);
            }
        }

        return { added, modified, deleted };
    }

    public async forcePushUri(uri: vscode.Uri): Promise<void> {
        if (!this.isManagedPath(uri.fsPath)) {
            vscode.window.showWarningMessage('Acid Bjorn: path is outside configured sync root, ignored.');
            return;
        }

        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
            const target = this.getManagedTarget();
            if (!target) {
                return;
            }
            const files = this.collectLocalFiles(uri.fsPath, target.settings.exclusions, target.settings.includes, target.settings.syncMode);
            for (const filePath of files) {
                await this.syncFile(filePath, 'push');
            }
            return;
        }

        await this.syncFile(uri.fsPath, 'push');
    }

    public async forcePullUri(uri: vscode.Uri): Promise<void> {
        const target = this.getManagedTarget();
        if (!target) {
            return;
        }
        if (!this.isManagedPath(uri.fsPath)) {
            vscode.window.showWarningMessage('Acid Bjorn: path is outside configured sync root, ignored.');
            return;
        }

        const relativePath = path.relative(target.workspaceRoot, uri.fsPath).replace(/\\/g, '/');
        if (relativePath.startsWith('..')) {
            return;
        }
        const remotePath = path.posix.join(target.settings.remotePath, relativePath);
        await this.syncFile(uri.fsPath, 'pull');
        this.logger.info(`Queued pull for ${remotePath}`);
    }

    private async syncDelete(localPath: string): Promise<void> {
        const target = this.getManagedTarget();
        if (!target || !target.settings.enabled) {
            return;
        }
        if (!this.isPathInsideRoot(localPath, target.workspaceRoot)) {
            return;
        }

        const relativePath = path.relative(target.workspaceRoot, localPath).replace(/\\/g, '/');
        if (!relativePath || relativePath.startsWith('..') || this.isExcluded(relativePath, target.settings.exclusions)) {
            return;
        }
        const remotePath = path.posix.join(target.settings.remotePath, relativePath);

        await this.connect();
        const deleteJob = this.createDeleteJob(localPath, remotePath, target.settings.maxRetries, target.settings.operationTimeoutMs);
        if (this.connectionState === 'CONNECTED' || this.connectionState === 'SYNCING') {
            this.queue.enqueue(deleteJob);
        } else {
            this.offlineJobs.push(deleteJob);
        }
    }

    private createUploadJob(localPath: string, remotePath: string, maxRetries: number, timeoutMs: number): TransferJob {
        const tempRemotePath = `${remotePath}.__uploading__`;
        const id = `upload:${remotePath}:${Date.now()}:${Math.random().toString(16).slice(2)}`;

        return {
            id,
            key: `UPLOAD:${remotePath}`,
            type: 'UPLOAD',
            localPath,
            remotePath,
            tempRemotePath,
            priority: 'high',
            retries: 0,
            maxRetries,
            abortController: new AbortController(),
            run: async (signal: AbortSignal) => {
                const target = this.getManagedTarget();
                if (!target || !this.connection) {
                    throw new Error('Missing workspace target');
                }

                await this.ensureRemoteDir(path.posix.dirname(remotePath), timeoutMs);

                const localStat = await fs.promises.stat(localPath);
                const remoteStat = await this.statRemote(remotePath, timeoutMs).catch(() => undefined);
                const localSignature: SyncSignature = {
                    size: localStat.size,
                    mtimeSec: Math.floor(localStat.mtimeMs / 1000)
                };

                if (remoteStat && this.isSameSignature(localSignature, { size: remoteStat.size, mtimeSec: remoteStat.mtime })) {
                    this.lastSyncedSignature.set(localPath, localSignature);
                    return;
                }

                const known = this.lastSyncedSignature.get(localPath);
                if (known && !this.isSameSignature(known, localSignature) && remoteStat && !this.isSameSignature(known, { size: remoteStat.size, mtimeSec: remoteStat.mtime })) {
                    await this.createConflictArtifacts(localPath, remotePath, timeoutMs);
                    return;
                }

                await this.fastPut(localPath, tempRemotePath, timeoutMs, signal);
                await this.renameRemote(tempRemotePath, remotePath, timeoutMs);
                this.lastSyncedSignature.set(localPath, localSignature);
                this.pendingChanges.delete(this.normalizePath(localPath));
            }
        };
    }

    private createDownloadJob(localPath: string, remotePath: string, maxRetries: number, timeoutMs: number): TransferJob {
        const tempLocalPath = `${localPath}.__downloading__`;
        const id = `download:${remotePath}:${Date.now()}:${Math.random().toString(16).slice(2)}`;

        return {
            id,
            key: `DOWNLOAD:${remotePath}`,
            type: 'DOWNLOAD',
            localPath,
            remotePath,
            tempLocalPath,
            priority: 'normal',
            retries: 0,
            maxRetries,
            abortController: new AbortController(),
            run: async (signal: AbortSignal) => {
                const remoteStat = await this.statRemote(remotePath, timeoutMs);
                const localStat = await fs.promises.stat(localPath).catch(() => undefined);

                if (localStat) {
                    const localSignature: SyncSignature = {
                        size: localStat.size,
                        mtimeSec: Math.floor(localStat.mtimeMs / 1000)
                    };
                    if (this.isSameSignature(localSignature, { size: remoteStat.size, mtimeSec: remoteStat.mtime })) {
                        this.lastSyncedSignature.set(localPath, localSignature);
                        return;
                    }
                }

                await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
                this.markPathIgnored(tempLocalPath, 30000);
                this.markPathIgnored(localPath, 30000);
                await this.fastGet(remotePath, tempLocalPath, timeoutMs, signal);
                await fs.promises.rename(tempLocalPath, localPath);
                this.lastSyncedSignature.set(localPath, {
                    size: remoteStat.size,
                    mtimeSec: remoteStat.mtime
                });
            }
        };
    }

    private createDeleteJob(localPath: string, remotePath: string, maxRetries: number, timeoutMs: number): TransferJob {
        const id = `delete:${remotePath}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
        return {
            id,
            key: `DELETE:${remotePath}`,
            type: 'DELETE',
            localPath,
            remotePath,
            priority: 'high',
            retries: 0,
            maxRetries,
            abortController: new AbortController(),
            run: async () => {
                const sftp = await this.getSftp();
                await this.withTimeout(
                    new Promise<void>((resolve) => {
                        sftp.unlink(remotePath, () => resolve());
                    }),
                    timeoutMs,
                    `delete timeout ${path.basename(remotePath)}`
                );
                this.pendingChanges.delete(this.normalizePath(localPath));
            }
        };
    }

    private async createConflictArtifacts(localPath: string, remotePath: string, timeoutMs: number): Promise<void> {
        const ts = Date.now();
        const localConflict = `${localPath}.conflict.LOCAL.${ts}`;
        const remoteConflict = `${localPath}.conflict.REMOTE.${ts}`;
        this.markPathIgnored(localConflict, 30000);
        this.markPathIgnored(remoteConflict, 30000);
        await fs.promises.copyFile(localPath, localConflict).catch(() => undefined);
        await this.fastGet(remotePath, remoteConflict, timeoutMs).catch(() => undefined);
        this.treeDataProvider.addConflict(localPath, localConflict, remoteConflict);
        void vscode.window.showWarningMessage(`Acid Bjorn conflict detected for ${path.basename(localPath)}`, 'Open Conflicts').then((action) => {
            if (action === 'Open Conflicts') {
                vscode.commands.executeCommand('acid-bjorn.openConflictsView');
            }
        });
    }

    public shouldIgnoreWatcherEvent(localPath: string): boolean {
        if (!this.isManagedPath(localPath)) {
            return true;
        }
        const normalized = vscode.Uri.file(localPath).fsPath;
        const now = Date.now();
        const ignoreUntil = this.ignoreWatcherUntil.get(normalized);
        if (ignoreUntil && ignoreUntil > now) {
            return true;
        }
        if (ignoreUntil && ignoreUntil <= now) {
            this.ignoreWatcherUntil.delete(normalized);
        }
        if (this.pullInProgress) {
            return true;
        }

        return this.isInternalPath(normalized);
    }

    public isManagedPath(localPath: string): boolean {
        const target = this.getManagedTarget();
        if (!target) {
            return false;
        }
        return this.isPathInsideRoot(localPath, target.workspaceRoot);
    }

    private markPathIgnored(localPath: string, durationMs: number): void {
        const normalized = vscode.Uri.file(localPath).fsPath;
        this.ignoreWatcherUntil.set(normalized, Date.now() + durationMs);
    }

    private isInternalPath(localPath: string): boolean {
        const lower = localPath.toLowerCase();
        return lower.endsWith('.__downloading__')
            || lower.endsWith('.__uploading__')
            || lower.includes('.conflict.local.')
            || lower.includes('.conflict.remote.');
    }

    private normalizePath(p: string): string {
        return vscode.Uri.file(p).fsPath;
    }

    private getManagedTarget() {
        return getWorkspaceTarget();
    }

    private isPathInsideRoot(localPath: string, workspaceRoot: string): boolean {
        const normalizedPath = vscode.Uri.file(localPath).fsPath;
        const normalizedRoot = vscode.Uri.file(workspaceRoot).fsPath;
        const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
        return normalizedPath === normalizedRoot || normalizedPath.startsWith(rootPrefix);
    }

    private isSameSignature(a: SyncSignature, b: SyncSignature): boolean {
        return a.size === b.size && Math.abs(a.mtimeSec - b.mtimeSec) <= 2;
    }

    private async ensureRemoteDir(remoteDir: string, timeoutMs: number): Promise<void> {
        const sftp = await this.getSftp();
        const parts = remoteDir.split('/').filter(Boolean);
        let current = remoteDir.startsWith('/') ? '/' : '';
        for (const part of parts) {
            current = path.posix.join(current, part);
            await this.withTimeout(
                new Promise<void>((resolve) => {
                    sftp.mkdir(current, () => resolve());
                }),
                timeoutMs,
                `mkdir timeout ${current}`
            );
        }
    }

    private async collectRemoteFiles(remoteRoot: string, exclusions: string[]): Promise<string[]> {
        const files: string[] = [];
        const walk = async (remoteDir: string): Promise<void> => {
            const entries = await this.readDir(remoteDir, 30000);
            for (const entry of entries) {
                const remotePath = path.posix.join(remoteDir, entry.filename);
                const rel = path.posix.relative(remoteRoot, remotePath);
                if (this.isExcluded(rel, exclusions)) {
                    continue;
                }
                const isDir = entry.longname?.startsWith('d') || ((entry.attrs.mode ?? 0) & 0o40000) === 0o40000;
                if (isDir) {
                    await walk(remotePath);
                } else {
                    files.push(remotePath);
                }
            }
        };

        await walk(remoteRoot);
        return files;
    }

    /**
     * Collect remote files as tree items for the remote browser.
     */
    public async listRemoteDirectory(remoteDir: string): Promise<{ name: string; isDirectory: boolean; size: number; mtime: number }[]> {
        const entries = await this.readDir(remoteDir, 30000);
        return entries
            .filter((e) => e.filename !== '.' && e.filename !== '..')
            .map((e) => ({
                name: e.filename,
                isDirectory: e.longname?.startsWith('d') || ((e.attrs.mode ?? 0) & 0o40000) === 0o40000,
                size: e.attrs.size ?? 0,
                mtime: e.attrs.mtime ?? 0
            }))
            .sort((a, b) => {
                if (a.isDirectory === b.isDirectory) {
                    return a.name.localeCompare(b.name);
                }
                return a.isDirectory ? -1 : 1;
            });
    }

    public collectLocalFiles(root: string, exclusions: string[], includes: string[], syncMode: 'mirror' | 'selective'): string[] {
        const files: string[] = [];

        const shouldInclude = (rel: string): boolean => {
            if (this.isExcluded(rel, exclusions)) {
                return false;
            }

            if (syncMode === 'mirror') {
                return true;
            }

            if (includes.length === 0) {
                return true;
            }

            return includes.some((pattern) => this.matchesPattern(rel, pattern));
        };

        const walk = (dir: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const rel = path.relative(root, fullPath).replace(/\\/g, '/');

                if (entry.isDirectory()) {
                    if (this.isExcluded(rel, exclusions)) {
                        continue;
                    }
                    walk(fullPath);
                } else if (shouldInclude(rel)) {
                    files.push(fullPath);
                }
            }
        };

        if (fs.existsSync(root)) {
            walk(root);
        }

        return files;
    }

    /**
     * Proper glob matching using minimatch-like logic.
     * Supports: ** (any depth), * (single segment), ? (single char).
     */
    private matchesPattern(filePath: string, pattern: string): boolean {
        // Convert glob pattern to regex properly
        let regex = '';
        let i = 0;
        while (i < pattern.length) {
            const ch = pattern[i];
            if (ch === '*' && pattern[i + 1] === '*') {
                // ** matches any path segments
                if (pattern[i + 2] === '/') {
                    regex += '(?:.+/)?';
                    i += 3;
                } else {
                    regex += '.*';
                    i += 2;
                }
            } else if (ch === '*') {
                regex += '[^/]*';
                i++;
            } else if (ch === '?') {
                regex += '[^/]';
                i++;
            } else if ('.+^${}()|[]\\'.includes(ch)) {
                regex += '\\' + ch;
                i++;
            } else {
                regex += ch;
                i++;
            }
        }

        return new RegExp(`^${regex}$`).test(filePath);
    }

    private isExcluded(relativePath: string, exclusions: string[]): boolean {
        const segments = relativePath.split('/');
        return exclusions.some((pattern) => {
            // Direct segment match (e.g., ".git" matches any path containing ".git" as a segment)
            if (!pattern.includes('/') && !pattern.includes('*') && !pattern.includes('?')) {
                return segments.some((seg) => this.matchesPattern(seg, pattern));
            }
            return this.matchesPattern(relativePath, pattern);
        });
    }

    private async getSftp(): Promise<SFTPWrapper> {
        if (!this.connection) {
            throw new Error('Connection manager not initialized');
        }
        return this.connection.getSftp();
    }

    private async readDir(remotePath: string, timeoutMs: number): Promise<FileEntry[]> {
        const sftp = await this.getSftp();
        return this.withTimeout(
            new Promise<FileEntry[]>((resolve, reject) => {
                sftp.readdir(remotePath, (err, list) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(list ?? []);
                });
            }),
            timeoutMs,
            `readdir timeout ${remotePath}`
        );
    }

    private async statRemote(remotePath: string, timeoutMs: number): Promise<Stats> {
        const sftp = await this.getSftp();
        return this.withTimeout(
            new Promise<Stats>((resolve, reject) => {
                sftp.stat(remotePath, (err, stats) => {
                    if (err || !stats) {
                        reject(err ?? new Error('Remote stat unavailable'));
                        return;
                    }
                    resolve(stats);
                });
            }),
            timeoutMs,
            `stat timeout ${remotePath}`
        );
    }

    private async renameRemote(from: string, to: string, timeoutMs: number): Promise<void> {
        const sftp = await this.getSftp();

        // SFTP v3 rename fails when the destination already exists.
        // Try OpenSSH POSIX rename extension first (atomic overwrite),
        // then fall back to unlink + rename.
        const posixRename = (): Promise<void> =>
            new Promise<void>((resolve, reject) => {
                (sftp as any).ext_openssh_rename(from, to, (err: Error | undefined) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });

        const unlinkThenRename = async (): Promise<void> => {
            // Remove existing destination (ignore errors if it doesn't exist)
            await new Promise<void>((resolve) => {
                sftp.unlink(to, () => resolve());
            });
            await new Promise<void>((resolve, reject) => {
                sftp.rename(from, to, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        };

        await this.withTimeout(
            posixRename().catch(() => unlinkThenRename()),
            timeoutMs,
            `rename timeout ${from}`
        );
    }

    private async fastPut(localPath: string, remotePath: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
        const sftp = await this.getSftp();
        if (signal?.aborted) {
            throw new Error('Transfer aborted');
        }

        await this.withTimeout(
            new Promise<void>((resolve, reject) => {
                sftp.fastPut(localPath, remotePath, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            }),
            timeoutMs,
            `upload timeout ${path.basename(localPath)}`
        );
    }

    private async fastGet(remotePath: string, localPath: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
        const sftp = await this.getSftp();
        if (signal?.aborted) {
            throw new Error('Transfer aborted');
        }

        await this.withTimeout(
            new Promise<void>((resolve, reject) => {
                sftp.fastGet(remotePath, localPath, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            }),
            timeoutMs,
            `download timeout ${path.basename(remotePath)}`
        );
    }

    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
        let timeout: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<T>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        });

        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    private async waitForQueueDrain(): Promise<void> {
        if (this.queue.snapshot().total === 0) {
            return;
        }

        await new Promise<void>((resolve) => {
            const listener = (snapshot: { total: number }) => {
                if (snapshot.total === 0) {
                    this.queue.off('queueChanged', listener);
                    resolve();
                }
            };
            this.queue.on('queueChanged', listener);
        });
    }

    public getConnectionManager(): ConnectionManager | undefined {
        return this.connection;
    }

    public dispose(): void {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.connection?.dispose();
        this.onStateChangedEmitter.dispose();
        this.onQueueChangedEmitter.dispose();
    }
}
