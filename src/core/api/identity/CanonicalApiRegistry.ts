import type { CanonicalApiDescriptor, IdentityEvidence } from "./CanonicalApiDescriptor";
import type { ArkanalyzerMethodKey } from "./CanonicalApiDescriptor";
import { arkanalyzerMethodKeyString, isKnownArkanalyzerMethodKey } from "./ArkanalyzerMethodKey";
import type { ImportMemberKey } from "./ImportMemberKey";
import {
    importMemberCandidateKeyFromImportMemberKey,
    importMemberCandidateKeyString,
    importMemberKeyString,
    knownShapeConstraintsFromImportMemberKey,
    type ImportMemberCandidateKey,
    type KnownShapeConstraints,
} from "./ImportMemberKey";
import type { ArkUiChainKey } from "./ArkUiChainKey";
import { arkUiChainKeyString } from "./ArkUiChainKey";
import type { ProjectDeclarationKey } from "./ProjectDeclarationKey";
import { projectDeclarationKeyString } from "./ProjectDeclarationKey";
import { assertValidCanonicalApiId } from "./CanonicalApiId";
import { DeclarationShapeIndex } from "./DeclarationShapeIndex";

export type ApiIdentityResolutionStatus = "accepted" | "unresolved" | "ambiguous" | "rejected";

export interface ApiIdentityResolution {
    status: ApiIdentityResolutionStatus;
    canonicalApiId?: string;
    candidates?: string[];
    reason: string;
    evidence: IdentityEvidence[];
}

export class CanonicalApiRegistry {
    private readonly byId = new Map<string, CanonicalApiDescriptor>();
    private readonly byArkanalyzerMethodKey = new Map<string, string>();
    private readonly byImportMemberKey = new Map<string, string[]>();
    private readonly byImportMemberCandidateKey = new Map<string, string[]>();
    private readonly byArkUiChainKey = new Map<string, string[]>();
    private readonly byProjectDeclarationKey = new Map<string, string>();
    private readonly declarationShapeIndex: DeclarationShapeIndex;

    constructor(descriptors: readonly CanonicalApiDescriptor[] = []) {
        this.declarationShapeIndex = DeclarationShapeIndex.fromDescriptors(descriptors);
        for (const descriptor of descriptors) {
            this.addDescriptor(descriptor);
        }
    }

    addDescriptor(descriptor: CanonicalApiDescriptor): void {
        assertValidCanonicalApiId(descriptor.canonicalApiId);
        const existing = this.byId.get(descriptor.canonicalApiId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(descriptor)) {
            throw new Error(`canonicalApiId collision for different descriptors: ${descriptor.canonicalApiId}`);
        }
        this.byId.set(descriptor.canonicalApiId, descriptor);
        if (descriptor.arkanalyzer && isKnownArkanalyzerMethodKey(descriptor.arkanalyzer)) {
            setUniqueIndex(this.byArkanalyzerMethodKey, arkanalyzerMethodKeyString(descriptor.arkanalyzer), descriptor.canonicalApiId, "arkanalyzer method key");
        }
        for (const key of importKeysForDescriptor(descriptor)) {
            appendIndex(this.byImportMemberKey, key, descriptor.canonicalApiId);
        }
        for (const key of importCandidateKeysForDescriptor(descriptor)) {
            appendIndex(this.byImportMemberCandidateKey, key, descriptor.canonicalApiId);
        }
        const arkUiKey = arkUiKeyForDescriptor(descriptor);
        if (arkUiKey) {
            appendIndex(this.byArkUiChainKey, arkUiKey, descriptor.canonicalApiId);
        }
        const projectKey = projectKeyForDescriptor(descriptor);
        if (projectKey) {
            setUniqueIndex(this.byProjectDeclarationKey, projectKey, descriptor.canonicalApiId, "project declaration key");
        }
    }

    get(id: string): CanonicalApiDescriptor | undefined {
        return this.byId.get(id);
    }

    require(id: string): CanonicalApiDescriptor {
        const descriptor = this.get(id);
        if (!descriptor) throw new Error(`unknown canonicalApiId: ${id}`);
        return descriptor;
    }

    has(id: string): boolean {
        return this.byId.has(id);
    }

    listDescriptors(): CanonicalApiDescriptor[] {
        return [...this.byId.values()];
    }

