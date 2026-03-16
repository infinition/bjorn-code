import * as vscode from 'vscode';
import type { LogLevel } from './Config';

const LEVEL_RANK: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

export class Logger {
    private level: LogLevel = 'info';

    constructor(private readonly output: vscode.OutputChannel) {}

    public setLevel(level: LogLevel): void {
        this.level = level;
    }

    private timestamp(): string {
        const now = new Date();
        const hh = now.getHours().toString().padStart(2, '0');
        const mm = now.getMinutes().toString().padStart(2, '0');
        const ss = now.getSeconds().toString().padStart(2, '0');
        const ms = now.getMilliseconds().toString().padStart(3, '0');
        return `${hh}:${mm}:${ss}.${ms}`;
    }

    private log(level: LogLevel, tag: string, message: string): void {
        if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) {
            return;
        }
        this.output.appendLine(`[${this.timestamp()}] [${tag}] ${message}`);
    }

    public info(message: string): void {
        this.log('info', 'INFO', message);
    }

    public warn(message: string): void {
        this.log('warn', 'WARN', message);
    }

    public error(message: string): void {
        this.log('error', 'ERROR', message);
    }

    public debug(message: string): void {
        this.log('debug', 'DEBUG', message);
    }
}
