export interface ImportMemberKey {
    moduleSpecifier: string;
    importKind: "default" | "namespace" | "named" | "equals" | "reexport";
    importedName: string;
    localBindingId: string;
    localName: string;
    aliasChain: string[];
    memberChain: string[];
    invokeKind: "call" | "new" | "property-read" | "property-write";
    argShape: {
        arity: number;
        parameterTypes?: string[];
        returnType?: string;
        literalKinds?: Array<{ index: number; kind: string }>;
        objectKeys?: Array<{ index: number; keys: string[] }>;
        callbackPositions?: number[];
    };
    scopeEvidence: {
        sourceFile: string;
        enclosingMethodSignature: string;
        shadowed: boolean;
    };
}

export interface ImportMemberCandidateKey {
    moduleSpecifier: string;
    importKind: ImportMemberKey["importKind"];
    importedName: string;
    memberChain: string[];
    invokeKind: ImportMemberKey["invokeKind"];
    arity: number;
}

export interface KnownShapeConstraints {
    parameterTypes: Array<{ index: number; type: string }>;
    returnType?: string;
    literalKinds: Array<{ index: number; kind: string }>;
    objectKeys: Array<{ index: number; keys: string[] }>;
    callbackPositions: number[];
}

export function importMemberKeyString(key: ImportMemberKey): string {
    return JSON.stringify({
        moduleSpecifier: key.moduleSpecifier,
        importKind: key.importKind,
        importedName: key.importedName,
        memberChain: key.memberChain,
        invokeKind: key.invokeKind,
        arity: key.argShape.arity,
        parameterTypes: key.argShape.parameterTypes || [],
        returnType: key.argShape.returnType || "",
    });
}

export function importMemberCandidateKeyString(key: ImportMemberCandidateKey): string {
    return JSON.stringify({
        moduleSpecifier: key.moduleSpecifier,
        importKind: key.importKind,
        importedName: key.importedName,
        memberChain: key.memberChain,
        invokeKind: key.invokeKind,
        arity: key.arity,
    });
}

export function importMemberCandidateKeyFromImportMemberKey(key: ImportMemberKey): ImportMemberCandidateKey {
    return {
        moduleSpecifier: key.moduleSpecifier,
        importKind: key.importKind,
        importedName: key.importedName,
        memberChain: key.memberChain,
        invokeKind: key.invokeKind,
        arity: key.argShape.arity,
    };
}

export function knownShapeConstraintsFromImportMemberKey(key: ImportMemberKey): KnownShapeConstraints {
    return {
        parameterTypes: (key.argShape.parameterTypes || [])
            .map((type, index) => ({ index, type }))
            .filter(item => isKnownIdentityTypeText(item.type)),
        returnType: isKnownIdentityTypeText(key.argShape.returnType) ? key.argShape.returnType : undefined,
        literalKinds: (key.argShape.literalKinds || [])
            .filter(item => Number.isInteger(item.index) && typeof item.kind === "string" && item.kind.trim().length > 0)
            .map(item => ({ index: item.index, kind: item.kind.trim() })),
        objectKeys: (key.argShape.objectKeys || [])
            .filter(item => Number.isInteger(item.index) && Array.isArray(item.keys) && item.keys.length > 0)
            .map(item => ({
                index: item.index,
                keys: [...new Set(item.keys.map(keyText => String(keyText || "").trim()).filter(Boolean))].sort(),
            }))
            .filter(item => item.keys.length > 0),
        callbackPositions: [...new Set((key.argShape.callbackPositions || [])
            .filter(index => Number.isInteger(index) && index >= 0))]
            .sort((left, right) => left - right),
    };
}

export function isKnownIdentityTypeText(value: unknown): value is string {
    const text = String(value || "").trim();
    if (!text) return false;
    const lowered = text.toLowerCase();
    if (lowered === "unknown" || lowered === "%unk" || lowered === "@unk" || lowered === "@%unk/%unk") return false;
    if (lowered.includes("%unk") || lowered.includes("@unk")) return false;
    if (/^%ac/i.test(text)) return false;
    return true;
}