    resolveArkanalyzerMethodKey(key: ArkanalyzerMethodKey): ApiIdentityResolution {
        if (!isKnownArkanalyzerMethodKey(key)) {
            return unresolved("arkanalyzer_method_key_contains_unknown", { key });
        }
        const id = this.byArkanalyzerMethodKey.get(arkanalyzerMethodKeyString(key));
        return id
            ? accepted(id, "arkanalyzer_method_key_exact", { key })
            : unresolved("arkanalyzer_method_key_not_registered", { key });
    }

    resolveImportMemberKey(key: ImportMemberKey): ApiIdentityResolution {
        if (key.scopeEvidence.shadowed) {
            return rejected("import_binding_shadowed", { key });
        }
        if (!key.localBindingId || !key.moduleSpecifier || key.memberChain.length === 0) {
            return unresolved("import_member_key_incomplete", { key });
        }
        const exact = this.byImportMemberKey.get(importMemberKeyString(key));
        if (exact) return unique(exact, "import_member_key_exact", { key });
        const candidateKey = importMemberCandidateKeyFromImportMemberKey(key);
        const candidates = this.byImportMemberCandidateKey.get(importMemberCandidateKeyString(candidateKey));
        if (!candidates) {
            return unresolved("import_member_candidate_not_registered", { key, candidateKey });
        }
        const constraints = knownShapeConstraintsFromImportMemberKey(key);
        const filtered = this.filterImportMemberCandidatesByKnownShape(candidates, constraints);
        return resolveImportMemberCandidateSet(filtered.candidates, {
            key,
            candidateKey,
            constraints,
            candidateCountBeforeShape: [...new Set(candidates)].length,
            candidateCountAfterShape: [...new Set(filtered.candidates)].length,
            candidates: [...new Set(candidates)],
            shapeDiagnostics: filtered.diagnostics,
        });
    }

    resolveArkUiChainKey(key: ArkUiChainKey): ApiIdentityResolution {
        const candidates = this.byArkUiChainKey.get(arkUiChainKeyString(key));
        return candidates
            ? unique(candidates, "arkui_chain_key_exact", { key })
            : unresolved("arkui_chain_key_not_registered", { key });
    }

    resolveProjectDeclarationKey(key: ProjectDeclarationKey): ApiIdentityResolution {
        const id = this.byProjectDeclarationKey.get(projectDeclarationKeyString(key));
        return id
            ? accepted(id, "project_declaration_key_exact", { key })
            : unresolved("project_declaration_key_not_registered", { key });
    }

    private filterImportMemberCandidatesByKnownShape(
        candidates: readonly string[],
        constraints: KnownShapeConstraints,
    ): ShapeFilterResult {
        const filtered: string[] = [];
        const diagnostics: ShapeFilterDiagnostics = {
            rejectedByParameterType: [],
            rejectedByReturnType: [],
            rejectedByObjectKeys: [],
            rejectedByLiteralKinds: [],
            rejectedByCallbackPositions: [],
            missingShapeMetadata: [],
        };
        for (const candidate of [...new Set(candidates)]) {
            const descriptor = this.byId.get(candidate);
            if (!descriptor) continue;
            if (!descriptorMatchesKnownParameterTypes(descriptor, constraints)) {
                diagnostics.rejectedByParameterType.push(candidate);
                continue;
            }
            if (constraints.returnType && descriptor.signature.returnType.text !== constraints.returnType) {
                diagnostics.rejectedByReturnType.push(candidate);
                continue;
            }
            if (!this.descriptorMatchesCallbackPositions(descriptor, constraints, diagnostics)) continue;
            if (!this.descriptorMatchesObjectKeys(descriptor, constraints, diagnostics)) continue;
            if (!this.descriptorMatchesLiteralKinds(descriptor, constraints, diagnostics)) continue;
            filtered.push(candidate);
        }
        return { candidates: filtered, diagnostics };
    }

