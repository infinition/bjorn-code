import { EventEmitter } from 'events';

export type TransferJobType = 'UPLOAD' | 'DOWNLOAD' | 'DELETE' | 'MKDIR' | 'RENAME';
export type TransferPriority = 'high' | 'normal' | 'low';

export interface TransferJob {
    id: string;
    key: string;
    type: TransferJobType;
    localPath?: string;
    remotePath?: string;
    tempRemotePath?: string;
    tempLocalPath?: string;
    priority: TransferPriority;
    retries: number;
    maxRetries: number;
    abortController: AbortController;
    run: (signal: AbortSignal) => Promise<void>;
}

const priorityRank: Record<TransferPriority, number> = {
    high: 0,
    normal: 1,
    low: 2
};

export class TransferQueue extends EventEmitter {
    private pending: TransferJob[] = [];
    private inflight = new Map<string, TransferJob>();
    private dedupe = new Map<string, TransferJob>();
    private online = true;

    constructor(private maxConcurrency: number) {
        super();
    }

    public updateConcurrency(maxConcurrency: number): void {
        this.maxConcurrency = Math.max(1, maxConcurrency);
        this.schedule();
    }

    public setOnline(value: boolean): void {
        this.online = value;
        if (this.online) {
            this.schedule();
        }
    }

    public enqueue(job: TransferJob): void {
        const existing = this.dedupe.get(job.key);
        if (existing && !this.inflight.has(existing.id)) {
            existing.abortController.abort();
            this.pending = this.pending.filter((j) => j.id !== existing.id);
        }

        this.pending.push(job);
        this.pending.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
        this.dedupe.set(job.key, job);
        this.emit('queueChanged', this.snapshot());
        this.schedule();
    }

    public cancelByKey(key: string): void {
        const existing = this.dedupe.get(key);
        if (!existing) {
            return;
        }

        existing.abortController.abort();
        this.pending = this.pending.filter((j) => j.id !== existing.id);
        this.inflight.delete(existing.id);
        this.dedupe.delete(key);
        this.emit('queueChanged', this.snapshot());
    }

    public snapshot(): { pending: number; inflight: number; total: number } {
        return {
            pending: this.pending.length,
            inflight: this.inflight.size,
            total: this.pending.length + this.inflight.size
        };
    }

    private schedule(): void {
        if (!this.online) {
            return;
        }

        while (this.inflight.size < this.maxConcurrency && this.pending.length > 0) {
            const job = this.pending.shift();
            if (!job) {
                return;
            }

            if (job.abortController.signal.aborted) {
                this.dedupe.delete(job.key);
                continue;
            }

            this.inflight.set(job.id, job);
            this.emit('jobStarted', job);
            void this.execute(job);
        }

        this.emit('queueChanged', this.snapshot());
    }

    private async execute(job: TransferJob): Promise<void> {
        try {
            await job.run(job.abortController.signal);
            this.inflight.delete(job.id);
            this.emit('jobCompleted', job);
            this.dedupe.delete(job.key);
        } catch (err) {
            this.inflight.delete(job.id);

            if (job.abortController.signal.aborted) {
                this.emit('jobCancelled', job);
                this.dedupe.delete(job.key);
            } else if (job.retries < job.maxRetries) {
                job.retries += 1;
                const delayMs = Math.min(30000, Math.pow(2, job.retries) * 500);
                this.emit('jobRetry', job, err);
                setTimeout(() => {
                    this.pending.push(job);
                    this.pending.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
                    this.emit('queueChanged', this.snapshot());
                    this.schedule();
                }, delayMs);
                // Return early — do not emit queueChanged/schedule below since
                // the job will be re-queued after the delay timer fires.
                this.emit('queueChanged', this.snapshot());
                return;
            } else {
                this.emit('jobFailed', job, err);
                this.dedupe.delete(job.key);
            }
        }

        this.emit('queueChanged', this.snapshot());
        this.schedule();
    }
}
