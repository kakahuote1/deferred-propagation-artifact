import { Scene } from "../../../../arkanalyzer/out/src/Scene";
import { Pag, PagNode } from "../../../../arkanalyzer/out/src/callgraph/pointerAnalysis/Pag";
import { Local } from "../../../../arkanalyzer/out/src/core/base/Local";
import { Constant } from "../../../../arkanalyzer/out/src/core/base/Constant";
import { ArkAssignStmt } from "../../../../arkanalyzer/out/src/core/base/Stmt";
import { ArkInstanceInvokeExpr, ArkNormalBinopExpr, ArkPtrInvokeExpr, ArkStaticInvokeExpr } from "../../../../arkanalyzer/out/src/core/base/Expr";
import { TaintFact } from "../model/TaintFact";
import { TaintTracker } from "../model/TaintTracker";
import { toContainerFieldKey } from "../model/ContainerSlotKeys";
import {
    collectParameterAssignStmts,
    mapInvokeArgsToParamAssigns,
    resolveCalleeCandidates,
    resolveConcreteReceiverOwnerName,
    resolveMethodsFromCallable,
} from "../../substrate/queries/CalleeResolver";
import { resolveExistingPagNodes } from "../contracts/PagNodeResolution";
import {
    RuleEndpoint,
    TransferRule,
    normalizeEndpoint,
} from "../../rules/RuleSchema";
import { hasApiEffectIdentity, type ResolvedEndpointBinding } from "../../api/ApiOccurrenceIdentity";
import type { ApiEffectRuntimeIndexLike } from "../../api/effects";
import type { AssetEndpoint } from "../../assets/schema";
import { resolveSdkImportScopeCandidates } from "../../substrate/queries/SdkProvenance";
import {
    resolvePromiseFulfillmentSourceNodeIdsFromInvoke,
    resolvePromiseRejectionSourceNodeIdsFromInvoke,
} from "../handoff/ExecutionHandoffContractBindingResolver";
import type {
    EndpointDescriptor,
    InvokeSite,
    MethodEntityIndex,
    RuntimeRule,
    RuntimeRuleBucketIndex,
    SceneRuleCacheStats,
    TransferNoCandidateCallsite,
    SharedSceneRuleCache,
    TransferExecutionResult,
    TransferExecutionStats,
    TransferExecutionWithStats,
} from "./TransferTypes";
import { buildNoCandidateCallsiteRecord } from "./NoCandidateSurface";

export type {
    EndpointDescriptor,
    InvokeSite,
    MethodEntityIndex,
    RuntimeRule,
    RuntimeRuleBucketIndex,
    SceneRuleCacheStats,
    TransferNoCandidateCallsite,
    SharedSceneRuleCache,
    TransferExecutionResult,
    TransferExecutionStats,
    TransferExecutionWithStats,
} from "./TransferTypes";

export class ConfigBasedTransferExecutor {
    private static sceneRuleCache = new WeakMap<Scene, Map<string, SharedSceneRuleCache>>();
    private static readonly sceneRuleCacheStats: SceneRuleCacheStats = {
        hitCount: 0,
        missCount: 0,
        disabledCount: 0,
    };
    private readonly perfMode: "optimized" | "baseline";
    private readonly runtimeRules: RuntimeRule[];
    private readonly ruleBuckets: RuntimeRuleBucketIndex;
    private stmtOwner: Map<any, any>;
    private invokeSiteByStmt: Map<any, InvokeSite>;
    private siteRuleCandidateIndex: Map<any, RuntimeRule[]>;
    private readonly objectAliasLocalCache = new Map<number, Local[]>();
    private readonly localInvokeSiteCache = new Map<Local, InvokeSite[]>();
    private readonly objectInvokeSiteCache = new Map<number, InvokeSite[]>();
    private readonly initializerMethodsForTypeCache = new Map<string, any[]>();
    private readonly initializerLocalNamesForValueCache = new WeakMap<object, string[]>();
    private directInvokeSitesByLocalName?: Map<string, InvokeSite[]>;
    private objectPayloadInvokeSitesByLocalName?: Map<string, InvokeSite[]>;
    private readonly ruleExecutionDedupCache = new Set<string>();
    private readonly stmtRuntimeKeyId = new WeakMap<object, number>();
    private stmtRuntimeKeySeq = 1;
    private readonly scene?: Scene;
    private readonly apiEffectRuntimeIndex?: ApiEffectRuntimeIndexLike;
    private paramArgAliasMap: Map<Local, any[]>;

    public static clearSceneRuleCache(): void {
        ConfigBasedTransferExecutor.sceneRuleCache = new WeakMap<Scene, Map<string, SharedSceneRuleCache>>();
    }

    public static resetSceneRuleCacheStats(): void {
        ConfigBasedTransferExecutor.sceneRuleCacheStats.hitCount = 0;
        ConfigBasedTransferExecutor.sceneRuleCacheStats.missCount = 0;
        ConfigBasedTransferExecutor.sceneRuleCacheStats.disabledCount = 0;
    }

    public static getSceneRuleCacheStats(): SceneRuleCacheStats {
        return {
            hitCount: ConfigBasedTransferExecutor.sceneRuleCacheStats.hitCount,
            missCount: ConfigBasedTransferExecutor.sceneRuleCacheStats.missCount,
            disabledCount: ConfigBasedTransferExecutor.sceneRuleCacheStats.disabledCount,
        };
    }

    constructor(rules: TransferRule[] = [], scene?: Scene, apiEffectRuntimeIndex?: ApiEffectRuntimeIndexLike) {
        this.scene = scene;
        this.apiEffectRuntimeIndex = apiEffectRuntimeIndex;
        this.perfMode = this.resolvePerfModeFromEnv();
        this.stmtOwner = new Map<any, any>();
        this.invokeSiteByStmt = new Map<any, InvokeSite>();
        this.siteRuleCandidateIndex = new Map<any, RuntimeRule[]>();
        this.paramArgAliasMap = new Map<Local, any[]>();

        if (scene) {
            const cacheEnabled = this.isSceneRuleCacheEnabled() && !apiEffectRuntimeIndex;
            const cacheKey = this.buildSceneRuleCacheKey(rules || []);
            if (cacheEnabled) {
                const shared = this.getSharedSceneRuleCache(scene, cacheKey);
                if (shared) {
                    ConfigBasedTransferExecutor.sceneRuleCacheStats.hitCount++;
                    this.runtimeRules = shared.runtimeRules;
                    this.ruleBuckets = shared.ruleBuckets;
                    this.stmtOwner = shared.stmtOwner;
                    this.invokeSiteByStmt = shared.invokeSiteByStmt;
                    this.siteRuleCandidateIndex = shared.siteRuleCandidateIndex;
                    this.paramArgAliasMap = shared.paramArgAliasMap || new Map<Local, any[]>();
                    return;
                }
                ConfigBasedTransferExecutor.sceneRuleCacheStats.missCount++;
            } else {
                ConfigBasedTransferExecutor.sceneRuleCacheStats.disabledCount++;
            }

            const methodEntityIndex = this.buildMethodEntityIndex(scene);
            this.runtimeRules = this.compileRules(rules || [], methodEntityIndex);
            this.ruleBuckets = this.buildRuleBucketIndex(this.runtimeRules);
            for (const method of scene.getMethods()) {
                const cfg = method.getCfg();
                if (!cfg) continue;
                for (const stmt of cfg.getStmts()) {
                    this.stmtOwner.set(stmt, method);
                }
            }
            if (this.perfMode === "optimized") {
                this.prebuildInvokeSiteIndex();
                this.prebuildSiteRuleCandidateIndex();
            }
            this.paramArgAliasMap = this.buildParamArgAliasMap(scene);

            if (cacheEnabled) {
                this.setSharedSceneRuleCache(scene, cacheKey, {
                    runtimeRules: this.runtimeRules,
                    ruleBuckets: this.ruleBuckets,
                    stmtOwner: this.stmtOwner,
                    invokeSiteByStmt: this.invokeSiteByStmt,
                    siteRuleCandidateIndex: this.siteRuleCandidateIndex,
                    paramArgAliasMap: this.paramArgAliasMap,
                });
            }
            return;
        }

        this.runtimeRules = this.compileRules(rules || []);
        this.ruleBuckets = this.buildRuleBucketIndex(this.runtimeRules);
    }