    private descriptorMatchesObjectKeys(
        descriptor: CanonicalApiDescriptor,
        constraints: KnownShapeConstraints,
        diagnostics: ShapeFilterDiagnostics,
    ): boolean {
        for (const constraint of constraints.objectKeys) {
            const shape = this.declarationShapeIndex.getParameterShape(descriptor.canonicalApiId, constraint.index);
            if (!shape?.objectPropertyNames) {
                if (shape && shapeHasKnownNonObjectLiteralKind(shape)) {
                    diagnostics.rejectedByObjectKeys.push({
                        canonicalApiId: descriptor.canonicalApiId,
                        parameterIndex: constraint.index,
                        observedKeys: constraint.keys,
                        declaredKeys: shape.objectPropertyNames || [],
                    });
                    return false;
                }
                diagnostics.missingShapeMetadata.push({
                    canonicalApiId: descriptor.canonicalApiId,
                    parameterIndex: constraint.index,
                    kind: "objectKeys",
                });
                continue;
            }
            const declared = new Set(shape.objectPropertyNames);
            if (!constraint.keys.every(key => declared.has(key))) {
                diagnostics.rejectedByObjectKeys.push({
                    canonicalApiId: descriptor.canonicalApiId,
                    parameterIndex: constraint.index,
                    observedKeys: constraint.keys,
                    declaredKeys: shape.objectPropertyNames,
                });
                return false;
            }
        }
        return true;
    }

    private descriptorMatchesLiteralKinds(
        descriptor: CanonicalApiDescriptor,
        constraints: KnownShapeConstraints,
        diagnostics: ShapeFilterDiagnostics,
    ): boolean {
        for (const constraint of constraints.literalKinds) {
            const shape = this.declarationShapeIndex.getParameterShape(descriptor.canonicalApiId, constraint.index);
            if (!shape) {
                diagnostics.missingShapeMetadata.push({
                    canonicalApiId: descriptor.canonicalApiId,
                    parameterIndex: constraint.index,
                    kind: "literalKind",
                });
                continue;
            }
            if (shapeAcceptsLiteralKind(shape, constraint.kind)) continue;
            if (shape.metadataSource === "type-text" && shape.acceptsLiteralKinds.length === 0) {
                diagnostics.missingShapeMetadata.push({
                    canonicalApiId: descriptor.canonicalApiId,
                    parameterIndex: constraint.index,
                    kind: "literalKind",
                });
                continue;
            }
            diagnostics.rejectedByLiteralKinds.push({
                canonicalApiId: descriptor.canonicalApiId,
                parameterIndex: constraint.index,
                observedKind: constraint.kind,
                acceptedKinds: shape.acceptsLiteralKinds,
            });
            return false;
        }
        return true;
    }

    private descriptorMatchesCallbackPositions(
        descriptor: CanonicalApiDescriptor,
        constraints: KnownShapeConstraints,
        diagnostics: ShapeFilterDiagnostics,
    ): boolean {
        for (const index of constraints.callbackPositions) {
            const shape = this.declarationShapeIndex.getParameterShape(descriptor.canonicalApiId, index);
            if (shape?.callbackLike) continue;
            const typeText = descriptor.signature.parameters[index]?.type.text || "";
            if (!shape && isCallbackLikeTypeText(typeText)) continue;
            diagnostics.rejectedByCallbackPositions.push({
                canonicalApiId: descriptor.canonicalApiId,
                parameterIndex: index,
                declaredType: typeText,
            });
            return false;
        }
        return true;
    }
}

export function createCanonicalApiRegistry(descriptors: readonly CanonicalApiDescriptor[] = []): CanonicalApiRegistry {
    return new CanonicalApiRegistry(descriptors);
}

function accepted(id: string, reason: string, data: Record<string, unknown>): ApiIdentityResolution {
    return {
        status: "accepted",
        canonicalApiId: id,
        reason,
        evidence: [{ kind: reason, message: reason, data }],
    };
}

function unresolved(reason: string, data: Record<string, unknown>): ApiIdentityResolution {
    return {
        status: "unresolved",
        reason,
        evidence: [{ kind: reason, message: reason, data }],
    };
}

function rejected(reason: string, data: Record<string, unknown>): ApiIdentityResolution {
    return {
        status: "rejected",
        reason,
        evidence: [{ kind: reason, message: reason, data }],
    };
}

function unique(candidates: string[], reason: string, data: Record<string, unknown>): ApiIdentityResolution {
    const uniqueCandidates = [...new Set(candidates)];
    if (uniqueCandidates.length === 1) return accepted(uniqueCandidates[0], reason, data);
    if (uniqueCandidates.length === 0) return unresolved(`${reason}_no_candidate`, data);
    return {
        status: "ambiguous",
        candidates: uniqueCandidates,
        reason: `${reason}_ambiguous`,
        evidence: [{ kind: `${reason}_ambiguous`, message: `${reason}_ambiguous`, data }],
    };
}

