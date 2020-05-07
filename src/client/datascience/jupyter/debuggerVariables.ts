// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { inject, injectable, named } from 'inversify';

import { DebugAdapterTracker, Event, EventEmitter } from 'vscode';
import { DebugProtocol } from 'vscode-debugprotocol';
import { IDebugService } from '../../common/application/types';
import { traceError } from '../../common/logger';
import { IConfigurationService, Resource } from '../../common/types';
import { DataFrameLoading, Identifiers } from '../constants';
import {
    IJupyterDebugService,
    IJupyterVariable,
    IJupyterVariables,
    IJupyterVariablesRequest,
    IJupyterVariablesResponse,
    INotebook
} from '../types';

const DataViewableTypes: Set<string> = new Set<string>(['DataFrame', 'list', 'dict', 'ndarray', 'Series']);
const KnownExcludedVariables = new Set<string>(['In', 'Out', 'exit', 'quit']);

@injectable()
export class DebuggerVariables implements IJupyterVariables, DebugAdapterTracker {
    private imported = false;
    private refreshEventEmitter = new EventEmitter<void>();
    private lastKnownVariables: IJupyterVariable[] = [];
    private topMostFrameId = 0;
    constructor(
        @inject(IJupyterDebugService) @named(Identifiers.MULTIPLEXING_DEBUGSERVICE) private debugService: IDebugService,
        @inject(IConfigurationService) private configService: IConfigurationService
    ) {}

    public get refreshRequired(): Event<void> {
        return this.refreshEventEmitter.event;
    }

    // IJupyterVariables implementation
    public async getVariables(
        _notebook: INotebook,
        request: IJupyterVariablesRequest
    ): Promise<IJupyterVariablesResponse> {
        const result: IJupyterVariablesResponse = {
            executionCount: request.executionCount,
            pageStartIndex: 0,
            pageResponse: [],
            totalCount: 0
        };

        if (this.debugService.activeDebugSession) {
            const startPos = request.startIndex ? request.startIndex : 0;
            const chunkSize = request.pageSize ? request.pageSize : 100;
            result.pageStartIndex = startPos;

            // Do one at a time. All at once doesn't work as they all have to wait for each other anyway
            for (const i = startPos; i < startPos + chunkSize && i < this.lastKnownVariables.length; ) {
                const fullVariable = !this.lastKnownVariables[i].truncated
                    ? this.lastKnownVariables[i]
                    : await this.getFullVariable(this.lastKnownVariables[i]);
                this.lastKnownVariables[i] = fullVariable;
                result.pageResponse.push(fullVariable);
            }
            result.totalCount = this.lastKnownVariables.length;
        }

        return result;
    }

    public async getMatchingVariable(_notebook: INotebook, name: string): Promise<IJupyterVariable | undefined> {
        if (this.debugService.activeDebugSession) {
            return this.lastKnownVariables.find((v) => v.name === name);
        }
    }

    public async getDataFrameInfo(targetVariable: IJupyterVariable, _notebook: INotebook): Promise<IJupyterVariable> {
        if (!this.debugService.activeDebugSession) {
            // No active server just return the unchanged target variable
            return targetVariable;
        }

        // See if we imported or not into the kernel our special function
        if (!this.imported) {
            this.imported = await this.importDataFrameScripts();
        }

        // Then eval calling the main function with our target variable
        const results = await this.evaluate(
            `${DataFrameLoading.DataFrameInfoFunc}(${targetVariable.name})`,
            // tslint:disable-next-line: no-any
            (targetVariable as any).frameId
        );

        // Results should be the updated variable.
        return {
            ...targetVariable,
            ...JSON.parse(results.result.slice(1, -1))
        };
    }

