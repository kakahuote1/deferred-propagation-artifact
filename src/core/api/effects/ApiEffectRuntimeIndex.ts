import { Scene } from "../../../../arkanalyzer/out/src/Scene";
import { ArkAssignStmt } from "../../../../arkanalyzer/out/src/core/base/Stmt";
import { ArkInstanceFieldRef } from "../../../../arkanalyzer/out/src/core/base/Ref";
import { ArkInstanceInvokeExpr, ArkNewArrayExpr, ArkNewExpr, ArkPtrInvokeExpr, ArkStaticInvokeExpr } from "../../../../arkanalyzer/out/src/core/base/Expr";
import { BooleanConstant, NullConstant, NumberConstant, StringConstant, UndefinedConstant } from "../../../../arkanalyzer/out/src/core/base/Constant";
import { Local } from "../../../../arkanalyzer/out/src/core/base/Local";
import { ArrayType, ClassType, FunctionType } from "../../../../arkanalyzer/out/src/core/base/Type";
import { ArkMethod } from "../../../../arkanalyzer/out/src/core/model/ArkMethod";
import { ClassCategory } from "../../../../arkanalyzer/out/src/core/model/ArkClass";
import type { CanonicalApiDescriptor, CanonicalApiRegistry } from "../identity";
import type { ImportMemberKey } from "../identity/ImportMemberKey";
import { ApiOccurrenceResolver } from "../occurrence";
import type { RawApiOccurrence, ResolvedApiOccurrence } from "../occurrence";
import {
    buildOfficialOccurrenceRecords,
    emptyOfficialOccurrenceCoverageSnapshot,
    summarizeOfficialOccurrenceCoverage,
    type OfficialOccurrenceCoverageSnapshot,
    type OfficialOccurrenceRecord,
} from "../occurrence";
import { projectBindingToEffect } from "./BindingProjector";
import type {
    AssetBinding,
    AssetDocumentBase,
    AssetEndpoint,
    AssetIdentityIndex,
    SemanticEffectTemplate,
} from "../../assets/schema";
import {
    isTrustedAnalysisAssetStatus,
} from "../../assets/schema";
import type {
    ApiEffectIdentity,
    ApiEffectInstance,
    ApiEffectRole,
    ApiIdentityBackedRule,
} from "../ApiOccurrenceIdentity";
import { hasApiEffectIdentity } from "../ApiOccurrenceIdentity";

export interface ApiEffectSite {
    readonly effect: ApiEffectInstance;
    readonly rawOccurrence: RawApiOccurrence;
    readonly resolvedOccurrence: ResolvedApiOccurrence;
    readonly method: ArkMethod;
    readonly stmt: any;
    readonly invokeExpr?: any;
    readonly fieldRef?: ArkInstanceFieldRef;
    readonly calleeSignature: string;
    readonly memberName: string;
    readonly argCount: number;
}

export interface ApiCanonicalOccurrenceSite {
    readonly rawOccurrence: RawApiOccurrence;
    readonly resolvedOccurrence: ResolvedApiOccurrence;
    readonly method: ArkMethod;
    readonly stmt: any;
}

export interface ApiEffectRuntimeIndexStats {
    rawOccurrenceCount: number;
    acceptedOccurrenceCount: number;
    effectSiteCount: number;
    rejectedOccurrenceCount: number;
    unresolvedOccurrenceCount: number;
    ambiguousOccurrenceCount: number;
}

export interface ApiEffectRuntimeIndexInput {
    scene: Scene;
    assets: AssetDocumentBase[];
    assetIdentityIndex: AssetIdentityIndex;
    canonicalApiRegistry: CanonicalApiRegistry;
}

interface ArkUiChainState {
    componentName: string;
}

interface ArkUiEventDescriptor {
    componentName: string;
    attributeOwner: string;
    eventName: string;
    callbackArgCount: number;
}

interface ImportBaseResolution {
    importInfo: any;
    localName: string;
    memberChainPrefix: string[];
    shadowed: boolean;
    constructed?: boolean;
}

export class ApiEffectRuntimeIndex {
    private readonly rawOccurrences: RawApiOccurrence[] = [];
    private readonly resolvedOccurrences: ResolvedApiOccurrence[] = [];
    private officialOccurrenceRecords: OfficialOccurrenceRecord[] = [];
    private readonly canonicalOccurrenceSites: ApiCanonicalOccurrenceSite[] = [];
    private readonly canonicalOccurrenceSitesByStmt = new WeakMap<object, ApiCanonicalOccurrenceSite[]>();
    private readonly effectSites: ApiEffectSite[] = [];
    private readonly sitesByRuleKey = new Map<string, ApiEffectSite[]>();
    private readonly sitesByStmt = new WeakMap<object, ApiEffectSite[]>();
    private readonly effectsByIdentityKey = new Map<string, ApiEffectInstance[]>();
    private readonly arkUiEventsBySiteKey = new Map<string, ArkUiEventDescriptor[]>();
    private readonly arkUiComponents = new Set<string>();
    private readonly officialDecorators = new Set<string>();
    private readonly resolver: ApiOccurrenceResolver;

    private constructor(private readonly input: ApiEffectRuntimeIndexInput) {
        const descriptors = input.canonicalApiRegistry.listDescriptors();
        this.resolver = new ApiOccurrenceResolver(input.canonicalApiRegistry);
        this.buildArkUiDescriptorIndex(descriptors);
        this.scanScene(input.scene);
        this.officialOccurrenceRecords = buildOfficialOccurrenceRecords({
            rawOccurrences: this.rawOccurrences,
            resolvedOccurrences: this.resolvedOccurrences,
            canonicalApiRegistry: input.canonicalApiRegistry,
        });
    }

    static build(input: ApiEffectRuntimeIndexInput): ApiEffectRuntimeIndex {
        return new ApiEffectRuntimeIndex(input);
    }

    listRawOccurrences(): RawApiOccurrence[] {
        return [...this.rawOccurrences];
    }

    listResolvedOccurrences(): ResolvedApiOccurrence[] {
        return [...this.resolvedOccurrences];
    }

    listOfficialOccurrenceRecords(): OfficialOccurrenceRecord[] {
        return [...this.officialOccurrenceRecords];
    }