function resolveImportMemberCandidateSet(candidates: string[], data: Record<string, unknown>): ApiIdentityResolution {
    const uniqueCandidates = [...new Set(candidates)];
    if (uniqueCandidates.length === 1) return accepted(uniqueCandidates[0], "import_member_candidate_exact_unique", data);
    if (uniqueCandidates.length === 0) return unresolved("import_member_shape_constraints_no_candidate", data);
    const diagnostics = data.shapeDiagnostics as ShapeFilterDiagnostics | undefined;
    const reason = diagnostics?.missingShapeMetadata.length
        ? "import_member_candidate_missing_shape_metadata"
        : "import_member_candidate_exact_ambiguous";
    return {
        status: "ambiguous",
        candidates: uniqueCandidates,
        reason,
        evidence: [{ kind: reason, message: reason, data }],
    };
}

interface ShapeFilterResult {
    candidates: string[];
    diagnostics: ShapeFilterDiagnostics;
}

interface ShapeFilterDiagnostics {
    rejectedByParameterType: string[];
    rejectedByReturnType: string[];
    rejectedByObjectKeys: Array<{
        canonicalApiId: string;
        parameterIndex: number;
        observedKeys: string[];
        declaredKeys: string[];
    }>;
    rejectedByLiteralKinds: Array<{
        canonicalApiId: string;
        parameterIndex: number;
        observedKind: string;
        acceptedKinds: string[];
    }>;
    rejectedByCallbackPositions: Array<{
        canonicalApiId: string;
        parameterIndex: number;
        declaredType: string;
    }>;
    missingShapeMetadata: Array<{
        canonicalApiId: string;
        parameterIndex: number;
        kind: "objectKeys" | "literalKind";
    }>;
}

function appendIndex(map: Map<string, string[]>, key: string, id: string): void {
    const current = map.get(key) || [];
    if (!current.includes(id)) current.push(id);
    map.set(key, current);
}

function setUniqueIndex(map: Map<string, string>, key: string, id: string, label: string): void {
    const existing = map.get(key);
    if (existing && existing !== id) {
        throw new Error(`canonical registry ${label} collision: ${JSON.stringify({ key, existing, next: id })}`);
    }
    map.set(key, id);
}

function importKeysForDescriptor(descriptor: CanonicalApiDescriptor): string[] {
    const keys = new Set<string>();
    for (const importKind of importKindsForDescriptor(descriptor)) {
        for (const importedName of importedNamesForDescriptor(descriptor, importKind)) {
            for (const memberChain of memberChainsForDescriptor(descriptor, importKind, importedName)) {
                keys.add(importMemberKeyString({
                    moduleSpecifier: descriptor.moduleSpecifier,
                    importKind,
                    importedName,
                    localBindingId: "<registry>",
                    localName: importedName,
                    aliasChain: [],
                    memberChain,
                    invokeKind: invokeKindForDescriptor(descriptor),
                    argShape: {
                        arity: descriptor.signature.parameters.length,
                        parameterTypes: descriptor.signature.parameters.map(param => param.type.text),
                        returnType: descriptor.signature.returnType.text,
                    },
                    scopeEvidence: {
                        sourceFile: "",
                        enclosingMethodSignature: "",
                        shadowed: false,
                    },
                }));
            }
        }
    }
    return [...keys];
}

function importCandidateKeysForDescriptor(descriptor: CanonicalApiDescriptor): string[] {
    const keys = new Set<string>();
    for (const importKind of importKindsForDescriptor(descriptor)) {
        for (const importedName of importedNamesForDescriptor(descriptor, importKind)) {
            for (const memberChain of memberChainsForDescriptor(descriptor, importKind, importedName)) {
                keys.add(importMemberCandidateKeyString({
                    moduleSpecifier: descriptor.moduleSpecifier,
                    importKind,
                    importedName,
                    memberChain,
                    invokeKind: invokeKindForDescriptor(descriptor),
                    arity: descriptor.signature.parameters.length,
                }));
            }
        }
    }
    return [...keys];
}

function descriptorMatchesKnownParameterTypes(
    descriptor: CanonicalApiDescriptor,
    constraints: KnownShapeConstraints,
): boolean {
    for (const constraint of constraints.parameterTypes) {
        if (descriptor.signature.parameters[constraint.index]?.type.text !== constraint.type) return false;
    }
    return true;
}

