import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AcidBjornSettings {
    enabled: boolean;
    autoSync: boolean;
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKeyPath?: string;
    remotePath: string;
    localPath?: string;
    exclusions: string[];
    includes: string[];
    syncMode: 'mirror' | 'selective';
    maxConcurrency: number;
    maxRetries: number;
    connectTimeoutMs: number;
    operationTimeoutMs: number;
    pollingIntervalSec: number;
    pythonPath: string;
    sudoByDefault: boolean;
    services: string[];
    logLevel: LogLevel;
    bjornServiceName: string;
}

export interface WorkspaceTarget {
    workspaceFolder: vscode.WorkspaceFolder;
    workspaceRoot: string;
    settings: AcidBjornSettings;
}

const MANAGED_DIR_CONTAINER = '.acid-bjorn';
const MANAGED_STATE_FILE = '.managed-root.json';

function expandHome(p?: string): string | undefined {
    if (!p) {
        return undefined;
    }
    if (p.startsWith('~/') || p.startsWith('~\\') || p === '~') {
        const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
        return path.join(home, p.slice(1));
    }
    return p;
}

export function getWorkspaceTarget(resource?: vscode.Uri): WorkspaceTarget | undefined {
    const workspaceFolder = resource
        ? vscode.workspace.getWorkspaceFolder(resource)
        : vscode.workspace.workspaceFolders?.[0];

    if (!workspaceFolder) {
        return undefined;
    }

    const config = vscode.workspace.getConfiguration('acidBjorn', workspaceFolder.uri);
    const localPath = config.get<string>('localPath')?.trim();
    const workspaceRoot = resolveManagedWorkspaceRoot(workspaceFolder, localPath);

    const settings: AcidBjornSettings = {
        enabled: config.get<boolean>('enabled', false),
        autoSync: config.get<boolean>('autoSync', true),
        host: config.get<string>('remoteIp', ''),
        port: config.get<number>('port', 22),
        username: config.get<string>('username', ''),
        password: config.get<string>('password') || undefined,
        privateKeyPath: expandHome(config.get<string>('privateKeyPath') || undefined),
        remotePath: config.get<string>('remotePath', ''),
        localPath,
        exclusions: config.get<string[]>('exclusions', []),
        includes: config.get<string[]>('includes', ['**/*']),
        syncMode: config.get<'mirror' | 'selective'>('syncMode', 'mirror'),
        maxConcurrency: Math.max(1, Math.min(10, config.get<number>('maxConcurrency', 3))),
        maxRetries: Math.max(0, Math.min(10, config.get<number>('maxRetries', 3))),
        connectTimeoutMs: Math.max(1000, config.get<number>('connectTimeoutMs', 20000)),
        operationTimeoutMs: Math.max(1000, config.get<number>('operationTimeoutMs', 30000)),
        pollingIntervalSec: Math.max(1, config.get<number>('pollingIntervalSec', 10)),
        pythonPath: config.get<string>('pythonPath', '/usr/bin/python3'),
        sudoByDefault: config.get<boolean>('sudoByDefault', false),
        services: config.get<string[]>('services', []),
        logLevel: config.get<LogLevel>('logLevel', 'info'),
        bjornServiceName: config.get<string>('bjornServiceName', 'bjorn')
    };

    return {
        workspaceFolder,
        workspaceRoot,
        settings
    };
}

function formatTimestamp(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function resolveManagedWorkspaceRoot(workspaceFolder: vscode.WorkspaceFolder, configuredLocalPath?: string): string {
    if (configuredLocalPath && configuredLocalPath.length > 0) {
        return configuredLocalPath;
    }

    const workspaceFsPath = workspaceFolder.uri.fsPath;
    const managedContainer = path.join(workspaceFsPath, MANAGED_DIR_CONTAINER);
    const stateFile = path.join(managedContainer, MANAGED_STATE_FILE);

    try {
        fs.mkdirSync(managedContainer, { recursive: true });

        if (fs.existsSync(stateFile)) {
            const raw = fs.readFileSync(stateFile, 'utf8');
            const parsed = JSON.parse(raw) as { folderName?: string };
            if (parsed.folderName && /^[A-Za-z0-9_.-]+$/.test(parsed.folderName)) {
                const existingRoot = path.join(managedContainer, parsed.folderName);
                fs.mkdirSync(existingRoot, { recursive: true });
                return existingRoot;
            }
        }
    } catch {
        return workspaceFsPath;
    }

    const folderName = `Bjorn_${formatTimestamp(new Date())}`;
    const managedRoot = path.join(managedContainer, folderName);
    try {
        fs.mkdirSync(managedRoot, { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify({ folderName }, null, 2), 'utf8');
        return managedRoot;
    } catch {
        return workspaceFsPath;
    }
}

export function loadPrivateKey(settings: AcidBjornSettings): Buffer | undefined {
    if (!settings.privateKeyPath) {
        return undefined;
    }

    try {
        if (fs.existsSync(settings.privateKeyPath)) {
            return fs.readFileSync(settings.privateKeyPath);
        }
    } catch {
        return undefined;
    }

    return undefined;
}