    getOfficialOccurrenceCoverage(): OfficialOccurrenceCoverageSnapshot {
        if (this.officialOccurrenceRecords.length === 0) {
            return emptyOfficialOccurrenceCoverageSnapshot();
        }
        return summarizeOfficialOccurrenceCoverage(this.officialOccurrenceRecords);
    }

    listEffectSites(): ApiEffectSite[] {
        return [...this.effectSites];
    }

    listCanonicalOccurrenceSites(): ApiCanonicalOccurrenceSite[] {
        return [...this.canonicalOccurrenceSites];
    }

    getCanonicalOccurrenceSitesForStmt(stmt: any): ApiCanonicalOccurrenceSite[] {
        if (!stmt || typeof stmt !== "object") return [];
        return [...(this.canonicalOccurrenceSitesByStmt.get(stmt) || [])];
    }

    getStats(): ApiEffectRuntimeIndexStats {
        return {
            rawOccurrenceCount: this.rawOccurrences.length,
            acceptedOccurrenceCount: this.resolvedOccurrences.filter(item => item.status === "accepted").length,
            effectSiteCount: this.effectSites.length,
            rejectedOccurrenceCount: this.resolvedOccurrences.filter(item => item.status === "rejected").length,
            unresolvedOccurrenceCount: this.resolvedOccurrences.filter(item => item.status === "unresolved").length,
            ambiguousOccurrenceCount: this.resolvedOccurrences.filter(item => item.status === "ambiguous").length,
        };
    }

    getSitesForRule(rule: ApiIdentityBackedRule | undefined, role?: ApiEffectRole): ApiEffectSite[] {
        if (!hasApiEffectIdentity(rule)) return [];
        if (role && rule.apiEffect.role !== role) return [];
        return [...(this.sitesByRuleKey.get(ruleKey(rule.apiEffect)) || [])];
    }

    hasRuleSiteAtStmt(rule: ApiIdentityBackedRule | undefined, stmt: any, role?: ApiEffectRole): boolean {
        if (!stmt || !hasApiEffectIdentity(rule)) return false;
        if (role && rule.apiEffect.role !== role) return false;
        const expectedKey = ruleKey(rule.apiEffect);
        return (this.sitesByStmt.get(stmt) || []).some(site => ruleKey(site.effect.identity) === expectedKey);
    }

    getEffectInstancesForIdentity(identity: ApiEffectIdentity): ApiEffectInstance[] {
        return [...(this.effectsByIdentityKey.get(ruleKey(identity)) || [])];
    }

    private buildArkUiDescriptorIndex(descriptors: CanonicalApiDescriptor[]): void {
        for (const descriptor of descriptors) {
            const event = this.arkUiEventFromDescriptor(descriptor);
            if (event) {
                this.addArkUiEvent(event);
                continue;
            }
            const componentName = descriptor.exportPath.find(item => item.kind === "component")?.name;
            if (componentName) {
                this.arkUiComponents.add(componentName);
            }
            if (descriptor.member.kind === "decorator" && descriptor.member.name) {
                this.officialDecorators.add(descriptor.member.name);
            }
        }
    }

    private arkUiEventFromDescriptor(descriptor: CanonicalApiDescriptor): ArkUiEventDescriptor | undefined {
        const componentName = descriptor.exportPath.find(item => item.kind === "component")?.name
            || componentNameFromAttributeOwner(descriptor.declarationOwner.normalizedName);
        if (!componentName) return undefined;
        if (descriptor.member.kind === "component-event") {
            return {
                componentName,
                attributeOwner: descriptor.declarationOwner.normalizedName,
                eventName: descriptor.member.name,
                callbackArgCount: descriptor.signature.parameters.length,
            };
        }
        if (descriptor.invoke.kind !== "call") return undefined;
        if (descriptor.member.kind !== "method" && descriptor.member.kind !== "function") return undefined;
        if (!this.hasCallbackSourceBinding(descriptor.canonicalApiId)) return undefined;
        return {
            componentName,
            attributeOwner: descriptor.declarationOwner.normalizedName,
            eventName: descriptor.member.name,
            callbackArgCount: descriptor.signature.parameters.length,
        };
    }

    private hasCallbackSourceBinding(canonicalApiId: string): boolean {
        const bindings = this.input.assetIdentityIndex.findBindings(canonicalApiId, { roles: ["source"] });
        return bindings.some(binding => {
            if (endpointIsCallback(binding.endpoint)) return true;
            for (const template of this.resolveTemplates(binding)) {
                if (endpointIsCallback(endpointFromTemplate(template))) return true;
            }
            return false;
        });
    }

    private addArkUiEvent(event: ArkUiEventDescriptor): void {
        this.arkUiComponents.add(event.componentName);
        const key = arkUiEventSiteKey(event.componentName, event.eventName, event.callbackArgCount);
        const list = this.arkUiEventsBySiteKey.get(key) || [];
        if (!list.some(item => arkUiEventDescriptorKey(item) === arkUiEventDescriptorKey(event))) {
            list.push(event);
        }
        this.arkUiEventsBySiteKey.set(key, list);
    }

    private scanScene(scene: Scene): void {
        let sequence = 0;
        for (const method of scene.getMethods()) {
            const cfg = method.getCfg?.();
            if (!cfg) continue;
            const arkUiChainByLocal = new Map<string, ArkUiChainState>();
            for (const stmt of cfg.getStmts?.() || []) {
                const invokeExpr = stmt.containsInvokeExpr?.() ? stmt.getInvokeExpr?.() : undefined;
                if (!invokeExpr) {
                    sequence = this.scanNonInvokeStmt(method, stmt, sequence);
                    continue;
                }
                const raw = this.rawOccurrenceFromInvoke(method, stmt, invokeExpr, sequence++, arkUiChainByLocal);
                this.acceptRawOccurrence(method, stmt, invokeExpr, undefined, raw);
                this.updateArkUiChainState(stmt, invokeExpr, arkUiChainByLocal);
            }
        }
        sequence = this.scanModelDecorators(scene, sequence);
        void sequence;
    }