    private getSharedSceneRuleCache(scene: Scene, key: string): SharedSceneRuleCache | undefined {
        const sceneMap = ConfigBasedTransferExecutor.sceneRuleCache.get(scene);
        if (!sceneMap) return undefined;
        return sceneMap.get(key);
    }

    private setSharedSceneRuleCache(scene: Scene, key: string, cache: SharedSceneRuleCache): void {
        let sceneMap = ConfigBasedTransferExecutor.sceneRuleCache.get(scene);
        if (!sceneMap) {
            sceneMap = new Map<string, SharedSceneRuleCache>();
            ConfigBasedTransferExecutor.sceneRuleCache.set(scene, sceneMap);
        }
        sceneMap.set(key, cache);
    }

    private buildParamArgAliasMap(scene: Scene): Map<Local, any[]> {
        const aliasSets = new Map<Local, Set<any>>();
        const methodsBySignature = new Map<string, any>();
        for (const method of scene.getMethods()) {
            const sig = method.getSignature?.()?.toString?.();
            if (!sig) continue;
            methodsBySignature.set(sig, method);
        }

        for (const caller of scene.getMethods()) {
            const cfg = caller.getCfg?.();
            if (!cfg) continue;
            for (const stmt of cfg.getStmts()) {
                if (!stmt?.containsInvokeExpr || !stmt.containsInvokeExpr()) continue;
                const invokeExpr = stmt.getInvokeExpr?.();
                if (!invokeExpr) continue;
                const calleeSig = invokeExpr.getMethodSignature?.()?.toString?.() || "";
                if (!calleeSig) continue;
                const callee = methodsBySignature.get(calleeSig);
                if (!callee) continue;
                const paramStmts = collectParameterAssignStmts(callee);
                if (paramStmts.length === 0) continue;
                const args = invokeExpr.getArgs ? invokeExpr.getArgs() : [];
                const argParamPairs = mapInvokeArgsToParamAssigns(invokeExpr, args, paramStmts);
                for (const pair of argParamPairs) {
                    const leftOp = pair.paramStmt.getLeftOp?.();
                    if (!(leftOp instanceof Local)) continue;
                    let values = aliasSets.get(leftOp);
                    if (!values) {
                        values = new Set<any>();
                        aliasSets.set(leftOp, values);
                    }
                    values.add(pair.arg);
                }
            }
        }

        const aliasMap = new Map<Local, any[]>();
        for (const [local, values] of aliasSets.entries()) {
            aliasMap.set(local, [...values]);
        }
        return aliasMap;
    }

    private buildSceneRuleCacheKey(rules: TransferRule[]): string {
        const normalizedRules = rules.map((rule, index) => {
            const fromN = normalizeEndpoint(rule.from);
            const toN = normalizeEndpoint(rule.to);
            return {
                idx: index,
                id: rule.id || "",
                fromEndpoint: fromN.endpoint,
                fromPath: fromN.path ?? [],
                fromPathFrom: fromN.pathFrom || "",
                fromSlotKind: fromN.slotKind || "",
                fromTaintScope: fromN.taintScope || "",
                toEndpoint: toN.endpoint,
                toPath: toN.path ?? [],
                toPathFrom: toN.pathFrom || "",
                toSlotKind: toN.slotKind || "",
                toTaintScope: toN.taintScope || "",
                apiAssetId: rule.apiEffect?.assetId || "",
                canonicalApiId: rule.apiEffect?.canonicalApiId || "",
                apiSurfaceId: rule.apiEffect?.surfaceId || "",
                apiBindingId: rule.apiEffect?.bindingId || "",
                apiEffectTemplateId: rule.apiEffect?.effectTemplateId || "",
            };
        });
        return `${this.perfMode}|${JSON.stringify(normalizedRules)}`;
    }

    public executeFromTaintedLocal(
        taintedLocal: Local,
        source: string,
        contextID: number,
        pag: Pag,
        tracker?: TaintTracker
    ): TransferExecutionResult[] {
        const localNodes = pag.getNodesByValue(taintedLocal);
        if (!localNodes || localNodes.size === 0) return [];
        const nodeId = localNodes.values().next().value as number;
        const fact = new TaintFact(pag.getNode(nodeId) as PagNode, source, contextID);
        return this.executeFromTaintedFact(fact, pag, tracker);
    }

    public executeFromTaintedFact(
        taintedFact: TaintFact,
        pag: Pag,
        tracker?: TaintTracker
    ): TransferExecutionResult[] {
        return this.executeFromTaintedFactWithStats(taintedFact, pag, tracker).results;
    }

    public executeFromTaintedFactWithStats(
        taintedFact: TaintFact,
        pag: Pag,
        tracker?: TaintTracker
    ): TransferExecutionWithStats {
        const stats = this.createEmptyStats();
        if (this.runtimeRules.length === 0) {
            return { results: [], stats };
        }

        const t0 = process.hrtime.bigint();
        stats.factCount = 1;

        const sites = this.collectInvokeSitesFromFact(taintedFact, pag);
        stats.invokeSiteCount = sites.length;
        if (sites.length === 0) {
            stats.elapsedMs = this.elapsedMsSince(t0);
            return { results: [], stats };
        }

        const results: TransferExecutionResult[] = [];
        const seenResultFacts = new Set<string>();
        const noCandidateCallsiteMap = new Map<string, TransferNoCandidateCallsite>();
        for (const site of sites) {
            const candidateRules = this.resolveCandidateRulesForSite(site);
            if (candidateRules.length === 0) {
                const owner = this.stmtOwner.get(site.stmt);
                const noCandidate = buildNoCandidateCallsiteRecord(site, owner, this.apiEffectRuntimeIndex);
                const key = `${noCandidate.canonicalApiId || ""}|${noCandidate.calleeSignature}|${noCandidate.method}|${noCandidate.invokeKind}|${noCandidate.argCount}|${noCandidate.sourceFile}`;
                const existing = noCandidateCallsiteMap.get(key);
                if (existing) {
                    existing.count += 1;
                } else {
                    noCandidateCallsiteMap.set(key, noCandidate);
                }
            }
            for (const runtimeRule of candidateRules) {
                stats.ruleCheckCount++;

                if (this.perfMode === "optimized") {
                    const dedupKey = this.buildRuleExecutionDedupKey(taintedFact.taintId, site, runtimeRule.rule.id);
                    if (this.ruleExecutionDedupCache.has(dedupKey)) {
                        stats.dedupSkipCount++;
                        continue;
                    }
                    this.ruleExecutionDedupCache.add(dedupKey);
                }

                // Exact match kinds are pre-filtered by callsite candidate index.
                stats.ruleMatchCount++;

                const descriptors = this.resolveTransferDescriptorsForSite(runtimeRule.rule, site);
                if (!descriptors) continue;
                const fromDescriptor = descriptors.from;
                stats.endpointCheckCount++;
                if (!this.endpointMatchesFact(fromDescriptor, site, taintedFact, pag, tracker)) continue;
                stats.endpointMatchCount++;

                const toDescriptor = descriptors.to;
                const targetFacts = this.resolveTargetFacts(toDescriptor, site, taintedFact.source, taintedFact.contextID, pag);
                for (const fact of targetFacts) {
                    const resultKey = `${runtimeRule.rule.id}|${site.signature}|${fact.taintId}`;
                    if (seenResultFacts.has(resultKey)) continue;
                    seenResultFacts.add(resultKey);
                    results.push({
                        ruleId: runtimeRule.rule.id,
                        callSignature: site.signature,
                        to: toDescriptor.endpoint,
                        fact,
                    });
                }
            }
        }

        stats.resultCount = results.length;
        stats.noCandidateCallsites = [...noCandidateCallsiteMap.values()]
            .sort((a, b) => b.count - a.count || a.calleeSignature.localeCompare(b.calleeSignature))
            .slice(0, 64);
        stats.elapsedMs = this.elapsedMsSince(t0);
        return { results, stats };
    }

