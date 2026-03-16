import * as vscode from 'vscode';
import { BjornTreeDataProvider, SyncStatus } from './treeDataProvider';

export class BjornFileDecorationProvider implements vscode.FileDecorationProvider {
    private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    public readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> = this.onDidChangeEmitter.event;

    constructor(private readonly treeDataProvider: BjornTreeDataProvider) {
        this.treeDataProvider.onDidChangeStatus((uri) => {
            this.onDidChangeEmitter.fire(uri);
        });
    }

    provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
        const status = this.treeDataProvider.getFileStatus(uri.fsPath);
        switch (status) {
            case SyncStatus.Synced:
                return {
                    badge: 'S',
                    color: new vscode.ThemeColor('testing.iconPassed'),
                    tooltip: 'Bjorn Code: synced'
                };
            case SyncStatus.Pending:
                return {
                    badge: 'P',
                    color: new vscode.ThemeColor('charts.blue'),
                    tooltip: 'Bjorn Code: pending'
                };
            case SyncStatus.Modified:
                return {
                    badge: 'M',
                    color: new vscode.ThemeColor('charts.yellow'),
                    tooltip: 'Bjorn Code: modified'
                };
            case SyncStatus.Error:
                return {
                    badge: 'E',
                    color: new vscode.ThemeColor('testing.iconFailed'),
                    tooltip: 'Bjorn Code: error'
                };
            default:
                return;
        }
    }
}