    private scanNonInvokeStmt(method: ArkMethod, stmt: any, sequence: number): number {
        let next = sequence;
        if (!(stmt instanceof ArkAssignStmt)) return next;
        const left = stmt.getLeftOp?.();
        const right = stmt.getRightOp?.();
        if (left instanceof ArkInstanceFieldRef) {
            const raw = this.rawOccurrenceFromField(method, stmt, left, next++, "write");
            this.acceptRawOccurrence(method, stmt, undefined, left, raw);
        }
        if (right instanceof ArkInstanceFieldRef) {
            const raw = this.rawOccurrenceFromField(method, stmt, right, next++, "read");
            this.acceptRawOccurrence(method, stmt, undefined, right, raw);
        }
        if (right instanceof ArkNewExpr) {
            const raw = this.rawOccurrenceFromNewExpr(method, stmt, right, next++);
            this.acceptRawOccurrence(method, stmt, undefined, undefined, raw);
        }
        return next;
    }

    private acceptRawOccurrence(
        method: ArkMethod,
        stmt: any,
        invokeExpr: any | undefined,
        fieldRef: ArkInstanceFieldRef | undefined,
        raw: RawApiOccurrence,
    ): void {
        const resolved = this.recordRawOccurrence(raw);
        if (resolved.status !== "accepted" || !resolved.canonicalApiId) return;
        const canonicalSite: ApiCanonicalOccurrenceSite = {
            rawOccurrence: raw,
            resolvedOccurrence: resolved,
            method,
            stmt,
        };
        this.canonicalOccurrenceSites.push(canonicalSite);
        if (stmt && typeof stmt === "object") {
            const stmtSites = this.canonicalOccurrenceSitesByStmt.get(stmt) || [];
            stmtSites.push(canonicalSite);
            this.canonicalOccurrenceSitesByStmt.set(stmt, stmtSites);
        }
        const bindings = this.input.assetIdentityIndex.findBindings(resolved.canonicalApiId);
        for (const binding of bindings) {
            for (const template of this.resolveTemplates(binding)) {
                const effect = projectBindingToEffect({
                    occurrence: resolved,
                    binding,
                    template,
                    endpoint: binding.endpoint || endpointFromTemplate(template),
                });
                if (!effect.acceptedForPropagation) continue;
                const site = this.buildEffectSite(effect, raw, resolved, method, stmt, invokeExpr, fieldRef);
                this.addEffectSite(site);
            }
        }
    }

    private recordRawOccurrence(raw: RawApiOccurrence): ResolvedApiOccurrence {
        this.rawOccurrences.push(raw);
        const resolved = this.resolver.resolve(raw);
        this.resolvedOccurrences.push(resolved);
        return resolved;
    }

    private resolveTemplates(binding: AssetBinding): SemanticEffectTemplate[] {
        const refs = binding.effectTemplateRefs || [];
        const out: SemanticEffectTemplate[] = [];
        for (const ref of refs) {
            const template = this.input.assetIdentityIndex.getTemplate(ref);
            if (template) out.push(template);
        }
        return out;
    }

    private buildEffectSite(
        effect: ApiEffectInstance,
        rawOccurrence: RawApiOccurrence,
        resolvedOccurrence: ResolvedApiOccurrence,
        method: ArkMethod,
        stmt: any,
        invokeExpr: any | undefined,
        fieldRef: ArkInstanceFieldRef | undefined,
    ): ApiEffectSite {
        return {
            effect,
            rawOccurrence,
            resolvedOccurrence,
            method,
            stmt,
            invokeExpr,
            fieldRef,
            calleeSignature: rawOccurrence.ir.methodSignatureText || "",
            memberName: rawOccurrence.ir.memberName || "",
            argCount: rawOccurrence.ir.argCount || 0,
        };
    }

    private addEffectSite(site: ApiEffectSite): void {
        this.effectSites.push(site);
        const key = ruleKey(site.effect.identity);
        const byKey = this.sitesByRuleKey.get(key) || [];
        byKey.push(site);
        this.sitesByRuleKey.set(key, byKey);
        const effectList = this.effectsByIdentityKey.get(key) || [];
        effectList.push(site.effect);
        this.effectsByIdentityKey.set(key, effectList);
        if (site.stmt && typeof site.stmt === "object") {
            const stmtSites = this.sitesByStmt.get(site.stmt) || [];
            stmtSites.push(site);
            this.sitesByStmt.set(site.stmt, stmtSites);
        }
    }

    private rawOccurrenceFromInvoke(
        method: ArkMethod,
        stmt: any,
        invokeExpr: any,
        sequence: number,
        arkUiChainByLocal: Map<string, ArkUiChainState>,
    ): RawApiOccurrence {
        const calleeSignature = invokeExpr.getMethodSignature?.()?.toString?.() || "";
        const args = invokeExpr.getArgs?.() || [];
        const methodName = invokeMethodName(invokeExpr, calleeSignature);
        const sourceLocation = sourceLocationFor(method, stmt);
        const unknownSignature = isUnknownSignature(calleeSignature);
        const officialEvidence = this.arkUiComponents.has(methodName)
            ? [{ kind: "arkui-component" as const, componentName: methodName }]
            : undefined;
        return {
            rawOccurrenceId: rawOccurrenceId(method, stmt, sequence, "invoke"),
            kind: "invoke",
            sourceLocation,
            enclosingMethodSignature: method.getSignature?.()?.toString?.() || "",
            statementText: stmt.toString?.() || "",
            ir: {
                invokeExprKind: invokeExprKind(invokeExpr),
                methodSignatureText: calleeSignature,
                arkanalyzerMethodKey: arkanalyzerMethodKeyFromInvoke(invokeExpr),
                unknownSignature,
                receiverText: receiverText(invokeExpr),
                memberName: methodName,
                argCount: args.length,
                argTypes: args.map((arg: any) => typeTextOf(arg)),
                resultText: stmt instanceof ArkAssignStmt ? stmt.getLeftOp?.()?.toString?.() : undefined,
            },
            importEvidence: importEvidenceForInvoke(method, stmt, invokeExpr, methodName, args),
            projectEvidence: projectEvidenceForInvoke(invokeExpr),
            arkuiEvidence: this.arkUiEvidenceForInvoke(method, invokeExpr, methodName, args.length, arkUiChainByLocal),
            officialEvidence,
        };
    }

