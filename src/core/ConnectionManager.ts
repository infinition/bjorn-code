import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AcidBjornSettings, loadPrivateKey } from './Config';
import { Logger } from './Logger';

export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'SYNCING' | 'ERROR';

interface TargetKey {
    host: string;
    port: number;
    username: string;
    remotePath: string;
}

function keyFor(target: TargetKey): string {
    return `${target.username}@${target.host}:${target.port}:${target.remotePath}`;
}

interface ManagedConnection {
    state: ConnectionState;
    client?: Client;
    sftp?: SFTPWrapper;
    connectPromise?: Promise<SFTPWrapper>;
    retries: number;
    reconnectTimer?: NodeJS.Timeout;
    keepAliveTimer?: NodeJS.Timeout;
}

export class ConnectionManager extends EventEmitter {
    private static instances = new Map<string, ConnectionManager>();

    public static getOrCreate(target: TargetKey, settings: AcidBjornSettings, logger: Logger): ConnectionManager {
        const key = keyFor(target);
        const existing = ConnectionManager.instances.get(key);
        if (existing) {
            existing.settings = settings;
            return existing;
        }

        const instance = new ConnectionManager(key, target, settings, logger);
        ConnectionManager.instances.set(key, instance);
        return instance;
    }

    public static disposeAll(): void {
        for (const instance of ConnectionManager.instances.values()) {
            instance.dispose();
        }
        ConnectionManager.instances.clear();
    }

    private conn: ManagedConnection = {
        state: 'DISCONNECTED',
        retries: 0
    };
    private manualDisconnect = false;

    private constructor(
        private readonly instanceKey: string,
        private readonly target: TargetKey,
        private settings: AcidBjornSettings,
        private readonly logger: Logger
    ) {
        super();
    }

    public get state(): ConnectionState {
        return this.conn.state;
    }

    public setState(state: ConnectionState): void {
        if (this.conn.state !== state) {
            this.conn.state = state;
            this.emit('stateChanged', state);
        }
    }

    public async getSftp(): Promise<SFTPWrapper> {
        this.manualDisconnect = false;
        if (this.conn.sftp && this.conn.state === 'CONNECTED') {
            return this.conn.sftp;
        }

        if (this.conn.connectPromise) {
            return this.conn.connectPromise;
        }

        this.conn.connectPromise = this.createConnection();
        try {
            return await this.conn.connectPromise;
        } finally {
            this.conn.connectPromise = undefined;
        }
    }

    private resolveKnownHostsPath(): string | undefined {
        const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
        if (!home) {
            return undefined;
        }
        const khPath = path.join(home, '.ssh', 'known_hosts');
        try {
            if (fs.existsSync(khPath)) {
                return khPath;
            }
        } catch {
            // ignore
        }
        return undefined;
    }