    private compileRules(rules: TransferRule[], index?: MethodEntityIndex): RuntimeRule[] {
        void index;
        const out: RuntimeRule[] = [];
        for (const rule of rules) {
            if (!hasApiEffectIdentity(rule)) continue;
            out.push({ rule });
        }
        return out;
    }

    private collectInvokeSitesFromFact(fact: TaintFact, pag: Pag): InvokeSite[] {
        const value = fact.node.getValue();
        if (value instanceof Local) {
            return this.collectInvokeSitesForLocal(value);
        }

        const objectId = fact.node.getID();
        if (this.objectInvokeSiteCache.has(objectId)) {
            return this.objectInvokeSiteCache.get(objectId)!;
        }
        const aliases = this.collectAliasLocalsForObject(objectId, pag);
        const out: InvokeSite[] = [];
        const seen = new Set<any>();
        for (const local of aliases) {
            const localSites = this.collectInvokeSitesForLocal(local);
            for (const site of localSites) {
                if (seen.has(site.stmt)) continue;
                seen.add(site.stmt);
                out.push(site);
            }
        }
        this.objectInvokeSiteCache.set(objectId, out);
        return out;
    }

    private collectAliasLocalsForObject(objectId: number, pag: Pag): Local[] {
        const cached = this.objectAliasLocalCache.get(objectId);
        if (cached) return cached;

        const out: Local[] = [];
        const seenLocals = new Set<string>();
        for (const rawNode of pag.getNodesIter()) {
            const node = rawNode as PagNode;
            const value = node.getValue();
            if (!(value instanceof Local)) continue;
            const pts = node.getPointTo();
            if (!pts || !pts.contains || !pts.contains(objectId)) continue;
            const methodSig = value.getDeclaringStmt?.()?.getCfg?.()?.getDeclaringMethod?.()?.getSignature?.()?.toString?.() || "";
            const key = `${methodSig}::${value.getName()}`;
            if (seenLocals.has(key)) continue;
            seenLocals.add(key);
            out.push(value);
        }
        this.objectAliasLocalCache.set(objectId, out);
        return out;
    }

    private collectInvokeSitesForLocal(local: Local): InvokeSite[] {
        const cached = this.localInvokeSiteCache.get(local);
        if (cached) return cached;

        const out: InvokeSite[] = [];
        const seenStmts = new Set<any>();

        const pushInvokeSiteByStmt = (stmt: any): void => {
            if (!stmt) return;
            if (seenStmts.has(stmt)) return;
            const site = this.getOrCreateInvokeSite(stmt);
            if (!site) return;
            if (!this.shouldEvaluateInvokeSiteForFact(site)) return;
            seenStmts.add(stmt);
            out.push(site);
        };

        for (const stmt of local.getUsedStmts()) {
            pushInvokeSiteByStmt(stmt);
        }

        for (const site of this.collectDirectInvokeSitesForLocal(local)) {
            if (seenStmts.has(site.stmt)) continue;
            seenStmts.add(site.stmt);
            out.push(site);
        }

        for (const site of this.collectObjectPayloadInvokeSitesForLocal(local)) {
            if (seenStmts.has(site.stmt)) continue;
            seenStmts.add(site.stmt);
            out.push(site);
        }

        const declStmt = local.getDeclaringStmt();
        if (declStmt instanceof ArkAssignStmt) {
            const rightOp = declStmt.getRightOp();
            if (rightOp instanceof ArkInstanceInvokeExpr || rightOp instanceof ArkStaticInvokeExpr) {
                pushInvokeSiteByStmt(declStmt);
            }
        }

        this.localInvokeSiteCache.set(local, out);
        return out;
    }

    private collectDirectInvokeSitesForLocal(local: Local): InvokeSite[] {
        const localName = local.getName?.();
        if (!localName) return [];
        return this.getDirectInvokeSiteIndex().get(localName) || [];
    }

    private getDirectInvokeSiteIndex(): Map<string, InvokeSite[]> {
        if (this.directInvokeSitesByLocalName) {
            return this.directInvokeSitesByLocalName;
        }
        const index = new Map<string, InvokeSite[]>();
        const seenByLocalName = new Map<string, Set<any>>();
        const addSite = (localName: string, site: InvokeSite): void => {
            const normalized = String(localName || "").trim();
            if (!normalized) return;
            let seen = seenByLocalName.get(normalized);
            if (!seen) {
                seen = new Set<any>();
                seenByLocalName.set(normalized, seen);
            }
            if (seen.has(site.stmt)) return;
            seen.add(site.stmt);
            if (!index.has(normalized)) index.set(normalized, []);
            index.get(normalized)!.push(site);
        };
        const sites = this.invokeSiteByStmt.size > 0
            ? this.invokeSiteByStmt.values()
            : Array.from(this.stmtOwner.keys())
                .map(stmt => this.getOrCreateInvokeSite(stmt))
                .filter((site): site is InvokeSite => !!site);
        for (const site of sites) {
            if (!this.shouldEvaluateInvokeSiteForFact(site)) continue;
            if (site.baseValue instanceof Local) {
                addSite(site.baseValue.getName?.(), site);
            }
            for (const arg of site.args) {
                if (arg instanceof Local) {
                    addSite(arg.getName?.(), site);
                }
            }
        }
        this.directInvokeSitesByLocalName = index;
        return index;
    }

    private collectObjectPayloadInvokeSitesForLocal(local: Local): InvokeSite[] {
        const localName = local.getName?.();
        if (!localName) return [];
        const candidates = this.getObjectPayloadInvokeSiteIndex().get(localName) || [];
        const out: InvokeSite[] = [];
        const seen = new Set<any>();
        for (const site of candidates) {
            if (!site.args.some(arg => this.objectInitializerContainsLocal(arg, local))) continue;
            if (seen.has(site.stmt)) continue;
            seen.add(site.stmt);
            out.push(site);
        }
        return out;
    }

    private getObjectPayloadInvokeSiteIndex(): Map<string, InvokeSite[]> {
        if (this.objectPayloadInvokeSitesByLocalName) {
            return this.objectPayloadInvokeSitesByLocalName;
        }
        const index = new Map<string, InvokeSite[]>();
        const seenByLocalName = new Map<string, Set<any>>();
        const addSite = (localName: string, site: InvokeSite): void => {
            if (!localName) return;
            let seen = seenByLocalName.get(localName);
            if (!seen) {
                seen = new Set<any>();
                seenByLocalName.set(localName, seen);
            }
            if (seen.has(site.stmt)) return;
            seen.add(site.stmt);
            if (!index.has(localName)) index.set(localName, []);
            index.get(localName)!.push(site);
        };

        const sites = this.invokeSiteByStmt.size > 0
            ? this.invokeSiteByStmt.values()
            : Array.from(this.stmtOwner.keys())
                .map(stmt => this.getOrCreateInvokeSite(stmt))
                .filter((site): site is InvokeSite => !!site);
        for (const site of sites) {
            if (!this.shouldEvaluateInvokeSiteForFact(site)) continue;
            const localNames = new Set<string>();
            for (const arg of site.args) {
                for (const localName of this.collectObjectInitializerLocalNames(arg)) {
                    localNames.add(localName);
                }
            }
            for (const localName of localNames) {
                addSite(localName, site);
            }
        }
        this.objectPayloadInvokeSitesByLocalName = index;
        return index;
    }