    private rawOccurrenceFromField(
        method: ArkMethod,
        stmt: any,
        fieldRef: ArkInstanceFieldRef,
        sequence: number,
        accessKind: "read" | "write",
    ): RawApiOccurrence {
        const fieldSignature = fieldRef.getFieldSignature?.()?.toString?.() || "";
        const fieldName = fieldRef.getFieldSignature?.()?.getFieldName?.()
            || extractMemberNameFromText(fieldSignature)
            || "";
        return {
            rawOccurrenceId: rawOccurrenceId(method, stmt, sequence, "field"),
            kind: "property-access",
            sourceLocation: sourceLocationFor(method, stmt),
            enclosingMethodSignature: method.getSignature?.()?.toString?.() || "",
            statementText: stmt.toString?.() || "",
            ir: {
                methodSignatureText: fieldSignature,
                unknownSignature: isUnknownSignature(fieldSignature),
                receiverText: fieldRef.getBase?.()?.toString?.() || "",
                memberName: fieldName,
                argCount: 0,
                argTypes: [],
                resultText: accessKind === "read" && stmt instanceof ArkAssignStmt
                    ? stmt.getLeftOp?.()?.toString?.()
                    : undefined,
                propertyAccessKind: accessKind,
            },
            importEvidence: importEvidenceForField(method, stmt, fieldRef, accessKind),
        };
    }

    private rawOccurrenceFromNewExpr(
        method: ArkMethod,
        stmt: any,
        newExpr: ArkNewExpr,
        sequence: number,
    ): RawApiOccurrence {
        const sourceFile = method.getDeclaringArkClass?.()?.getDeclaringArkFile?.()
            || method.getDeclaringArkFile?.();
        const classText = newExpr.getClassType?.()?.toString?.() || newExpr.toString?.() || "";
        return {
            rawOccurrenceId: rawOccurrenceId(method, stmt, sequence, "construct"),
            kind: "construct",
            sourceLocation: sourceLocationFor(method, stmt),
            enclosingMethodSignature: method.getSignature?.()?.toString?.() || "",
            statementText: stmt.toString?.() || "",
            ir: {
                methodSignatureText: classText,
                unknownSignature: isUnknownSignature(classText),
                receiverText: classText,
                memberName: "constructor",
                argCount: 0,
                argTypes: [],
                resultText: stmt instanceof ArkAssignStmt ? stmt.getLeftOp?.()?.toString?.() : undefined,
            },
            importEvidence: importEvidenceForNewExpr(method, stmt, sourceFile, newExpr),
        };
    }

    private scanModelDecorators(scene: Scene, sequence: number): number {
        let next = sequence;
        for (const namespace of scene.getNamespaces?.() || []) {
            next = this.scanDecoratorsOnModel("namespace", namespace, next);
        }
        for (const klass of scene.getClasses?.() || []) {
            next = this.scanDecoratorsOnModel("class", klass, next);
            for (const field of klass.getFields?.() || []) {
                next = this.scanDecoratorsOnModel("field", field, next);
            }
            for (const method of klass.getMethods?.() || []) {
                next = this.scanDecoratorsOnModel("method", method, next);
            }
        }
        return next;
    }

    private scanDecoratorsOnModel(
        ownerKind: "namespace" | "class" | "method" | "field",
        model: any,
        sequence: number,
    ): number {
        let next = sequence;
        for (const decorator of model.getDecorators?.() || []) {
            const raw = this.rawOccurrenceFromDecorator(ownerKind, model, decorator, next++);
            if (!raw) continue;
            this.recordRawOccurrence(raw);
        }
        return next;
    }

    private rawOccurrenceFromDecorator(
        ownerKind: "namespace" | "class" | "method" | "field",
        model: any,
        decorator: any,
        sequence: number,
    ): RawApiOccurrence | undefined {
        const decoratorName = String(decorator.getKind?.() || decorator.kind || "").trim();
        if (!decoratorName) return undefined;
        const ownerName = decoratorOwnerName(ownerKind, model);
        const sourceLocation = decoratorSourceLocation(ownerKind, model);
        const content = String(decorator.getContent?.() || decorator.content || `@${decoratorName}`).trim();
        const param = String(decorator.getParam?.() || decorator.param || "").trim();
        const officialEvidence = this.officialDecorators.has(decoratorName)
            ? [{
                kind: "decorator" as const,
                decoratorName,
                ownerKind,
                ownerName,
                content,
                param,
            }]
            : undefined;
        return {
            rawOccurrenceId: [
                sourceLocation.file,
                ownerKind,
                ownerName,
                decoratorName,
                sequence,
            ].join("#"),
            kind: "decorator",
            sourceLocation,
            enclosingMethodSignature: ownerKind === "method"
                ? model.getSignature?.()?.toString?.() || ""
                : undefined,
            statementText: content,
            ir: {
                methodSignatureText: `@${decoratorName}`,
                unknownSignature: false,
                memberName: decoratorName,
                argCount: param ? 1 : 0,
                argTypes: [],
            },
            officialEvidence,
        };
    }

    private arkUiEvidenceForInvoke(
        method: ArkMethod,
        invokeExpr: any,
        methodName: string,
        argCount: number,
        arkUiChainByLocal: Map<string, ArkUiChainState>,
    ): RawApiOccurrence["arkuiEvidence"] {
        if (!(invokeExpr instanceof ArkInstanceInvokeExpr)) return undefined;
        const baseName = invokeExpr.getBase?.()?.toString?.() || "";
        const chain = arkUiChainByLocal.get(baseName);
        if (!chain) return undefined;
        const events = this.arkUiEventsBySiteKey.get(arkUiEventSiteKey(chain.componentName, methodName, argCount)) || [];
        if (events.length === 0) return undefined;
        const event = events[0];
        return {
            componentName: event.componentName,
            attributeOwner: event.attributeOwner,
            eventName: event.eventName,
            callbackArgCount: event.callbackArgCount,
            sourceFile: sourceFileOf(method),
        };
    }

    private updateArkUiChainState(
        stmt: any,
        invokeExpr: any,
        arkUiChainByLocal: Map<string, ArkUiChainState>,
    ): void {
        if (!(stmt instanceof ArkAssignStmt)) return;
        const left = stmt.getLeftOp?.();
        if (!(left instanceof Local)) return;
        const leftName = left.getName?.() || left.toString?.() || "";
        if (!leftName) return;
        const methodName = invokeMethodName(invokeExpr, invokeExpr.getMethodSignature?.()?.toString?.() || "");
        if (this.arkUiComponents.has(methodName)) {
            arkUiChainByLocal.set(leftName, { componentName: methodName });
            return;
        }
        if (invokeExpr instanceof ArkInstanceInvokeExpr) {
            const baseName = invokeExpr.getBase?.()?.toString?.() || "";
            const baseState = arkUiChainByLocal.get(baseName);
            if (baseState) {
                arkUiChainByLocal.set(leftName, baseState);
            }
        }
    }
}

