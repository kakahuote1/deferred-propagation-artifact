import type { ArkanalyzerMethodKey, IdentityEvidence } from "../identity";
import type { ImportMemberKey } from "../identity/ImportMemberKey";
import type { ArkUiChainKey } from "../identity/ArkUiChainKey";
import type { ProjectDeclarationKey } from "../identity/ProjectDeclarationKey";

export type RawApiOccurrenceKind =
    | "invoke"
    | "construct"
    | "property-access"
    | "callback-registration"
    | "component-chain"
    | "decorator"
    | "entry-slot"
    | "module-operation";

export interface RawApiOccurrence {
    rawOccurrenceId: string;
    kind: RawApiOccurrenceKind;
    sourceLocation: {
        file: string;
        line?: number;
        column?: number;
    };
    enclosingMethodSignature?: string;
    statementText?: string;
    ir: {
        invokeExprKind?: "ArkInstanceInvokeExpr" | "ArkStaticInvokeExpr" | "ArkPtrInvokeExpr";
        methodSignatureText?: string;
        arkanalyzerMethodKey?: ArkanalyzerMethodKey;
        unknownSignature: boolean;
        receiverText?: string;
        memberName?: string;
        argCount?: number;
        argTypes?: string[];
        resultText?: string;
        propertyAccessKind?: "read" | "write";
    };
    importEvidence?: ImportMemberKey;
    arkuiEvidence?: ArkUiChainKey;
    projectEvidence?: ProjectDeclarationKey;
    officialEvidence?: Array<{
        kind: "arkui-component";
        componentName: string;
    } | {
        kind: "decorator";
        decoratorName: string;
        ownerKind: "namespace" | "class" | "method" | "field";
        ownerName: string;
        content?: string;
        param?: string;
    }>;
}

export interface ResolvedApiOccurrence {
    occurrenceId: string;
    rawOccurrenceId: string;
    status: "accepted" | "unresolved" | "ambiguous" | "rejected";
    canonicalApiId?: string;
    resolutionKind?:
        | "arkanalyzer-signature"
        | "import-member"
        | "arkui-chain"
        | "callback-registration"
        | "decorator-entry"
        | "project-declaration";
    reason: string;
    candidates?: string[];
    evidence: IdentityEvidence[];
}

export interface OccurrenceResolutionLedger {
    rawOccurrences: RawApiOccurrence[];
    resolvedOccurrences: ResolvedApiOccurrence[];
}

export function acceptedOccurrence(input: {
    raw: RawApiOccurrence;
    occurrenceId?: string;
    canonicalApiId: string;
    resolutionKind: ResolvedApiOccurrence["resolutionKind"];
    reason: string;
    evidence: IdentityEvidence[];
}): ResolvedApiOccurrence {
    return {
        occurrenceId: input.occurrenceId || defaultOccurrenceId(input.raw),
        rawOccurrenceId: input.raw.rawOccurrenceId,
        status: "accepted",
        canonicalApiId: input.canonicalApiId,
        resolutionKind: input.resolutionKind,
        reason: input.reason,
        evidence: input.evidence,
    };
}

export function failedOccurrence(input: {
    raw: RawApiOccurrence;
    status: Exclude<ResolvedApiOccurrence["status"], "accepted">;
    reason: string;
    candidates?: string[];
    evidence?: IdentityEvidence[];
}): ResolvedApiOccurrence {
    return {
        occurrenceId: defaultOccurrenceId(input.raw),
        rawOccurrenceId: input.raw.rawOccurrenceId,
        status: input.status,
        reason: input.reason,
        candidates: input.candidates,
        evidence: input.evidence || [],
    };
}

function defaultOccurrenceId(raw: RawApiOccurrence): string {
    const loc = raw.sourceLocation;
    return [
        "occurrence",
        loc.file.replace(/\\/g, "/"),
        loc.line === undefined ? "line_unknown" : `line_${loc.line}`,
        loc.column === undefined ? "col_unknown" : `col_${loc.column}`,
        raw.kind,
        raw.rawOccurrenceId,
    ].join(":");
}