    private shouldEvaluateInvokeSiteForFact(site: InvokeSite): boolean {
        if (this.perfMode === "baseline") return true;
        return this.resolveCandidateRulesForSite(site).length > 0;
    }

    private objectInitializerContainsLocal(value: any, local: Local): boolean {
        const sourceName = local.getName?.();
        if (!sourceName) return false;
        return this.collectObjectInitializerLocalNames(value).includes(sourceName);
    }

    private collectObjectInitializerLocalNames(value: any): string[] {
        if (!(value instanceof Local)) return [];
        const cached = this.initializerLocalNamesForValueCache.get(value);
        if (cached) return cached;

        const typeText = String(value.getType?.() || "");
        if (!typeText) {
            this.initializerLocalNamesForValueCache.set(value, []);
            return [];
        }
        const out = new Set<string>();
        for (const method of this.resolveInitializerMethodsForType(typeText)) {
            const cfg = method.getCfg?.();
            if (!cfg) continue;
            for (const stmt of cfg.getStmts()) {
                const right = stmt.getRightOp?.();
                if (right instanceof Local) {
                    const localName = right.getName?.();
                    if (localName) out.add(localName);
                }
            }
        }
        const localNames = [...out.values()];
        this.initializerLocalNamesForValueCache.set(value, localNames);
        return localNames;
    }

    private resolveInitializerMethodsForType(typeText: string): any[] {
        if (!this.scene) return [];
        const cached = this.initializerMethodsForTypeCache.get(typeText);
        if (cached) return cached;
        const methods = this.scene.getMethods().filter(method => {
            const name = method.getName?.();
            if (name !== "%instInit" && name !== "constructor") return false;
            const sig = method.getSignature?.()?.toString?.() || "";
            return sig.includes(typeText);
        });
        this.initializerMethodsForTypeCache.set(typeText, methods);
        return methods;
    }

    private prebuildInvokeSiteIndex(): void {
        for (const stmt of this.stmtOwner.keys()) {
            this.getOrCreateInvokeSite(stmt);
        }
    }

    private prebuildSiteRuleCandidateIndex(): void {
        for (const site of this.invokeSiteByStmt.values()) {
            this.resolveCandidateRulesForSite(site);
        }
    }

    private getOrCreateInvokeSite(stmt: any): InvokeSite | undefined {
        if (!stmt) return undefined;
        const cached = this.invokeSiteByStmt.get(stmt);
        if (cached) return cached;
        const built = this.buildInvokeSite(stmt);
        if (!built) return undefined;
        this.invokeSiteByStmt.set(stmt, built);
        return built;
    }