export type ApiEffectRuntimeIndexLike = Pick<
    ApiEffectRuntimeIndex,
    | "getCanonicalOccurrenceSitesForStmt"
    | "getSitesForRule"
    | "hasRuleSiteAtStmt"
    | "getEffectInstancesForIdentity"
    | "getStats"
>;

function decoratorOwnerName(ownerKind: "namespace" | "class" | "method" | "field", model: any): string {
    if (ownerKind === "method") {
        return model.getSignature?.()?.toString?.() || model.getName?.() || "";
    }
    if (ownerKind === "field") {
        return model.getSignature?.()?.toString?.() || model.getName?.() || "";
    }
    return model.getSignature?.()?.toString?.() || model.getName?.() || "";
}

function decoratorSourceLocation(
    ownerKind: "namespace" | "class" | "method" | "field",
    model: any,
): RawApiOccurrence["sourceLocation"] {
    const file = decoratorSourceFile(ownerKind, model);
    if (ownerKind === "field") {
        const pos = model.getOriginPosition?.();
        return {
            file,
            line: pos?.getLineNo?.(),
            column: pos?.getColNo?.(),
        };
    }
    if (ownerKind === "method") {
        return {
            file,
            line: model.getLine?.() ?? undefined,
            column: model.getColumn?.() ?? undefined,
        };
    }
    return {
        file,
        line: model.getLine?.() ?? undefined,
        column: model.getColumn?.() ?? undefined,
    };
}

function decoratorSourceFile(ownerKind: "namespace" | "class" | "method" | "field", model: any): string {
    if (ownerKind === "method") return sourceFileOf(model);
    if (ownerKind === "field") {
        const klass = model.getDeclaringArkClass?.();
        const file = klass?.getDeclaringArkFile?.();
        return String(
            file?.getFilePath?.()
            || file?.getName?.()
            || file?.getFileSignature?.()?.toString?.()
            || "",
        ).replace(/\\/g, "/");
    }
    const file = model.getDeclaringArkFile?.();
    return String(
        file?.getFilePath?.()
        || file?.getName?.()
        || file?.getFileSignature?.()?.toString?.()
        || "",
    ).replace(/\\/g, "/");
}

function endpointFromTemplate(template: SemanticEffectTemplate): AssetEndpoint | undefined {
    const value = (template as any).value || (template as any).to || (template as any).target || (template as any).unit;
    if (value?.endpoint) return value.endpoint as AssetEndpoint;
    if (value?.base) return value as AssetEndpoint;
    return undefined;
}

function importEvidenceForInvoke(
    method: ArkMethod,
    stmt: any,
    invokeExpr: any,
    methodName: string,
    args: any[],
): ImportMemberKey | undefined {
    const sourceFile = method.getDeclaringArkClass?.()?.getDeclaringArkFile?.()
        || method.getDeclaringArkFile?.();
    const base = resolveImportBaseForInvoke(method, stmt, sourceFile, invokeExpr, methodName);
    if (!base) return undefined;
    const importInfo = base.importInfo;
    const moduleSpecifier = normalizeObservedModuleSpecifier(importInfo.getFrom?.() || "");
    if (!moduleSpecifier) return undefined;
    const importKind = importKindOf(importInfo);
    const importedName = importedNameOf(importInfo, importKind, base.localName);
    const returnType = typeTextOf(invokeExpr.getMethodSignature?.()?.getMethodSubSignature?.()?.getReturnType?.());
    const argShape = argShapeForArgs(method, args);
    return {
        moduleSpecifier,
        importKind,
        importedName,
        localBindingId: `${sourceFileOf(method)}:${base.localName}`,
        localName: base.localName,
        aliasChain: [],
        memberChain: [...base.memberChainPrefix, methodName].filter(Boolean),
        invokeKind: base.constructed && methodName === "constructor" ? "new" : "call",
        argShape: {
            arity: args.length,
            parameterTypes: argShape.parameterTypes,
            returnType,
            literalKinds: argShape.literalKinds,
            objectKeys: argShape.objectKeys,
            callbackPositions: argShape.callbackPositions,
        },
        scopeEvidence: {
            sourceFile: sourceFileOf(method),
            enclosingMethodSignature: method.getSignature?.()?.toString?.() || "",
            shadowed: base.shadowed,
        },
    };
}

function importEvidenceForNewExpr(
    method: ArkMethod,
    stmt: any,
    sourceFile: any,
    newExpr: ArkNewExpr,
): ImportMemberKey | undefined {
    const base = resolveImportBaseForNewExpr(method, stmt, sourceFile, newExpr);
    if (!base) return undefined;
    const importInfo = base.importInfo;
    const moduleSpecifier = normalizeObservedModuleSpecifier(importInfo.getFrom?.() || "");
    if (!moduleSpecifier) return undefined;
    const importKind = importKindOf(importInfo);
    const importedName = importedNameOf(importInfo, importKind, base.localName);
    return {
        moduleSpecifier,
        importKind,
        importedName,
        localBindingId: `${sourceFileOf(method)}:${base.localName}`,
        localName: base.localName,
        aliasChain: [],
        memberChain: [...base.memberChainPrefix, "constructor"].filter(Boolean),
        invokeKind: "new",
        argShape: {
            arity: 0,
            parameterTypes: [],
            returnType: typeTextOf(newExpr.getType?.()),
        },
        scopeEvidence: {
            sourceFile: sourceFileOf(method),
            enclosingMethodSignature: method.getSignature?.()?.toString?.() || "",
            shadowed: base.shadowed,
        },
    };
}