    public async getDataFrameRows(
        targetVariable: IJupyterVariable,
        _notebook: INotebook,
        start: number,
        end: number
    ): Promise<{}> {
        // Run the get dataframe rows script
        if (!this.debugService.activeDebugSession) {
            // No active server just return no rows
            return {};
        }

        // See if we imported or not into the kernel our special function
        if (!this.imported) {
            this.imported = await this.importDataFrameScripts();
        }

        // Then eval calling the main function with our target variable
        const minnedEnd = Math.min(end, targetVariable.rowCount || 0);
        const results = await this.evaluate(
            `${DataFrameLoading.DataFrameRowFunc}(${targetVariable.name}, ${start}, ${minnedEnd})`,
            // tslint:disable-next-line: no-any
            (targetVariable as any).frameId
        );

        // Results should be the row.
        return JSON.parse(results.result.slice(1, -1));
    }

    public onDidSendMessage(message: DebugProtocol.Response) {
        // If using the interactive debugger, update our variables.
        if (message.type === 'response' && message.command === 'variables') {
            // tslint:disable-next-line: no-suspicious-comment
            // TODO: Figure out what resource to use
            this.updateVariables(undefined, message as DebugProtocol.VariablesResponse);
        } else if (message.type === 'response' && message.command === 'stackTrace') {
            // This should be the top frame. We need to use this to compute the value of a variable
            this.updateStackFrame(message as DebugProtocol.StackTraceResponse);
        }
    }

    // tslint:disable-next-line: no-any
    private async evaluate(code: string, frameId?: number): Promise<any> {
        if (this.debugService.activeDebugSession) {
            return this.debugService.activeDebugSession.customRequest('evaluate', {
                expression: code,
                frameId: frameId || this.topMostFrameId,
                context: 'repl'
            });
        }
        throw Error('Debugger is not active, cannot evaluate.');
    }

    private async importDataFrameScripts(): Promise<boolean> {
        try {
            await this.evaluate(DataFrameLoading.DataFrameSysImport);
            await this.evaluate(DataFrameLoading.DataFrameInfoImport);
            await this.evaluate(DataFrameLoading.DataFrameRowImport);
            await this.evaluate(DataFrameLoading.VariableInfoImport);
            return true;
        } catch (exc) {
            traceError('Error attempting to import in debugger', exc);
            return false;
        }
    }

    private updateStackFrame(stackResponse: DebugProtocol.StackTraceResponse) {
        if (stackResponse.body.stackFrames[0]) {
            this.topMostFrameId = stackResponse.body.stackFrames[0].id;
        }
    }

    private async getFullVariable(variable: IJupyterVariable): Promise<IJupyterVariable> {
        // See if we imported or not into the kernel our special function
        if (!this.imported) {
            this.imported = await this.importDataFrameScripts();
        }

        // Then eval calling the variable info function with our target variable
        const results = await this.evaluate(
            `${DataFrameLoading.VariableInfoFunc}(${variable.name})`,
            // tslint:disable-next-line: no-any
            (variable as any).frameId
        );

        // Results should be the updated variable.
        return {
            ...variable,
            ...JSON.parse(results.result.slice(1, -1))
        };
    }

    private updateVariables(resource: Resource, variablesResponse: DebugProtocol.VariablesResponse) {
        const exclusionList = this.configService.getSettings(resource).datascience.variableExplorerExclude
            ? this.configService.getSettings().datascience.variableExplorerExclude?.split(';')
            : [];

        const allowedVariables = variablesResponse.body.variables.filter((v) => {
            if (!v.name || !v.type || !v.value) {
                return false;
            }
            if (exclusionList && exclusionList.includes(v.type)) {
                return false;
            }
            if (v.name.startsWith('_')) {
                return false;
            }
            if (KnownExcludedVariables.has(v.name)) {
                return false;
            }
            if (v.type === 'NoneType') {
                return false;
            }
            return true;
        });

        this.lastKnownVariables = allowedVariables.map((v) => {
            return {
                name: v.name,
                type: v.type!,
                count: 0,
                shape: '',
                size: 0,
                supportsDataExplorer: DataViewableTypes.has(v.type || ''),
                value: v.value,
                truncated: true,
                frameId: v.variablesReference
            };
        });

        this.refreshEventEmitter.fire();
    }
}