    private buildInvokeSite(stmt: any): InvokeSite | undefined {
        if (!stmt || !stmt.containsInvokeExpr || !stmt.containsInvokeExpr()) return undefined;
        const invokeExpr = stmt.getInvokeExpr();
        if (!(invokeExpr instanceof ArkInstanceInvokeExpr)
            && !(invokeExpr instanceof ArkStaticInvokeExpr)
            && !(invokeExpr instanceof ArkPtrInvokeExpr)) return undefined;

        const rawSignature = invokeExpr.getMethodSignature?.()?.toString?.() || "";
        const methodNameFromSig = invokeExpr.getMethodSignature?.()?.getMethodSubSignature?.()?.getMethodName?.() || "";
        let methodName = methodNameFromSig;
        if (!methodName && rawSignature) {
            const match = rawSignature.match(/\.([A-Za-z0-9_$]+)\(/);
            methodName = match ? match[1] : "";
        }
        const resolvedCalleeMeta = this.resolveStructuralCalleeMetadata(invokeExpr);
        const signature = this.selectPrimaryInvokeText(rawSignature, resolvedCalleeMeta.signatures);
        methodName = this.selectPrimaryInvokeText(methodName, resolvedCalleeMeta.methodNames);

        const args = invokeExpr.getArgs ? invokeExpr.getArgs() : [];
        const baseValue = (invokeExpr instanceof ArkInstanceInvokeExpr || invokeExpr instanceof ArkPtrInvokeExpr)
            ? (invokeExpr as any).getBase?.()
            : undefined;
        const resultValue = stmt instanceof ArkAssignStmt ? stmt.getLeftOp() : undefined;

        const owner = this.stmtOwner.get(stmt);
        const callerMethodName = owner?.getName?.() || "<unknown>";
        const callerSignature = owner?.getSignature?.()?.toString?.() || "";
        const callerFilePath = this.extractFilePathFromSignature(callerSignature);
        const callerClassText = owner?.getDeclaringArkClass?.()?.getName?.() || callerSignature;
        const rawCalleeClassText = invokeExpr.getMethodSignature?.().getDeclaringClassSignature?.()?.toString?.() || signature;
        const rawCalleeClassName = invokeExpr.getMethodSignature?.().getDeclaringClassSignature?.()?.getClassName?.() || "";
        const calleeClassText = this.selectPrimaryInvokeText(rawCalleeClassText, resolvedCalleeMeta.classTexts);
        const calleeClassName = this.selectPrimaryInvokeText(rawCalleeClassName, resolvedCalleeMeta.classNames);
        const calleeFilePath = this.selectPrimaryInvokeText(
            this.extractFilePathFromSignature(signature),
            resolvedCalleeMeta.filePaths
        );
        const importScopeCandidates = resolveSdkImportScopeCandidates(owner, invokeExpr);
        const receiverOwnerName = this.scene && (invokeExpr instanceof ArkInstanceInvokeExpr || invokeExpr instanceof ArkPtrInvokeExpr)
            ? resolveConcreteReceiverOwnerName(this.scene, invokeExpr)
            : undefined;

        return {
            stmt,
            invokeExpr,
            callerMethod: owner,
            signature,
            methodName,
            calleeSignature: signature,
            calleeMethodName: methodName,
            calleeFilePath,
            calleeClassText,
            calleeClassName,
            candidateSignatures: resolvedCalleeMeta.signatures,
            candidateMethodNames: resolvedCalleeMeta.methodNames,
            candidateClassTexts: resolvedCalleeMeta.classTexts,
            candidateClassNames: resolvedCalleeMeta.classNames,
            candidateFilePaths: resolvedCalleeMeta.filePaths,
            scopeClassTexts: this.uniqueTexts([
                ...(importScopeCandidates.classTexts || []),
                receiverOwnerName,
                baseValue?.toString?.(),
            ]),
            scopeModuleTexts: importScopeCandidates.moduleTexts,
            scopeFileTexts: importScopeCandidates.fileTexts,
            baseValue,
            resultValue,
            args,
            invokeKind: invokeExpr instanceof ArkStaticInvokeExpr ? "static" : "instance",
            callerMethodName,
            callerSignature,
            callerFilePath,
            callerClassText,
        };
    }

    private resolveStructuralCalleeMetadata(invokeExpr: any): {
        signatures: string[];
        methodNames: string[];
        classTexts: string[];
        classNames: string[];
        filePaths: string[];
    } {
        if (!this.isStructuralCalleeResolveEnabled()) {
            return {
                signatures: [],
                methodNames: [],
                classTexts: [],
                classNames: [],
                filePaths: [],
            };
        }
        if (!this.scene) {
            return {
                signatures: [],
                methodNames: [],
                classTexts: [],
                classNames: [],
                filePaths: [],
            };
        }

        const shouldResolve = invokeExpr instanceof ArkPtrInvokeExpr;
        if (!shouldResolve) {
            return {
                signatures: [],
                methodNames: [],
                classTexts: [],
                classNames: [],
                filePaths: [],
            };
        }

        try {
            const methodBySig = new Map<string, any>();
            const addMethod = (method: any): void => {
                if (!method) return;
                const sig = method.getSignature?.()?.toString?.();
                if (!sig || methodBySig.has(sig)) return;
                methodBySig.set(sig, method);
            };

            const directCandidates = resolveCalleeCandidates(this.scene, invokeExpr, {
                maxNameMatchCandidates: 4,
            });
            for (const item of directCandidates) {
                addMethod(item.method);
            }

            if (invokeExpr instanceof ArkPtrInvokeExpr) {
                const callableValue = invokeExpr.getFuncPtrLocal?.();
                const baseMethods = resolveMethodsFromCallable(this.scene, callableValue, {
                    maxCandidates: 4,
                    enableLocalBacktrace: true,
                });
                for (const method of baseMethods) {
                    addMethod(method);
                }

                if (callableValue instanceof Local) {
                    const aliasedValues = this.paramArgAliasMap.get(callableValue) || [];
                    for (const aliasedValue of aliasedValues) {
                        const aliasedMethods = resolveMethodsFromCallable(this.scene, aliasedValue, {
                            maxCandidates: 4,
                            enableLocalBacktrace: true,
                        });
                        for (const method of aliasedMethods) {
                            addMethod(method);
                        }
                    }
                }
            }

            const resolvedMethods = [...methodBySig.values()];
            const signatures = this.uniqueTexts(resolvedMethods
                .map(method => method.getSignature?.()?.toString?.() || ""));
            const methodNames = this.uniqueTexts([
                ...directCandidates.map(item => item.method?.getName?.() || ""),
                ...resolvedMethods.map(method => method.getName?.() || ""),
            ]);
            const classTexts = this.uniqueTexts(resolvedMethods
                .map(method => method.getDeclaringArkClass?.()?.getSignature?.()?.toString?.() || ""));
            const classNames = this.uniqueTexts(resolvedMethods
                .map(method => method.getDeclaringArkClass?.()?.getName?.() || ""));
            const filePaths = this.uniqueTexts(signatures.map(sig => this.extractFilePathFromSignature(sig)));
            return { signatures, methodNames, classTexts, classNames, filePaths };
        } catch {
            return {
                signatures: [],
                methodNames: [],
                classTexts: [],
                classNames: [],
                filePaths: [],
            };
        }
    }

    private uniqueTexts(items: string[]): string[] {
        const out: string[] = [];
        const seen = new Set<string>();
        for (const raw of items) {
            const text = String(raw || "").trim();
            if (!text || seen.has(text)) continue;
            seen.add(text);
            out.push(text);
        }
        return out;
    }

    private isUnknownInvokeSignature(signature: string): boolean {
        const text = String(signature || "");
        return !text || text.includes("%unk");
    }

    private selectPrimaryInvokeText(primary: string, candidates: string[]): string {
        const normalizedPrimary = String(primary || "").trim();
        if (normalizedPrimary && !this.isUnknownInvokeSignature(normalizedPrimary)) {
            return normalizedPrimary;
        }
        if (candidates.length > 0) return candidates[0];
        return normalizedPrimary;
    }

    private resolveCandidateRulesForSite(site: InvokeSite): RuntimeRule[] {
        if (this.perfMode === "baseline") {
            const allMatched = this.runtimeRules.filter(runtimeRule => this.matchesRuleStatic(runtimeRule, site));
            return this.applyRuleMatchPriority(allMatched);
        }

        const stmt = site.stmt;
        if (stmt && this.siteRuleCandidateIndex.has(stmt)) {
            return this.siteRuleCandidateIndex.get(stmt)!;
        }

        const roughCandidates = this.collectBucketCandidatesForSite(site);
        const staticMatched = roughCandidates.filter(runtimeRule => this.matchesRuleStatic(runtimeRule, site));
        const candidates = this.applyRuleMatchPriority(staticMatched);

        if (stmt) {
            this.siteRuleCandidateIndex.set(stmt, candidates);
        }
        return candidates;
    }

    private resolvePerfModeFromEnv(): "optimized" | "baseline" {
        const raw = String(process.env.UDE_ARTIFACT_TRANSFER_PERF_MODE || "").trim().toLowerCase();
        return raw === "baseline" ? "baseline" : "optimized";
    }

    private isSceneRuleCacheEnabled(): boolean {
        const raw = String(process.env.UDE_ARTIFACT_TRANSFER_SCENE_CACHE || "").trim().toLowerCase();
        return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "disable" && raw !== "disabled";
    }

    private isStructuralCalleeResolveEnabled(): boolean {
        const raw = String(process.env.UDE_ARTIFACT_TRANSFER_STRUCTURAL_CALLEE || "").trim().toLowerCase();
        return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "disable" && raw !== "disabled";
    }

    private elapsedMsSince(t0: bigint): number {
        const dtNs = process.hrtime.bigint() - t0;
        return Number(dtNs) / 1_000_000;
    }

    private collectBucketCandidatesForSite(site: InvokeSite): RuntimeRule[] {
        void site;
        const out: RuntimeRule[] = [];
        const seen = new Set<RuntimeRule>();
        this.appendRuntimeRules(out, seen, this.ruleBuckets.universal);
        return out;
    }

    private appendRuntimeRules(
        out: RuntimeRule[],
        seen: Set<RuntimeRule>,
        rules: RuntimeRule[] | undefined
    ): void {
        if (!rules || rules.length === 0) return;
        for (const runtimeRule of rules) {
            if (seen.has(runtimeRule)) continue;
            seen.add(runtimeRule);
            out.push(runtimeRule);
        }
    }

    private applyRuleMatchPriority(staticMatched: RuntimeRule[]): RuntimeRule[] {
        return staticMatched;
    }

    private matchesRuleStatic(runtimeRule: RuntimeRule, site: InvokeSite): boolean {
        const rule = runtimeRule.rule;
        if (!hasApiEffectIdentity(rule)) return false;
        return !!this.apiEffectRuntimeIndex?.hasRuleSiteAtStmt(rule, site.stmt, "transfer");
    }

    private resolveFromDescriptor(rule: TransferRule): EndpointDescriptor {
        const n = normalizeEndpoint(rule.from);
        return {
            endpoint: n.endpoint,
            path: n.path,
            pathFrom: n.pathFrom,
            slotKind: n.slotKind,
            taintScope: n.taintScope,
            semanticEndpointKind: n.semanticEndpointKind,
        };
    }

    private resolveToDescriptor(rule: TransferRule): EndpointDescriptor {
        const n = normalizeEndpoint(rule.to);
        return {
            endpoint: n.endpoint,
            path: n.path,
            pathFrom: n.pathFrom,
            slotKind: n.slotKind,
            taintScope: n.taintScope,
            semanticEndpointKind: n.semanticEndpointKind,
        };
    }

    private resolveTransferDescriptorsForSite(
        rule: TransferRule,
        site: InvokeSite,
    ): { from: EndpointDescriptor; to: EndpointDescriptor } | undefined {
        if (!hasApiEffectIdentity(rule)) {
            return {
                from: this.resolveFromDescriptor(rule),
                to: this.resolveToDescriptor(rule),
            };
        }
        const effectSite = this.apiEffectRuntimeIndex
            ?.getSitesForRule(rule, "transfer")
            .find(item => item.stmt === site.stmt && item.effect.acceptedForPropagation);
        if (!effectSite) return undefined;
        const fromBinding = effectSite.effect.endpointBindings.find(binding => binding.valueRef === "from" && binding.status === "exact");
        const toBinding = effectSite.effect.endpointBindings.find(binding => binding.valueRef === "to" && binding.status === "exact");
        if (!fromBinding || !toBinding) return undefined;
        const from = this.endpointDescriptorFromResolvedEndpointBinding(fromBinding);
        const to = this.endpointDescriptorFromResolvedEndpointBinding(toBinding);
        if (!from || !to) return undefined;
        return { from, to };
    }

    private endpointDescriptorFromResolvedEndpointBinding(binding: ResolvedEndpointBinding): EndpointDescriptor | undefined {
        const descriptor = this.endpointDescriptorFromAssetEndpoint(binding.endpoint);
        if (!descriptor) return undefined;
        if (binding.pathFrom) {
            const pathFrom = this.endpointDescriptorFromAssetEndpoint(binding.pathFrom);
            if (!pathFrom) return undefined;
            descriptor.pathFrom = pathFrom.endpoint;
        }
        if (binding.slotKind) descriptor.slotKind = binding.slotKind;
        if (binding.taintScope) descriptor.taintScope = binding.taintScope;
        return descriptor;
    }

    private endpointDescriptorFromAssetEndpoint(endpoint: AssetEndpoint): EndpointDescriptor | undefined {
        let ruleEndpoint: RuleEndpoint;
        switch (endpoint.base.kind) {
            case "receiver":
                ruleEndpoint = "base";
                break;
            case "return":
            case "promiseResult":
            case "promiseRejected":
            case "constructorResult":
            case "callbackReturn":
                ruleEndpoint = "result";
                break;
            case "arg":
                ruleEndpoint = `arg${endpoint.base.index}` as RuleEndpoint;
                break;
            case "callbackArg":
                ruleEndpoint = `arg${endpoint.base.argIndex}` as RuleEndpoint;
                break;
            default:
                return undefined;
        }
        const descriptor: EndpointDescriptor = {
            endpoint: ruleEndpoint,
            path: endpoint.accessPath,
            taintScope: endpoint.taintScope,
        };
        if (endpoint.base.kind === "return") descriptor.semanticEndpointKind = "return";
        if (endpoint.base.kind === "promiseResult") descriptor.semanticEndpointKind = "promiseResult";
        if (endpoint.base.kind === "promiseRejected") descriptor.semanticEndpointKind = "promiseRejected";
        if (endpoint.base.kind === "constructorResult") descriptor.semanticEndpointKind = "constructorResult";
        if (endpoint.base.kind === "callbackReturn") descriptor.semanticEndpointKind = "callbackReturn";
        return descriptor;
    }

    private endpointMatchesFact(
        descriptor: EndpointDescriptor,
        site: InvokeSite,
        fact: TaintFact,
        pag: Pag,
        tracker?: TaintTracker
    ): boolean {
        const semanticCarrierIds = this.resolveSemanticEndpointCarrierNodeIds(descriptor, site, pag);
        if (semanticCarrierIds !== undefined) {
            return this.carrierIdsMatchFactForDescriptor(semanticCarrierIds, descriptor, site, fact, pag, tracker);
        }

        const endpointValues = this.resolveEndpointValues(descriptor.endpoint, site);
        if (endpointValues.length === 0) return false;

        const resolvedPath = this.resolveDescriptorFieldPath(descriptor, site);
        if (descriptor.path && descriptor.path.length > 0) {
            for (const endpointValue of endpointValues) {
                const carrierIds = this.resolveCarrierNodeIdsFromValue(endpointValue, pag, site.stmt);
                for (const carrierId of carrierIds) {
                    if (carrierId === fact.node.getID() && this.samePath(fact.field, descriptor.path)) return true;
                    if (tracker?.isTaintedAnyContext(carrierId, descriptor.path)) return true;
                }
            }
            return false;
        }
        if (descriptor.pathFrom) {
            if (!resolvedPath) return false;
            for (const endpointValue of endpointValues) {
                const carrierIds = this.resolveCarrierNodeIdsFromValue(endpointValue, pag, site.stmt);
                for (const carrierId of carrierIds) {
                    if (carrierId === fact.node.getID() && this.samePath(fact.field, resolvedPath)) {
                        return this.isPathDerivedSlotCurrentForFact(descriptor, site, fact, carrierId, resolvedPath, pag, tracker);
                    }
                    if (tracker?.isTaintedAnyContext(carrierId, resolvedPath)
                        && tracker.getSourcesAnyContext(carrierId, resolvedPath).includes(fact.source)) {
                        return this.isPathDerivedSlotCurrentForFact(descriptor, site, fact, carrierId, resolvedPath, pag, tracker);
                    }
                }
            }
            return false;
        }
        if (descriptor.taintScope === "contained-values") {
            for (const endpointValue of endpointValues) {
                const carrierIds = this.resolveCarrierNodeIdsFromValue(endpointValue, pag, site.stmt);
                const factValue = fact.node.getValue();
                if (factValue instanceof Local && this.objectInitializerContainsLocal(endpointValue, factValue)) {
                    return true;
                }
                for (const carrierId of carrierIds) {
                    if (carrierId === fact.node.getID()) return true;
                    if (tracker?.hasAnyFieldTaintAnyContext(carrierId)
                        && tracker.getFieldSourcesAnyContext(carrierId).some(item => item.source === fact.source)) {
                        return true;
                    }
                    const node = pag.getNode(carrierId) as PagNode;
                    const pts = node.getPointTo();
                    if (pts && pts.contains && pts.contains(fact.node.getID())) return true;
                }
            }
            return false;
        }

        if (fact.field && fact.field.length > 0) {
            return false;
        }

        for (const endpointValue of endpointValues) {
            const nodes = this.resolveNodesByValue(endpointValue, pag, site.stmt);
            if (nodes && nodes.size > 0) {
                for (const nodeId of nodes.values()) {
                    if (nodeId === fact.node.getID()) {
                        return true;
                    }
                    const node = pag.getNode(nodeId) as PagNode;
                    const pts = node.getPointTo();
                    if (pts && pts.contains && pts.contains(fact.node.getID())) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private resolveTargetFacts(
        descriptor: EndpointDescriptor,
        site: InvokeSite,
        source: string,
        contextID: number,
        pag: Pag
    ): TaintFact[] {
        const out: TaintFact[] = [];
        const seen = new Set<string>();
        const addFact = (fact: TaintFact): void => {
            if (seen.has(fact.taintId)) return;
            seen.add(fact.taintId);
            out.push(fact);
        };

        const resolvedPath = this.resolveDescriptorFieldPath(descriptor, site);
        const semanticCarrierIds = this.resolveSemanticEndpointCarrierNodeIds(descriptor, site, pag);
        if (semanticCarrierIds !== undefined) {
            const fieldPath = descriptor.path && descriptor.path.length > 0
                ? descriptor.path
                : resolvedPath;
            for (const carrierId of semanticCarrierIds) {
                const carrierNode = pag.getNode(carrierId) as PagNode;
                addFact(new TaintFact(carrierNode, source, contextID, fieldPath ? [...fieldPath] : undefined));
            }
            return out;
        }

        const endpointValues = this.resolveEndpointValues(descriptor.endpoint, site);
        if (endpointValues.length === 0) return out;

        if (descriptor.path && descriptor.path.length > 0) {
            for (const endpointValue of endpointValues) {
                const carrierIds = this.resolveCarrierNodeIdsFromValue(endpointValue, pag, site.stmt, contextID);
                for (const carrierId of carrierIds) {
                    const carrierNode = pag.getNode(carrierId) as PagNode;
                    addFact(new TaintFact(carrierNode, source, contextID, [...descriptor.path]));
                }
            }
            return out;
        }
        if (descriptor.pathFrom) {
            if (!resolvedPath) return out;
            for (const endpointValue of endpointValues) {
                const carrierIds = this.resolveCarrierNodeIdsFromValue(endpointValue, pag, site.stmt, contextID);
                for (const carrierId of carrierIds) {
                    const carrierNode = pag.getNode(carrierId) as PagNode;
                    addFact(new TaintFact(carrierNode, source, contextID, [...resolvedPath]));
                }
            }
            return out;
        }

        for (const endpointValue of endpointValues) {
            const targetNodes = this.resolveOrCreateNodesByValue(endpointValue, pag, contextID, site.stmt);
            if (!targetNodes) continue;
            for (const nodeId of targetNodes.values()) {
                const node = pag.getNode(nodeId) as PagNode;
                addFact(new TaintFact(node, source, contextID));
            }
        }
        return out;
    }

    private resolveSemanticEndpointCarrierNodeIds(
        descriptor: EndpointDescriptor,
        site: InvokeSite,
        pag: Pag,
    ): number[] | undefined {
        if (descriptor.semanticEndpointKind !== "promiseResult" && descriptor.semanticEndpointKind !== "promiseRejected") return undefined;
        if (!this.scene || !site.invokeExpr) return [];
        return descriptor.semanticEndpointKind === "promiseRejected"
            ? resolvePromiseRejectionSourceNodeIdsFromInvoke(this.scene, pag, site.invokeExpr)
            : resolvePromiseFulfillmentSourceNodeIdsFromInvoke(this.scene, pag, site.invokeExpr);
    }

    private resolveEndpointValues(endpoint: RuleEndpoint, site: InvokeSite): any[] {
        if (endpoint === "base") return site.baseValue !== undefined ? [site.baseValue] : [];
        if (endpoint === "result") return site.resultValue !== undefined ? [site.resultValue] : [];
        const argIndex = this.parseArgIndex(endpoint);
        if (argIndex === null) return [];
        const value = site.args[argIndex];
        return value !== undefined ? [value] : [];
    }

    private resolveNodesByValue(value: any, pag: Pag, anchorStmt?: any): Map<number, number> | undefined {
        return pag.getNodesByValue(value) || resolveExistingPagNodes(pag, value, anchorStmt);
    }

    private resolveOrCreateNodesByValue(
        value: any,
        pag: Pag,
        contextID: number,
        anchorStmt?: any
    ): Map<number, number> | undefined {
        const existing = this.resolveNodesByValue(value, pag, anchorStmt);
        if (existing && existing.size > 0) return existing;

        const getOrNewNode = (pag as any).getOrNewNode;
        if (typeof getOrNewNode !== "function") return undefined;
        const node = getOrNewNode.call(pag, contextID, value, anchorStmt);
        const nodeId = node?.getID?.();
        if (!Number.isInteger(nodeId)) return undefined;
        return new Map([[nodeId, nodeId]]);
    }

    private resolveObjectIdsFromValue(value: any, pag: Pag, anchorStmt?: any): number[] {
        const out: number[] = [];
        const seen = new Set<number>();
        const nodes = this.resolveNodesByValue(value, pag, anchorStmt);
        if (!nodes || nodes.size === 0) return out;
        for (const nodeId of nodes.values()) {
            const node = pag.getNode(nodeId) as PagNode;
            const pts = node.getPointTo();
            if (!pts) continue;
            for (const objId of pts) {
                if (seen.has(objId)) continue;
                seen.add(objId);
                out.push(objId);
            }
        }
        return out;
    }

    private resolveCarrierNodeIdsFromValue(value: any, pag: Pag, anchorStmt?: any, materializeContextID?: number): number[] {
        const objectIds = this.resolveObjectIdsFromValue(value, pag, anchorStmt);
        if (objectIds.length > 0) return objectIds;
        const out: number[] = [];
        const seen = new Set<number>();
        const nodes = materializeContextID === undefined
            ? this.resolveNodesByValue(value, pag, anchorStmt)
            : this.resolveOrCreateNodesByValue(value, pag, materializeContextID, anchorStmt);
        if (!nodes || nodes.size === 0) return out;
        for (const nodeId of nodes.values()) {
            if (seen.has(nodeId)) continue;
            seen.add(nodeId);
            out.push(nodeId);
        }
        return out;
    }

    private resolveDescriptorFieldPath(descriptor: EndpointDescriptor, site: InvokeSite): string[] | undefined {
        if (!descriptor.pathFrom || !descriptor.slotKind) return undefined;
        const pathValues = this.resolveEndpointValues(descriptor.pathFrom, site);
        if (pathValues.length === 0) return undefined;
        const key = this.resolveRuntimePathKey(pathValues[0], descriptor.slotKind);
        if (key === undefined) return undefined;
        return [toContainerFieldKey(`${descriptor.slotKind}:${key}`)];
    }

    private isPathDerivedSlotCurrentForFact(
        readDescriptor: EndpointDescriptor,
        readSite: InvokeSite,
        fact: TaintFact,
        carrierId: number,
        fieldPath: string[],
        pag: Pag,
        tracker?: TaintTracker,
    ): boolean {
        if (!tracker || !readDescriptor.pathFrom || !readDescriptor.slotKind) return true;

        const latestWrite = this.findLatestPathDerivedSlotWriteBefore(
            readSite,
            carrierId,
            fieldPath,
            pag,
        );
        if (!latestWrite) return true;

        const latestDescriptors = this.resolveTransferDescriptorsForSite(latestWrite.rule.rule, latestWrite.site);
        if (!latestDescriptors) return true;
        const fromDescriptor = latestDescriptors.from;
        const sourceStatus = this.endpointHasSourceForSite(
            fromDescriptor,
            latestWrite.site,
            fact.source,
            pag,
            tracker,
            fact,
        );
        if (sourceStatus === "tainted") return true;
        if (sourceStatus === "clean") return false;
        return true;
    }

    private findLatestPathDerivedSlotWriteBefore(
        readSite: InvokeSite,
        carrierId: number,
        fieldPath: string[],
        pag: Pag,
    ): { site: InvokeSite; rule: RuntimeRule } | undefined {
        const method = this.stmtOwner.get(readSite.stmt);
        const cfg = method?.getCfg?.();
        const rawStmts = cfg?.getStmts?.();
        if (!rawStmts) return undefined;
        const stmts = Array.from(rawStmts as Iterable<any>);

        let latest: { site: InvokeSite; rule: RuntimeRule } | undefined;
        for (const stmt of stmts) {
            if (stmt === readSite.stmt) break;
            const site = this.getOrCreateInvokeSite(stmt);
            if (!site) continue;
            for (const runtimeRule of this.resolveCandidateRulesForSite(site)) {
                const descriptors = this.resolveTransferDescriptorsForSite(runtimeRule.rule, site);
                if (!descriptors) continue;
                const toDescriptor = descriptors.to;
                if (!toDescriptor.pathFrom || !toDescriptor.slotKind) continue;
                const toPath = this.resolveDescriptorFieldPath(toDescriptor, site);
                if (!this.samePath(toPath, fieldPath)) continue;
                if (!this.siteTargetsCarrier(toDescriptor, site, carrierId, pag)) continue;
                latest = { site, rule: runtimeRule };
            }
        }
        return latest;
    }

    private siteTargetsCarrier(
        descriptor: EndpointDescriptor,
        site: InvokeSite,
        carrierId: number,
        pag: Pag,
    ): boolean {
        const semanticCarrierIds = this.resolveSemanticEndpointCarrierNodeIds(descriptor, site, pag);
        if (semanticCarrierIds !== undefined) {
            return semanticCarrierIds.includes(carrierId);
        }
        for (const endpointValue of this.resolveEndpointValues(descriptor.endpoint, site)) {
            const carrierIds = this.resolveCarrierNodeIdsFromValue(endpointValue, pag);
            if (carrierIds.includes(carrierId)) return true;
        }
        return false;
    }

    private carrierIdsMatchFactForDescriptor(
        carrierIds: number[],
        descriptor: EndpointDescriptor,
        site: InvokeSite,
        fact: TaintFact,
        pag: Pag,
        tracker?: TaintTracker,
    ): boolean {
        if (carrierIds.length === 0) return false;
        const resolvedPath = this.resolveDescriptorFieldPath(descriptor, site);
        const fieldPath = descriptor.path && descriptor.path.length > 0
            ? descriptor.path
            : resolvedPath;
        for (const carrierId of carrierIds) {
            if (fieldPath && fieldPath.length > 0) {
                if (carrierId === fact.node.getID() && this.samePath(fact.field, fieldPath)) return true;
                if (tracker?.isTaintedAnyContext(carrierId, fieldPath)) return true;
                continue;
            }
            if (carrierId === fact.node.getID()) return true;
            if (tracker?.isTaintedAnyContext(carrierId)) return true;
            const node = pag.getNode(carrierId) as PagNode;
            const pts = node?.getPointTo?.();
            if (pts && pts.contains && pts.contains(fact.node.getID())) return true;
        }
        return false;
    }

    private endpointHasSourceForSite(
        descriptor: EndpointDescriptor,
        site: InvokeSite,
        source: string,
        pag: Pag,
        tracker: TaintTracker,
        fact?: TaintFact,
    ): "tainted" | "clean" | "unknown" {
        const semanticCarrierIds = this.resolveSemanticEndpointCarrierNodeIds(descriptor, site, pag);
        if (semanticCarrierIds !== undefined) {
            if (semanticCarrierIds.length === 0) return "unknown";
            const resolvedPath = this.resolveDescriptorFieldPath(descriptor, site);
            const fieldPath = descriptor.path && descriptor.path.length > 0
                ? descriptor.path
                : resolvedPath;
            for (const carrierId of semanticCarrierIds) {
                const sources = fieldPath && fieldPath.length > 0
                    ? tracker.getSourcesAnyContext(carrierId, fieldPath)
                    : tracker.getSourcesAnyContext(carrierId);
                if (sources.includes(source)) return "tainted";
            }
            return "clean";
        }
        const endpointValues = this.resolveEndpointValues(descriptor.endpoint, site);
        if (endpointValues.length === 0) return "unknown";

        const resolvedPath = this.resolveDescriptorFieldPath(descriptor, site);
        const fieldPath = descriptor.path && descriptor.path.length > 0
            ? descriptor.path
            : resolvedPath;

        let sawResolvedCarrier = false;
        let sawContainedPayloadEndpoint = false;
        for (const endpointValue of endpointValues) {
            if (endpointValue instanceof Constant) {
                sawResolvedCarrier = true;
                continue;
            }
            if (descriptor.taintScope === "contained-values") {
                sawContainedPayloadEndpoint = true;
                const factValue = fact?.node.getValue();
                if (factValue instanceof Local && this.objectInitializerContainsLocal(endpointValue, factValue)) {
                    return "tainted";
                }
            }
            const carrierIds = this.resolveCarrierNodeIdsFromValue(endpointValue, pag);
            if (carrierIds.length === 0) return "unknown";
            sawResolvedCarrier = true;
            for (const carrierId of carrierIds) {
                if (descriptor.taintScope === "contained-values") {
                    if (tracker.getFieldSourcesAnyContext(carrierId).some(item => item.source === source)) {
                        return "tainted";
                    }
                    continue;
                }
                const sources = fieldPath && fieldPath.length > 0
                    ? tracker.getSourcesAnyContext(carrierId, fieldPath)
                    : tracker.getSourcesAnyContext(carrierId);
                if (sources.includes(source)) return "tainted";
            }
        }

        return sawContainedPayloadEndpoint ? "unknown" : (sawResolvedCarrier ? "clean" : "unknown");
    }

    private resolveRuntimePathKey(value: any, slotKind?: string): string | undefined {
        if (value instanceof Constant) {
            const literal = this.normalizeLiteral(value.toString());
            if (slotKind === "sql-table") {
                return this.extractSqlTableName(literal) || literal;
            }
            return literal;
        }

        if (value instanceof Local) {
            const decl = value.getDeclaringStmt?.();
            if (decl instanceof ArkAssignStmt) {
                const right = decl.getRightOp?.();
                if (right instanceof Constant) {
                    const literal = this.normalizeLiteral(right.toString());
                    if (slotKind === "sql-table") {
                        return this.extractSqlTableName(literal) || literal;
                    }
                    return literal;
                }
                if (right instanceof ArkNormalBinopExpr) {
                    const n1 = this.resolveNumber(right.getOp1());
                    const n2 = this.resolveNumber(right.getOp2());
                    if (n1 !== undefined && n2 !== undefined) {
                        const op = right.getOperator();
                        if (op === "+") return String(n1 + n2);
                        if (op === "-") return String(n1 - n2);
                        if (op === "*") return String(n1 * n2);
                        if (op === "/" && n2 !== 0) return String(n1 / n2);
                    }
                }
            }
            return value.getName?.();
        }

        return undefined;
    }

    private extractSqlTableName(sql: string): string | undefined {
        const normalized = sql.replace(/\s+/g, " ").trim();
        const match = /\bfrom\s+([A-Za-z_][A-Za-z0-9_.$]*)\b/i.exec(normalized);
        if (!match) return undefined;
        return match[1].replace(/^["'`]/, "").replace(/["'`]$/, "");
    }

    private resolveNumber(value: any): number | undefined {
        const key = this.resolveRuntimePathKey(value);
        if (key === undefined) return undefined;
        const n = Number(key);
        return Number.isNaN(n) ? undefined : n;
    }

    private normalizeLiteral(text: string): string {
        return text.replace(/^['"`]/, "").replace(/['"`]$/, "");
    }

    private samePath(a?: string[], b?: string[]): boolean {
        if (!a || !b) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    private extractFilePathFromSignature(signature: string): string {
        const m = signature.match(/@([^:>]+):/);
        return m ? m[1].replace(/\\/g, "/") : signature;
    }

    private parseArgIndex(endpoint: RuleEndpoint): number | null {
        const match = /^arg(\d+)$/.exec(endpoint);
        if (!match) return null;
        const index = Number(match[1]);
        if (!Number.isFinite(index) || index < 0) return null;
        return index;
    }

    private createEmptyStats(): TransferExecutionStats {
        return {
            factCount: 0,
            invokeSiteCount: 0,
            ruleCheckCount: 0,
            ruleMatchCount: 0,
            endpointCheckCount: 0,
            endpointMatchCount: 0,
            dedupSkipCount: 0,
            resultCount: 0,
            elapsedMs: 0,
            noCandidateCallsites: [],
        };
    }

    private buildRuleExecutionDedupKey(factId: string, site: InvokeSite, ruleId: string): string {
        const siteKey = this.getSiteRuntimeKey(site);
        return `${factId}|${siteKey}|${ruleId}`;
    }

    private getSiteRuntimeKey(site: InvokeSite): string {
        const stmt = site.stmt;
        if (stmt && typeof stmt === "object") {
            const obj = stmt as object;
            let id = this.stmtRuntimeKeyId.get(obj);
            if (!id) {
                id = this.stmtRuntimeKeySeq++;
                this.stmtRuntimeKeyId.set(obj, id);
            }
            return `stmt#${id}`;
        }
        return `${site.callerSignature}|${site.signature}|${site.methodName}`;
    }

    private buildMethodEntityIndex(scene: Scene): MethodEntityIndex {
        const signatures = new Set<string>();
        for (const method of scene.getMethods()) {
            const signature = method.getSignature?.()?.toString?.();
            if (signature) signatures.add(signature);
        }
        return {
            signatures,
        };
    }

    private resolveExactSignatureMatch(value: string, index?: MethodEntityIndex): string | undefined {
        const candidate = value.trim();
        if (!candidate) return undefined;
        if (index && index.signatures.has(candidate)) return candidate;
        return candidate;
    }

    private normalizeForExactMatch(value: string): string {
        return value.trim();
    }

    private buildRuleBucketIndex(rules: RuntimeRule[]): RuntimeRuleBucketIndex {
        const buckets: RuntimeRuleBucketIndex = {
            universal: [],
        };

        for (const runtimeRule of rules) {
            buckets.universal.push(runtimeRule);
        }

        return buckets;
    }

    private exactTextMatch(
        text: string,
        exactValue: string | undefined,
        normalizedExactValue: string | undefined
    ): boolean {
        if (exactValue && text === exactValue) return true;
        if (!normalizedExactValue) return false;
        return this.normalizeForExactMatch(text) === normalizedExactValue;
    }

    private regexTest(regex: RegExp, text: string): boolean {
        regex.lastIndex = 0;
        return regex.test(text);
    }
}