function importEvidenceForField(
    method: ArkMethod,
    stmt: any,
    fieldRef: ArkInstanceFieldRef,
    accessKind: "read" | "write",
): ImportMemberKey | undefined {
    const sourceFile = method.getDeclaringArkClass?.()?.getDeclaringArkFile?.()
        || method.getDeclaringArkFile?.();
    const base = resolveImportBaseForValue(method, stmt, sourceFile, fieldRef.getBase?.(), new Set());
    if (!base) return undefined;
    const importInfo = base.importInfo;
    const moduleSpecifier = normalizeObservedModuleSpecifier(importInfo.getFrom?.() || "");
    if (!moduleSpecifier) return undefined;
    const importKind = importKindOf(importInfo);
    const importedName = importedNameOf(importInfo, importKind, base.localName);
    const fieldName = fieldRef.getFieldSignature?.()?.getFieldName?.()
        || fieldRef.getFieldName?.()
        || "";
    return {
        moduleSpecifier,
        importKind,
        importedName,
        localBindingId: `${sourceFileOf(method)}:${base.localName}`,
        localName: base.localName,
        aliasChain: [],
        memberChain: [...base.memberChainPrefix, fieldName].filter(Boolean),
        invokeKind: accessKind === "write" ? "property-write" : "property-read",
        argShape: {
            arity: 0,
            parameterTypes: [],
            returnType: typeTextOf(fieldRef.getType?.()),
        },
        scopeEvidence: {
            sourceFile: sourceFileOf(method),
            enclosingMethodSignature: method.getSignature?.()?.toString?.() || "",
            shadowed: base.shadowed,
        },
    };
}

function resolveImportBaseForInvoke(
    method: ArkMethod,
    stmt: any,
    sourceFile: any,
    invokeExpr: any,
    methodName: string,
): ImportBaseResolution | undefined {
    if (invokeExpr instanceof ArkInstanceInvokeExpr) {
        return resolveImportBaseForValue(method, stmt, sourceFile, invokeExpr.getBase?.(), new Set());
    }
    if (invokeExpr instanceof ArkPtrInvokeExpr) {
        return resolveImportBaseForValue(method, stmt, sourceFile, invokeExpr.getFuncPtrLocal?.(), new Set())
            || resolveImportBaseByName(method, stmt, sourceFile, methodName);
    }
    return resolveImportBaseByName(method, stmt, sourceFile, methodName);
}

function resolveImportBaseForValue(
    method: ArkMethod,
    stmt: any,
    sourceFile: any,
    value: any,
    visited: Set<string>,
): ImportBaseResolution | undefined {
    if (!(value instanceof Local)) return undefined;
    const localName = value.getName?.() || value.toString?.() || "";
    if (!localName || visited.has(localName)) return undefined;
    visited.add(localName);
    const direct = resolveImportBaseByName(method, stmt, sourceFile, localName);
    if (direct) return direct;
    const declaringStmt = value.getDeclaringStmt?.();
    if (!(declaringStmt instanceof ArkAssignStmt)) return undefined;
    const right = declaringStmt.getRightOp?.();
    if (right instanceof Local) {
        return resolveImportBaseForValue(method, declaringStmt, sourceFile, right, visited);
    }
    if (right instanceof ArkInstanceFieldRef) {
        const base = resolveImportBaseForValue(method, declaringStmt, sourceFile, right.getBase?.(), visited);
        if (!base) return undefined;
        return {
            ...base,
            memberChainPrefix: [...base.memberChainPrefix, right.getFieldName?.() || ""].filter(Boolean),
        };
    }
    if (right instanceof ArkInstanceInvokeExpr) {
        const base = resolveImportBaseForValue(method, declaringStmt, sourceFile, right.getBase?.(), visited);
        if (!base) return undefined;
        const chainedMember = invokeMethodName(right, right.getMethodSignature?.()?.toString?.() || "");
        return {
            ...base,
            memberChainPrefix: [...base.memberChainPrefix, chainedMember].filter(Boolean),
        };
    }
    if (right instanceof ArkNewExpr) {
        return resolveImportBaseForNewExpr(method, declaringStmt, sourceFile, right);
    }
    return undefined;
}

function resolveImportBaseForNewExpr(
    method: ArkMethod,
    stmt: any,
    sourceFile: any,
    newExpr: ArkNewExpr,
): ImportBaseResolution | undefined {
    for (const classChain of classChainsForNewExpr(newExpr)) {
        const importLocalName = classChain[0];
        if (!importLocalName) continue;
        const base = resolveImportBaseByName(method, stmt, sourceFile, importLocalName);
        if (!base) continue;
        return {
            ...base,
            memberChainPrefix: [...base.memberChainPrefix, ...classChain.slice(1)].filter(Boolean),
            constructed: true,
        };
    }
    return undefined;
}

function resolveImportBaseByName(
    method: ArkMethod,
    stmt: any,
    sourceFile: any,
    localName: string,
): ImportBaseResolution | undefined {
    const importInfo = sourceFile?.getImportInfoBy?.(localName);
    if (!importInfo) return undefined;
    return {
        importInfo,
        localName,
        memberChainPrefix: [],
        shadowed: importNameIsShadowedAtStmt(method, localName, stmt),
    };
}

function importNameIsShadowedAtStmt(method: ArkMethod, name: string, stmt: any): boolean {
    if (!name) return false;
    if ((method.getParameters?.() || []).some((parameter: any) => parameter?.getName?.() === name || parameter?.name === name)) {
        return true;
    }
    const local = method.getBody?.()?.getLocals?.()?.get(name);
    const declaringStmt = local?.getDeclaringStmt?.();
    if (!declaringStmt) return false;
    return stmtPositionIsBeforeOrSame(declaringStmt, stmt);
}

function classChainsForNewExpr(newExpr: ArkNewExpr): string[][] {
    const candidates = new Set<string>();
    const classSignature = newExpr.getClassType?.()?.getClassSignature?.();
    addClassChainCandidate(candidates, classSignature?.getClassName?.());
    addClassChainCandidate(candidates, classSignature?.getDeclaringClassName?.());
    addClassChainCandidate(candidates, newExpr.getClassType?.()?.toString?.());
    addClassChainCandidate(candidates, newExpr.toString?.());
    return [...candidates]
        .map(value => value.split(".").map(part => part.trim()).filter(Boolean))
        .filter(chain => chain.length > 0);
}

function addClassChainCandidate(output: Set<string>, value: unknown): void {
    const normalized = normalizeNewExprClassText(value);
    if (normalized) output.add(normalized);
}