    private async createConnection(): Promise<SFTPWrapper> {
        this.manualDisconnect = false;
        this.setState('CONNECTING');
        this.clearReconnect();

        const privateKey = loadPrivateKey(this.settings);
        const connectConfig: ConnectConfig = {
            host: this.target.host,
            port: this.target.port,
            username: this.target.username,
            password: this.settings.password,
            privateKey,
            readyTimeout: this.settings.connectTimeoutMs,
            keepaliveInterval: 15000,
            keepaliveCountMax: 3,
            tryKeyboard: true
        };

        // Accept all host keys — Pi on local network, key checking is impractical
        // when IPs change. If known_hosts exists we still skip verification since
        // the Pi's key may rotate after re-flashes.
        connectConfig.hostVerifier = () => true;

        return new Promise<SFTPWrapper>((resolve, reject) => {
            const client = new Client();
            let settled = false;

            const connectTimeout = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                this.logger.error('SSH connect timeout');
                this.setState('ERROR');
                client.end();
                this.scheduleReconnect();
                reject(new Error('SSH timeout'));
            }, this.settings.connectTimeoutMs + 500);

            client.on('ready', () => {
                client.sftp((err, sftp) => {
                    if (settled) {
                        return;
                    }
                    if (err || !sftp) {
                        settled = true;
                        clearTimeout(connectTimeout);
                        this.setState('ERROR');
                        this.scheduleReconnect();
                        reject(err ?? new Error('Failed to initialize SFTP'));
                        return;
                    }

                    settled = true;
                    clearTimeout(connectTimeout);
                    this.conn.client = client;
                    this.conn.sftp = sftp;
                    this.conn.retries = 0;
                    this.setState('CONNECTED');
                    this.startKeepAlive();
                    resolve(sftp);
                });
            });

            client.on('error', (err) => {
                this.logger.error(`SSH error: ${err.message}`);
                if (!settled) {
                    settled = true;
                    clearTimeout(connectTimeout);
                    this.setState('ERROR');
                    this.scheduleReconnect();
                    reject(err);
                }
            });

            client.on('close', () => {
                this.cleanupConnectionOnly();
                this.setState('DISCONNECTED');
                if (!this.manualDisconnect) {
                    this.scheduleReconnect();
                }
            });

            client.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
                if (prompts.length > 0 && this.settings.password) {
                    finish([this.settings.password]);
                } else {
                    finish([]);
                }
            });

            try {
                client.connect(connectConfig);
            } catch (err) {
                settled = true;
                clearTimeout(connectTimeout);
                this.setState('ERROR');
                this.scheduleReconnect();
                reject(err as Error);
            }
        });
    }

    private startKeepAlive(): void {
        this.clearKeepAlive();
        this.conn.keepAliveTimer = setInterval(() => {
            const client = this.conn.client;
            if (!client) {
                return;
            }

            client.exec('echo acid-bjorn-keepalive', (err, stream) => {
                if (err) {
                    this.logger.warn(`Keepalive failed: ${err.message}`);
                    return;
                }
                stream.on('close', () => {
                    stream.removeAllListeners();
                });
            });
        }, 30000);
    }

    private scheduleReconnect(): void {
        if (this.manualDisconnect) {
            return;
        }
        if (this.conn.reconnectTimer) {
            return;
        }

        this.conn.retries += 1;
        const backoff = Math.min(30000, Math.pow(2, Math.min(this.conn.retries, 5)) * 1000);
        this.logger.warn(`Scheduling reconnect in ${backoff}ms`);

        this.conn.reconnectTimer = setTimeout(() => {
            this.conn.reconnectTimer = undefined;
            if (this.conn.state === 'CONNECTED' || this.conn.state === 'CONNECTING') {
                return;
            }
            this.getSftp().catch((err) => {
                this.logger.error(`Reconnect failed: ${err.message}`);
            });
        }, backoff);
    }

    private cleanupConnectionOnly(): void {
        this.clearKeepAlive();
        this.conn.sftp = undefined;
        this.conn.client = undefined;
    }

    private clearKeepAlive(): void {
        if (this.conn.keepAliveTimer) {
            clearInterval(this.conn.keepAliveTimer);
            this.conn.keepAliveTimer = undefined;
        }
    }

    private clearReconnect(): void {
        if (this.conn.reconnectTimer) {
            clearTimeout(this.conn.reconnectTimer);
            this.conn.reconnectTimer = undefined;
        }
    }

    public async withExec(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
        let stdout = '';
        let stderr = '';
        const result = await this.execStreaming(command, timeoutMs, (chunk) => {
            stdout += chunk;
        }, (chunk) => {
            stderr += chunk;
        });

        return { stdout, stderr, code: result.code };
    }

    public async execStreaming(
        command: string,
        timeoutMs: number,
        onStdout?: (chunk: string) => void,
        onStderr?: (chunk: string) => void
    ): Promise<{ code: number | null }> {
        const sftpReady = await this.getSftp();
        if (!sftpReady) {
            throw new Error('SSH not connected');
        }

        return new Promise((resolve, reject) => {
            const client = this.conn.client;
            if (!client) {
                reject(new Error('No active SSH client'));
                return;
            }

            let code: number | null = null;
            const timeout = setTimeout(() => {
                reject(new Error('Remote command timeout'));
            }, timeoutMs);

            client.exec(command, (err, stream) => {
                if (err) {
                    clearTimeout(timeout);
                    reject(err);
                    return;
                }

                stream.on('data', (chunk: Buffer | string) => {
                    onStdout?.(chunk.toString());
                });

                stream.stderr.on('data', (chunk: Buffer | string) => {
                    onStderr?.(chunk.toString());
                });

                stream.on('exit', (exitCode: number) => {
                    code = exitCode;
                });

                stream.on('close', () => {
                    clearTimeout(timeout);
                    resolve({ code });
                });
            });
        });
    }

    public dispose(): void {
        this.clearReconnect();
        this.clearKeepAlive();
        this.conn.client?.end();
        this.cleanupConnectionOnly();
        this.setState('DISCONNECTED');
        ConnectionManager.instances.delete(this.instanceKey);
    }

    public disconnect(): void {
        this.manualDisconnect = true;
        this.dispose();
    }
}