function isCallbackLikeTypeText(value: string): boolean {
    const text = String(value || "");
    return /\b(callback|function)\b/i.test(text)
        || text.includes("=>")
        || /^Function\b/.test(text)
        || /\([^)]*\)\s*=>/.test(text);
}

function shapeAcceptsLiteralKind(
    shape: NonNullable<ReturnType<DeclarationShapeIndex["getParameterShape"]>>,
    kind: string,
): boolean {
    if (shape.acceptsLiteralKinds.includes(kind)) return true;
    if (kind === "object" && shape.objectPropertyNames && shape.objectPropertyNames.length > 0) return true;
    if (kind === "function" && shape.callbackLike) return true;
    if (kind === "array" && shape.arrayLike) return true;
    return false;
}

function shapeHasKnownNonObjectLiteralKind(
    shape: NonNullable<ReturnType<DeclarationShapeIndex["getParameterShape"]>>,
): boolean {
    if (shape.callbackLike || shape.arrayLike || shape.promiseLike) return true;
    const accepted = new Set(shape.acceptsLiteralKinds);
    if (accepted.size === 0) return false;
    return !accepted.has("object");
}

function importedNameForDescriptor(descriptor: CanonicalApiDescriptor): string {
    const first = descriptor.exportPath[0];
    return first?.name || descriptor.declarationOwner.normalizedName || descriptor.member.name;
}

function importKindsForDescriptor(descriptor: CanonicalApiDescriptor): Array<Extract<ImportMemberKey["importKind"], "default" | "namespace" | "named">> {
    const kinds = new Set<Extract<ImportMemberKey["importKind"], "default" | "namespace" | "named">>();
    for (const exportPart of descriptor.exportPath) {
        if (exportPart.kind === "default") kinds.add("default");
        if (exportPart.kind === "namespace") {
            kinds.add("namespace");
            kinds.add("default");
        }
        if (exportPart.kind === "named") {
            kinds.add("named");
            kinds.add("namespace");
        }
    }
    if (kinds.size === 0) {
        kinds.add(descriptor.member.kind === "function" ? "named" : "namespace");
    }
    return [...kinds];
}

function importedNamesForDescriptor(
    descriptor: CanonicalApiDescriptor,
    importKind: Extract<ImportMemberKey["importKind"], "default" | "namespace" | "named">,
): string[] {
    const names = new Set<string>();
    if (importKind === "default") {
        names.add("default");
        names.add("%dflt");
        return [...names];
    }
    if (importKind === "namespace") {
        names.add("*");
        names.add(importedNameForDescriptor(descriptor));
        names.add(descriptor.declarationOwner.normalizedName);
        return [...names].filter(Boolean);
    }
    names.add(descriptor.member.name);
    names.add(importedNameForDescriptor(descriptor));
    const namedExport = descriptor.exportPath.find(part => part.kind === "named");
    if (namedExport?.name) names.add(namedExport.name);
    return [...names].filter(Boolean);
}

function invokeKindForDescriptor(descriptor: CanonicalApiDescriptor): ImportMemberKey["invokeKind"] {
    if (descriptor.invoke.kind === "new") return "new";
    if (descriptor.invoke.kind === "property-read") return "property-read";
    if (descriptor.invoke.kind === "property-write") return "property-write";
    return "call";
}

function memberChainsForDescriptor(
    descriptor: CanonicalApiDescriptor,
    importKind: Extract<ImportMemberKey["importKind"], "default" | "namespace" | "named">,
    importedName: string,
): string[][] {
    const memberName = descriptor.member.kind === "constructor"
        ? "constructor"
        : descriptor.member.name;
    const ownerChain = relativeOwnerChainForImport(descriptor, importKind, importedName);
    const chains = new Set<string>();

    if (ownerChain.length > 0) {
        addMemberChain(chains, [...ownerChain, memberName]);
        if (descriptor.member.kind === "constructor") {
            addMemberChain(chains, ownerChain);
        }
    } else {
        addMemberChain(chains, [memberName]);
    }

    return [...chains]
        .map(value => value.split(".").filter(Boolean))
        .filter(chain => chain.length > 0);
}