function normalizeNewExprClassText(value: unknown): string {
    let text = String(value || "").replace(/\\/g, "/").trim();
    if (!text || isUnknownIdentityText(text)) return "";
    text = text.replace(/^new\s+/, "");
    const paren = text.indexOf("(");
    if (paren >= 0) text = text.slice(0, paren);
    text = text.replace(/<[^<>]*>/g, "");
    const matches = text.match(/[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g) || [];
    for (let index = matches.length - 1; index >= 0; index--) {
        const candidate = matches[index];
        if (!candidate || candidate === "new" || candidate === "constructor") continue;
        if (isUnknownIdentityText(candidate)) continue;
        return candidate;
    }
    return "";
}

function stmtPositionIsBeforeOrSame(left: any, right: any): boolean {
    const leftPos = left?.getOriginPositionInfo?.();
    const rightPos = right?.getOriginPositionInfo?.();
    const leftLine = leftPos?.getLineNo?.() ?? -1;
    const leftCol = leftPos?.getColNo?.() ?? -1;
    const rightLine = rightPos?.getLineNo?.() ?? -1;
    const rightCol = rightPos?.getColNo?.() ?? -1;
    if (leftLine < 0 || rightLine < 0) return true;
    return leftLine < rightLine || (leftLine === rightLine && leftCol <= rightCol);
}

function argShapeForArgs(method: ArkMethod, args: any[]): Required<Pick<ImportMemberKey["argShape"], "parameterTypes" | "literalKinds" | "objectKeys" | "callbackPositions">> {
    const literalKinds: Array<{ index: number; kind: string }> = [];
    const objectKeys: Array<{ index: number; keys: string[] }> = [];
    const callbackPositions: number[] = [];
    args.forEach((arg, index) => {
        const kind = literalKindOfArg(method, arg);
        if (kind) literalKinds.push({ index, kind });
        const keys = objectKeysOfArg(method, arg);
        if (keys.length > 0) objectKeys.push({ index, keys });
        if (argIsCallbackLike(arg)) callbackPositions.push(index);
    });
    return {
        parameterTypes: args.map(arg => parameterTypeConstraintText(method, arg)),
        literalKinds,
        objectKeys,
        callbackPositions,
    };
}

function parameterTypeConstraintText(method: ArkMethod, arg: any): string {
    if (arg instanceof StringConstant) return "unknown";
    if (arg instanceof NumberConstant) return "unknown";
    if (arg instanceof BooleanConstant) return "unknown";
    if (arg instanceof NullConstant) return "unknown";
    if (arg instanceof UndefinedConstant) return "unknown";
    if (arg instanceof ArkNewArrayExpr) return "unknown";
    if (argIsCallbackLike(arg)) return "unknown";
    if (objectKeysOfArg(method, arg).length > 0) return "unknown";
    return typeTextOf(arg);
}

function literalKindOfArg(method: ArkMethod, arg: any): string | undefined {
    if (arg instanceof StringConstant) return "string";
    if (arg instanceof NumberConstant) return "number";
    if (arg instanceof BooleanConstant) return "boolean";
    if (arg instanceof NullConstant) return "null";
    if (arg instanceof UndefinedConstant) return "undefined";
    if (arg instanceof ArkNewArrayExpr) return "array";
    if (argIsCallbackLike(arg)) return "function";
    if (objectKeysOfArg(method, arg).length > 0) return "object";
    const type = arg?.getType?.();
    if (type instanceof ArrayType) return "array";
    return undefined;
}

function objectKeysOfArg(method: ArkMethod, arg: any): string[] {
    const type = arg?.getType?.();
    if (!(type instanceof ClassType)) return [];
    const signature = type.getClassSignature?.();
    const scene = method.getDeclaringArkFile?.()?.getScene?.();
    const klass = signature ? scene?.getClass?.(signature) : undefined;
    if (!klass) return [];
    const category = klass.getCategory?.();
    if (category !== ClassCategory.OBJECT && category !== ClassCategory.TYPE_LITERAL) return [];
    return [...new Set((klass.getFields?.() || [])
        .map((field: any) => field.getName?.() || field.getSignature?.()?.getFieldName?.() || "")
        .filter(Boolean))]
        .sort();
}

function argIsCallbackLike(arg: any): boolean {
    const type = arg?.getType?.();
    return type instanceof FunctionType || type?.constructor?.name === "ClosureType";
}

function projectEvidenceForInvoke(invokeExpr: any): RawApiOccurrence["projectEvidence"] | undefined {
    const signature = invokeExpr.getMethodSignature?.();
    if (!signature) return undefined;
    const declaringClass = signature.getDeclaringClassSignature?.();
    const subSignature = signature.getMethodSubSignature?.();
    const declaringFile = String(declaringClass?.getDeclaringFileSignature?.()?.toString?.() || "").trim();
    const declaringNamespacePath = namespacePathFromClassSignature(declaringClass);
    const declaringClassName = String(declaringClass?.getClassName?.() || "").trim();
    const methodName = String(subSignature?.getMethodName?.() || extractMemberNameFromText(signature.toString?.() || "") || "").trim();
    const parameterTypes = (subSignature?.getParameters?.() || []).map((param: any) => typeTextOf(param));
    const returnType = typeTextOf(subSignature?.getReturnType?.());
    if (!declaringFile || !methodName || isUnknownIdentityText(declaringFile) || isUnknownIdentityText(methodName)) {
        return undefined;
    }
    if (isUnknownIdentityText(declaringClassName) || isUnknownIdentityText(returnType)) {
        return undefined;
    }
    if (parameterTypes.some(isUnknownIdentityText)) {
        return undefined;
    }
    const fileLevelOwner = !declaringClassName || declaringClassName === "%dflt";
    const namespaceOwner = declaringNamespacePath.join(".");
    const exportPath = declaringNamespacePath.length > 0
        ? [
            `namespace:${namespaceOwner}`,
            ...(fileLevelOwner ? [] : [`namespace:${declaringClassName}`]),
        ]
        : [fileLevelOwner ? "default:file" : `namespace:${declaringClassName}`];
    const ownerPath = declaringNamespacePath.length > 0
        ? [...declaringNamespacePath, ...(fileLevelOwner ? [] : [declaringClassName])]
        : [fileLevelOwner ? "file" : declaringClassName];
    return {
        file: declaringFile,
        exportPath,
        ownerPath,
        memberName: methodName,
        parameterTypes,
        returnType,
    };
}

function importKindOf(importInfo: any): ImportMemberKey["importKind"] {
    const importType = String(importInfo.getImportType?.() || "").toLowerCase();
    if (importInfo.isDefault?.()) return "default";
    if (importType.includes("namespace")) return "namespace";
    return "named";
}

function importedNameOf(importInfo: any, importKind: ImportMemberKey["importKind"], baseName: string): string {
    if (importKind === "default") return "default";
    if (importKind === "namespace") return "*";
    return String(importInfo.getOriginName?.() || importInfo.getImportClauseName?.() || baseName || "").trim();
}

function normalizeObservedModuleSpecifier(value: string): string {
    const raw = String(value || "").replace(/\\/g, "/").trim();
    if (!raw) return "";
    if (raw.startsWith("api/@") && raw.endsWith(".d.ts")) return raw.slice("api/".length, -".d.ts".length);
    if (raw.startsWith("api/@") && raw.endsWith(".d.ets")) return raw.slice("api/".length, -".d.ets".length);
    if (raw.startsWith("ohos/")) return `@ohos.${raw.slice("ohos/".length)}`;
    return raw;
}

function arkanalyzerMethodKeyFromInvoke(invokeExpr: any): RawApiOccurrence["ir"]["arkanalyzerMethodKey"] | undefined {
    const signature = invokeExpr.getMethodSignature?.();
    if (!signature) return undefined;
    const declaringClass = signature.getDeclaringClassSignature?.();
    const subSignature = signature.getMethodSubSignature?.();
    const methodName = subSignature?.getMethodName?.() || extractMemberNameFromText(signature.toString?.() || "");
    const parameters = subSignature?.getParameters?.() || [];
    return {
        declaringFileName: declaringClass?.getDeclaringFileSignature?.()?.toString?.() || "",
        declaringNamespacePath: namespacePathFromClassSignature(declaringClass),
        declaringClassName: declaringClass?.getClassName?.() || "",
        methodName,
        parameterTypes: parameters.map((param: any) => typeTextOf(param)),
        returnType: typeTextOf(subSignature?.getReturnType?.()),
        staticFlag: invokeExpr instanceof ArkStaticInvokeExpr,
    };
}

function namespacePathFromClassSignature(declaringClass: any): string[] {
    const namespaceSignature = declaringClass?.getDeclaringNamespaceSignature?.();
    return namespacePathFromSignatureText(namespaceSignature?.toString?.() || "");
}

function namespacePathFromSignatureText(value: string): string[] {
    const text = String(value || "")
        .replace(/\\/g, "/")
        .replace(/:\s*$/g, "")
        .trim();
    if (!text) return [];
    const colon = text.lastIndexOf(":");
    const namespaceText = (colon >= 0 ? text.slice(colon + 1) : text).trim();
    if (!namespaceText || namespaceText === "%dflt") return [];
    return namespaceText
        .split(".")
        .map(part => part.trim())
        .filter(part => part.length > 0 && part !== "%dflt");
}

function invokeMethodName(invokeExpr: any, calleeSignature: string): string {
    const fromSig = invokeExpr.getMethodSignature?.()?.getMethodSubSignature?.()?.getMethodName?.();
    if (fromSig) return String(fromSig);
    return extractMemberNameFromText(calleeSignature) || "";
}

function extractMemberNameFromText(value: string): string | undefined {
    const text = String(value || "");
    const callMatch = /\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(text);
    if (callMatch?.[1]) return callMatch[1];
    const fieldMatch = /\.([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:>|$)/.exec(text);
    return fieldMatch?.[1];
}

function receiverText(invokeExpr: any): string | undefined {
    if (invokeExpr instanceof ArkInstanceInvokeExpr) {
        return invokeExpr.getBase?.()?.toString?.() || undefined;
    }
    return undefined;
}

function invokeExprKind(invokeExpr: any): RawApiOccurrence["ir"]["invokeExprKind"] {
    if (invokeExpr instanceof ArkInstanceInvokeExpr) return "ArkInstanceInvokeExpr";
    if (invokeExpr instanceof ArkPtrInvokeExpr) return "ArkPtrInvokeExpr";
    return "ArkStaticInvokeExpr";
}

function sourceLocationFor(method: ArkMethod, stmt: any): RawApiOccurrence["sourceLocation"] {
    const pos = stmt.getOriginPositionInfo?.();
    return {
        file: sourceFileOf(method),
        line: pos?.getLineNo?.(),
        column: pos?.getColNo?.(),
    };
}

function sourceFileOf(method: ArkMethod): string {
    const file = method.getDeclaringArkClass?.()?.getDeclaringArkFile?.()
        || method.getDeclaringArkFile?.();
    return String(
        file?.getFilePath?.()
        || file?.getName?.()
        || file?.getFileSignature?.()?.toString?.()
        || "",
    ).replace(/\\/g, "/");
}

function rawOccurrenceId(method: ArkMethod, stmt: any, sequence: number, kind: string): string {
    const pos = stmt.getOriginPositionInfo?.();
    return [
        sourceFileOf(method),
        method.getSignature?.()?.toString?.() || "",
        pos?.getLineNo?.() ?? -1,
        pos?.getColNo?.() ?? -1,
        kind,
        sequence,
    ].join("#");
}

function isUnknownSignature(value: string): boolean {
    const text = String(value || "");
    return !text || text.includes("%unk") || text.includes("@unk");
}

function isUnknownIdentityText(value: unknown): boolean {
    const text = String(value || "").trim();
    return !text || text.includes("%unk") || text.includes("@unk") || text === "unknown";
}

function typeTextOf(value: any): string {
    return String(value?.getType?.()?.toString?.() || value?.toString?.() || "unknown").trim() || "unknown";
}

function ruleKey(identity: ApiEffectIdentity): string {
    return [
        identity.role,
        identity.canonicalApiId,
        identity.assetId,
        identity.surfaceId,
        identity.bindingId,
        identity.effectTemplateId,
    ].join("|");
}

function arkUiEventSiteKey(componentName: string, eventName: string, callbackArgCount: number): string {
    return `${componentName}|${eventName}|${callbackArgCount}`;
}

function arkUiEventDescriptorKey(event: ArkUiEventDescriptor): string {
    return [
        event.componentName,
        event.attributeOwner,
        event.eventName,
        event.callbackArgCount,
    ].join("|");
}

function componentNameFromAttributeOwner(owner: string): string | undefined {
    const text = String(owner || "");
    if (text.endsWith("Attribute") && text.length > "Attribute".length) {
        return text.slice(0, -"Attribute".length);
    }
    return undefined;
}

function endpointIsCallback(endpoint: AssetEndpoint | undefined): boolean {
    return endpoint?.base?.kind === "callbackArg" || endpoint?.base?.kind === "callbackReturn";
}
