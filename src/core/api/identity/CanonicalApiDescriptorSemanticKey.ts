import type { CanonicalApiDescriptor, CanonicalParameter } from "./CanonicalApiDescriptor";

export interface CanonicalApiDescriptorSemanticGroup {
    semanticKey: string;
    representativeCanonicalApiId: string;
    canonicalApiIds: string[];
    descriptors: CanonicalApiDescriptor[];
    declarationFiles: string[];
    memberName: string;
    parameterTypes: string[];
    returnType: string;
}

export interface CanonicalApiDescriptorMirrorReplacement {
    from: string;
    to: string;
    semanticKey: string;
    declarationFiles: string[];
}

export function canonicalApiDescriptorSemanticKey(descriptor: CanonicalApiDescriptor): string {
    return JSON.stringify({
        authority: descriptor.authority,
        domain: descriptor.domain,
        moduleSpecifier: descriptor.moduleSpecifier,
        exportPath: descriptor.exportPath.map(part => ({ kind: part.kind, name: part.name })),
        declarationOwner: {
            kind: descriptor.declarationOwner.kind,
            path: descriptor.declarationOwner.path,
            normalizedName: descriptor.declarationOwner.normalizedName,
        },
        member: {
            kind: descriptor.member.kind,
            name: descriptor.member.name,
            static: descriptor.member.static === true,
        },
        invokeKind: descriptor.invoke.kind,
        parameters: descriptor.signature.parameters
            .slice()
            .sort((left, right) => left.index - right.index)
            .map(parameterSemanticPart),
        returnType: descriptor.signature.returnType.text,
    });
}

export function canonicalApiDescriptorMirrorGroupKey(descriptor: CanonicalApiDescriptor): string {
    return canonicalApiDescriptorSemanticKey(descriptor);
}

export function groupMirrorEquivalentDescriptors(
    descriptors: readonly CanonicalApiDescriptor[],
): CanonicalApiDescriptorSemanticGroup[] {
    const groups = new Map<string, CanonicalApiDescriptor[]>();
    for (const descriptor of descriptors) {
        const key = canonicalApiDescriptorMirrorGroupKey(descriptor);
        const current = groups.get(key) || [];
        current.push(descriptor);
        groups.set(key, current);
    }
    return [...groups.entries()]
        .map(([semanticKey, groupDescriptors]) => buildSemanticGroup(semanticKey, groupDescriptors))
        .sort((left, right) => left.semanticKey.localeCompare(right.semanticKey));
}

export function mirrorReplacementMapForDescriptors(
    descriptors: readonly CanonicalApiDescriptor[],
): Map<string, string> {
    const replacements = new Map<string, string>();
    for (const group of groupMirrorEquivalentDescriptors(descriptors)) {
        for (const canonicalApiId of group.canonicalApiIds) {
            if (canonicalApiId !== group.representativeCanonicalApiId) {
                replacements.set(canonicalApiId, group.representativeCanonicalApiId);
            }
        }
    }
    return replacements;
}

export function listMirrorReplacements(
    descriptors: readonly CanonicalApiDescriptor[],
): CanonicalApiDescriptorMirrorReplacement[] {
    const replacements: CanonicalApiDescriptorMirrorReplacement[] = [];
    for (const group of groupMirrorEquivalentDescriptors(descriptors)) {
        for (const canonicalApiId of group.canonicalApiIds) {
            if (canonicalApiId === group.representativeCanonicalApiId) continue;
            replacements.push({
                from: canonicalApiId,
                to: group.representativeCanonicalApiId,
                semanticKey: group.semanticKey,
                declarationFiles: group.declarationFiles,
            });
        }
    }
    return replacements.sort((left, right) => left.from.localeCompare(right.from));
}

function buildSemanticGroup(
    semanticKey: string,
    descriptors: CanonicalApiDescriptor[],
): CanonicalApiDescriptorSemanticGroup {
    const sortedDescriptors = descriptors
        .slice()
        .sort(compareDescriptorForRepresentative);
    const representative = sortedDescriptors[0];
    const canonicalApiIds = uniqueSorted(descriptors.map(descriptor => descriptor.canonicalApiId));
    return {
        semanticKey,
        representativeCanonicalApiId: representative.canonicalApiId,
        canonicalApiIds,
        descriptors: sortedDescriptors.map(descriptor => ({ ...descriptor })),
        declarationFiles: uniqueSorted(descriptors.map(descriptor => descriptor.logicalDeclarationFile)),
        memberName: representative.member.name,
        parameterTypes: representative.signature.parameters
            .slice()
            .sort((left, right) => left.index - right.index)
            .map(parameter => parameter.type.text),
        returnType: representative.signature.returnType.text,
    };
}

function compareDescriptorForRepresentative(left: CanonicalApiDescriptor, right: CanonicalApiDescriptor): number {
    return declarationFilePriority(left.logicalDeclarationFile) - declarationFilePriority(right.logicalDeclarationFile)
        || left.logicalDeclarationFile.localeCompare(right.logicalDeclarationFile)
        || left.canonicalApiId.localeCompare(right.canonicalApiId);
}

function declarationFilePriority(file: string): number {
    const normalized = String(file || "").replace(/\\/g, "/");
    if (normalized.endsWith(".d.ets")) return 0;
    if (normalized.endsWith(".d.ts")) return 1;
    return 2;
}

function parameterSemanticPart(parameter: CanonicalParameter): Record<string, unknown> {
    return {
        index: parameter.index,
        optional: parameter.optional === true,
        rest: parameter.rest === true,
        type: parameter.type.text,
    };
}

function uniqueSorted(values: readonly string[]): string[] {
    return [...new Set(values.filter(value => String(value || "").length > 0))]
        .sort((left, right) => left.localeCompare(right));
}