function relativeOwnerChainForImport(
    descriptor: CanonicalApiDescriptor,
    importKind: Extract<ImportMemberKey["importKind"], "default" | "namespace" | "named">,
    importedName: string,
): string[] {
    if (descriptor.declarationOwner.kind === "file") return [];
    if (descriptor.declarationOwner.kind === "function") {
        const owner = descriptor.declarationOwner.path[descriptor.declarationOwner.path.length - 1] || "";
        return owner === descriptor.member.name ? [] : ownerPathSegments(descriptor.declarationOwner.path);
    }

    const ownerPath = ownerPathSegments(descriptor.declarationOwner.path);
    if (ownerPath.length === 0) return [];
    const rootCandidates = importRootCandidates(descriptor, importKind, importedName);
    for (const candidate of rootCandidates) {
        const stripped = stripPrefix(ownerPath, candidate);
        if (stripped.length !== ownerPath.length) return stripped;
    }
    return ownerPath;
}

function importRootCandidates(
    descriptor: CanonicalApiDescriptor,
    importKind: Extract<ImportMemberKey["importKind"], "default" | "namespace" | "named">,
    importedName: string,
): string[][] {
    const candidates: string[][] = [];
    const push = (value: string | undefined): void => {
        const segments = ownerPathSegments(String(value || "").split("."));
        if (segments.length > 0 && !candidates.some(item => sameStringArray(item, segments))) {
            candidates.push(segments);
        }
    };

    if (importKind === "named") {
        push(importedName);
    }

    if (importKind === "default") {
        for (const part of descriptor.exportPath) {
            if (part.kind === "default") push(part.name);
            if (part.kind === "namespace") push(firstPathSegment(part.name));
        }
    }

    if (importKind === "namespace") {
        for (const part of descriptor.exportPath) {
            if (part.kind === "namespace") push(firstPathSegment(part.name));
        }
    }

    return candidates;
}

function ownerPathSegments(values: readonly string[]): string[] {
    return values
        .flatMap(value => String(value || "").split("."))
        .map(value => value.trim())
        .filter(Boolean);
}

function firstPathSegment(value: string): string {
    return ownerPathSegments([value])[0] || "";
}

function stripPrefix(value: readonly string[], prefix: readonly string[]): string[] {
    if (prefix.length === 0 || prefix.length > value.length) return [...value];
    for (let index = 0; index < prefix.length; index++) {
        if (value[index] !== prefix[index]) return [...value];
    }
    return value.slice(prefix.length);
}

function addMemberChain(output: Set<string>, chain: readonly string[]): void {
    const normalized = chain.map(part => String(part || "").trim()).filter(Boolean);
    if (normalized.length > 0) output.add(normalized.join("."));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function arkUiKeyForDescriptor(descriptor: CanonicalApiDescriptor): string | undefined {
    const exportPart = descriptor.exportPath.find(part => part.kind === "component");
    const componentName = exportPart?.name || componentNameFromAttributeOwner(descriptor.declarationOwner.normalizedName);
    if (!componentName) return undefined;
    if (descriptor.member.kind !== "component-event") {
        if (descriptor.invoke.kind !== "call") return undefined;
        if (descriptor.member.kind !== "method" && descriptor.member.kind !== "function") return undefined;
    }
    return arkUiChainKeyString({
        componentName,
        attributeOwner: descriptor.declarationOwner.normalizedName,
        eventName: descriptor.member.name,
        callbackArgCount: descriptor.signature.parameters.length,
        sourceFile: "",
    });
}

function componentNameFromAttributeOwner(owner: string): string | undefined {
    const text = String(owner || "");
    if (text.endsWith("Attribute") && text.length > "Attribute".length) {
        return text.slice(0, -"Attribute".length);
    }
    return undefined;
}

function projectKeyForDescriptor(descriptor: CanonicalApiDescriptor): string | undefined {
    if (descriptor.authority === "official") return undefined;
    return projectDeclarationKeyString({
        file: descriptor.logicalDeclarationFile,
        exportPath: descriptor.exportPath.map(part => `${part.kind}:${part.name}`),
        ownerPath: descriptor.declarationOwner.path,
        memberName: descriptor.member.kind === "constructor" ? "constructor" : descriptor.member.name,
        parameterTypes: descriptor.signature.parameters.map(parameter => parameter.type.text),
        returnType: descriptor.signature.returnType.text,
    });
}
