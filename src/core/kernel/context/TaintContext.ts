import { CallSiteContext, ContextCache, ContextID } from '../../../../arkanalyzer/out/src/callgraph/pointerAnalysis/context/Context';
import { ContextItemManager } from '../../../../arkanalyzer/out/src/callgraph/pointerAnalysis/context/ContextItem';

export type ContextKSelector = (callerMethodName: string, calleeMethodName: string, defaultK: number) => number;

/**
 * Kind of interprocedural copy edge in the PAG.
 */
export enum CallEdgeType {
    CALL,
    RETURN,
}

/**
 * Metadata for a copy edge that crosses a function boundary.
 */
export interface CallEdgeInfo {
    type: CallEdgeType;
    callSiteId: number;
    callerMethodName: string;
    calleeMethodName: string;
}

/**
 * Context manager for taint facts. The PAG remains context-insensitive; call-site context is tracked at the taint-fact layer.
 */
export class TaintContextManager {
    private contextCache: ContextCache;
    private ctxItemManager: ContextItemManager;
    private k: number;
    private contextKSelector?: ContextKSelector;
    private emptyCID: ContextID;

    constructor(k: number = 1) {
        this.k = k;
        this.contextCache = new ContextCache();
        this.ctxItemManager = new ContextItemManager();

        const emptyCtx = CallSiteContext.newEmpty();
        this.emptyCID = this.contextCache.getOrNewContextID(emptyCtx);
    }

    public setContextKSelector(selector?: ContextKSelector): void {
        this.contextKSelector = selector;
    }

    public getEmptyContextID(): ContextID {
        return this.emptyCID;
    }

    public createCalleeContext(
        callerCtxID: ContextID,
        callSiteId: number,
        callerMethodName?: string,
        calleeMethodName?: string
    ): ContextID {
        if (this.k === 0 && !this.contextKSelector) {
            return this.emptyCID;
        }

        const effectiveK = this.resolveEffectiveK(callerMethodName, calleeMethodName);
        if (effectiveK <= 0) {
            return this.emptyCID;
        }

        const callerCtx = this.contextCache.getContext(callerCtxID);
        const newElems: number[] = [callSiteId];

        if (callerCtx && callerCtx.length() > 0) {
            const oldLen = Math.min(callerCtx.length(), effectiveK - 1);
            for (let i = 0; i < oldLen; i++) {
                newElems.push(callerCtx.get(i));
            }
        }

        const calleeCtx = CallSiteContext.new(newElems);
        return this.contextCache.getOrNewContextID(calleeCtx);
    }

    public restoreCallerContext(calleeCtxID: ContextID): ContextID {
        if (this.k === 0) {
            return this.emptyCID;
        }

        const calleeCtx = this.contextCache.getContext(calleeCtxID);
        if (!calleeCtx || calleeCtx.length() === 0) {
            return this.emptyCID;
        }

        const callerElems: number[] = [];
        for (let i = 1; i < calleeCtx.length(); i++) {
            callerElems.push(calleeCtx.get(i));
        }

        const callerCtx = CallSiteContext.new(callerElems);
        return this.contextCache.getOrNewContextID(callerCtx);
    }

    public getTopElement(ctxID: ContextID): number {
        const ctx = this.contextCache.getContext(ctxID);
        if (!ctx || ctx.length() === 0) return -1;
        return ctx.get(0);
    }

    public getContextString(ctxID: ContextID): string {
        const ctx = this.contextCache.getContext(ctxID);
        if (!ctx) return '';
        return ctx.toString();
    }

    public getK(): number {
        return this.k;
    }

    private resolveEffectiveK(callerMethodName?: string, calleeMethodName?: string): number {
        let selected = this.k;
        if (this.contextKSelector && callerMethodName && calleeMethodName) {
            const dynamicK = this.contextKSelector(callerMethodName, calleeMethodName, this.k);
            if (Number.isFinite(dynamicK)) {
                selected = Math.max(0, Math.floor(dynamicK));
            }
        }
        return selected;
    }
}
