import * as fs from "fs";
import * as path from "path";
import { loadArkMainCoreCapabilityPayload } from "../ArkMainAssetCatalog";
import { ArkMainFactKind, ArkMainPhaseName } from "../ArkMainTypes";

export interface ArkMainLifecycleContractMatch {
    phase: ArkMainPhaseName;
    kind: Extract<ArkMainFactKind, "ability_lifecycle" | "stage_lifecycle" | "extension_lifecycle" | "page_build" | "page_lifecycle">;
    entryFamily: "ability_lifecycle" | "stage_lifecycle" | "extension_lifecycle" | "page_build" | "page_lifecycle";
    entryShape: "override_slot" | "declaration_owner_slot";
    reason: string;
}

interface ArkMainOverrideLifecycleCatalogEntry {
    ownerKind: "ability" | "stage" | "extension";
    kind: Extract<ArkMainFactKind, "ability_lifecycle" | "stage_lifecycle" | "extension_lifecycle">;
    entryFamily: ArkMainLifecycleContractMatch["entryFamily"];
    entryShape: Extract<ArkMainLifecycleContractMatch["entryShape"], "override_slot">;
    reasonPrefix: string;
    phaseEntries: Record<ArkMainPhaseName, ArkMainLifecycleMatchRef[]>;
}

interface ArkMainDeclarationLifecycleCatalogEntry {
    ownerKind: "component";
    phase: ArkMainPhaseName;
    kind: Extract<ArkMainFactKind, "page_build" | "page_lifecycle">;
    entryFamily: Extract<ArkMainLifecycleContractMatch["entryFamily"], "page_build" | "page_lifecycle">;
    entryShape: Extract<ArkMainLifecycleContractMatch["entryShape"], "declaration_owner_slot">;
    reasonPrefix: string;
    entries: ArkMainLifecycleMatchRef[];
}

interface ArkMainLifecycleMatchRef {
    match: {
        kind: "method";
        exact: string;
    };
}

interface ArkMainLifecycleCatalogDocument {
    overrideEntryContracts: ArkMainOverrideLifecycleCatalogEntry[];
    declarationEntryContracts: ArkMainDeclarationLifecycleCatalogEntry[];
}

interface ArkMainDeclarationLifecycleRule {
    phase: ArkMainPhaseName;
    kind: ArkMainLifecycleContractMatch["kind"];
    entryFamily: ArkMainLifecycleContractMatch["entryFamily"];
    entryShape: ArkMainLifecycleContractMatch["entryShape"];
    reasonPrefix: string;
    exactNames: ReadonlySet<string>;
}

const PHASES: ArkMainPhaseName[] = [
    "bootstrap",
    "composition",
    "interaction",
    "reactive_handoff",
    "teardown",
];

let cachedCatalog: ArkMainLifecycleCatalogDocument | undefined;

export function resolveAbilityLifecycleContractFromOverride(methodName: string): ArkMainLifecycleContractMatch | null {
    return resolveOverrideLifecycleContract("ability", methodName);
}

export function resolveAbilityLifecycleContract(methodName: string): ArkMainLifecycleContractMatch | null {
    return resolveOverrideLifecycleContract("ability", methodName);
}

export function resolveStageLifecycleContractFromOverride(methodName: string): ArkMainLifecycleContractMatch | null {
    return resolveOverrideLifecycleContract("stage", methodName);
}

export function resolveStageLifecycleContract(methodName: string): ArkMainLifecycleContractMatch | null {
    return resolveOverrideLifecycleContract("stage", methodName);
}

export function resolveExtensionLifecycleContractFromOverride(methodName: string): ArkMainLifecycleContractMatch | null {
    return resolveOverrideLifecycleContract("extension", methodName);
}

export function resolveExtensionLifecycleContract(methodName: string): ArkMainLifecycleContractMatch | null {
    return resolveOverrideLifecycleContract("extension", methodName);
}

export function resolveComponentLifecycleContract(methodName: string): ArkMainLifecycleContractMatch | null {
    return resolveContractByExactName(
        getLifecycleCatalog().declarationEntryContracts.map(entry => ({
            phase: entry.phase,
            kind: entry.kind,
            entryFamily: entry.entryFamily,
            entryShape: entry.entryShape,
            reasonPrefix: entry.reasonPrefix,
            exactNames: new Set(entry.entries.map(ref => ref.match.exact)),
        })),
        methodName,
    );
}

function resolveOverrideLifecycleContract(
    owner: ArkMainOverrideLifecycleCatalogEntry["ownerKind"],
    methodName: string,
): ArkMainLifecycleContractMatch | null {
    const entry = getLifecycleCatalog().overrideEntryContracts.find(item => item.ownerKind === owner);
    if (!entry) {
        throw new Error(`missing arkmain lifecycle override contract catalog for owner=${owner}`);
    }
    const phase = resolveOverridePhase(entry, methodName);
    if (!phase) {
        return null;
    }
    return {
        phase,
        kind: entry.kind,
        entryFamily: entry.entryFamily,
        entryShape: entry.entryShape,
        reason: `${entry.reasonPrefix} ${methodName}`,
    };
}

function resolveOverridePhase(
    entry: ArkMainOverrideLifecycleCatalogEntry,
    methodName: string,
): ArkMainPhaseName | null {
    for (const phase of PHASES) {
        if (entry.phaseEntries[phase]?.some(ref => ref.match.exact === methodName)) {
            return phase;
        }
    }
    return null;
}

function resolveContractByExactName(
    rules: readonly ArkMainDeclarationLifecycleRule[],
    methodName: string,
): ArkMainLifecycleContractMatch | null {
    for (const rule of rules) {
        if (!rule.exactNames.has(methodName)) continue;
        return {
            phase: rule.phase,
            kind: rule.kind,
            entryFamily: rule.entryFamily,
            entryShape: rule.entryShape,
            reason: `${rule.reasonPrefix} ${methodName}`,
        };
    }
    return null;
}

function getLifecycleCatalog(): ArkMainLifecycleCatalogDocument {
    if (cachedCatalog) {
        return cachedCatalog;
    }
    const catalogPath = resolveLifecycleCatalogPath();
    if (!fs.existsSync(catalogPath) || !fs.statSync(catalogPath).isFile()) {
        throw new Error(`arkmain lifecycle contract catalog not found: ${catalogPath}`);
    }
    cachedCatalog = validateLifecycleCatalog(
        loadArkMainCoreCapabilityPayload(catalogPath, "arkmain.lifecycle-contracts"),
        catalogPath,
    );
    return cachedCatalog;
}

function resolveLifecycleCatalogPath(): string {
    const candidates = [
        path.resolve(__dirname, "../../../../../src/models/kernel/arkmain", "harmony", "lifecycle.contracts.json"),
        path.resolve(process.cwd(), "src", "models", "kernel", "arkmain", "harmony", "lifecycle.contracts.json"),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return candidates[0];
}

function validateLifecycleCatalog(value: unknown, catalogPath: string): ArkMainLifecycleCatalogDocument {
    const doc = expectRecord(value, catalogPath);
    if (!Array.isArray(doc.overrideEntryContracts)) {
        throw new Error(`${catalogPath}.overrideEntryContracts must be an array`);
    }
    if (!Array.isArray(doc.declarationEntryContracts)) {
        throw new Error(`${catalogPath}.declarationEntryContracts must be an array`);
    }
    return {
        overrideEntryContracts: doc.overrideEntryContracts.map((item: unknown, index: number) =>
            validateOverrideContract(item, `${catalogPath}.overrideEntryContracts[${index}]`),
        ),
        declarationEntryContracts: doc.declarationEntryContracts.map((item: unknown, index: number) =>
            validateDeclarationContract(item, `${catalogPath}.declarationEntryContracts[${index}]`),
        ),
    };
}

function validateOverrideContract(value: unknown, pathText: string): ArkMainOverrideLifecycleCatalogEntry {
    const entry = expectRecord(value, pathText);
    const ownerKind = expectEnum(entry.ownerKind, `${pathText}.ownerKind`, ["ability", "stage", "extension"]);
    const kind = expectEnum(entry.kind, `${pathText}.kind`, [
        "ability_lifecycle",
        "stage_lifecycle",
        "extension_lifecycle",
    ]) as ArkMainOverrideLifecycleCatalogEntry["kind"];
    const entryFamily = expectEnum(entry.entryFamily, `${pathText}.entryFamily`, [
        "ability_lifecycle",
        "stage_lifecycle",
        "extension_lifecycle",
    ]) as ArkMainOverrideLifecycleCatalogEntry["entryFamily"];
    const entryShape = expectEnum(
        entry.entryShape,
        `${pathText}.entryShape`,
        ["override_slot"],
    ) as ArkMainOverrideLifecycleCatalogEntry["entryShape"];
    const reasonPrefix = expectString(entry.reasonPrefix, `${pathText}.reasonPrefix`);
    const phases = expectRecord(entry.phaseEntries, `${pathText}.phaseEntries`);
    const normalizedPhases = {} as Record<ArkMainPhaseName, ArkMainLifecycleMatchRef[]>;
    for (const phase of PHASES) {
        const valueAtPhase = phases[phase];
        if (!Array.isArray(valueAtPhase)) {
            throw new Error(`${pathText}.phaseEntries.${phase} must be an array`);
        }
        normalizedPhases[phase] = expectLifecycleMatchRefArray(valueAtPhase, `${pathText}.phaseEntries.${phase}`);
    }
    return {
        ownerKind: ownerKind as ArkMainOverrideLifecycleCatalogEntry["ownerKind"],
        kind,
        entryFamily,
        entryShape,
        reasonPrefix,
        phaseEntries: normalizedPhases,
    };
}

function validateDeclarationContract(value: unknown, pathText: string): ArkMainDeclarationLifecycleCatalogEntry {
    const entry = expectRecord(value, pathText);
    const ownerKind = expectEnum(entry.ownerKind, `${pathText}.ownerKind`, ["component"]);
    const phase = expectEnum(entry.phase, `${pathText}.phase`, PHASES) as ArkMainPhaseName;
    const kind = expectEnum(
        entry.kind,
        `${pathText}.kind`,
        ["page_build", "page_lifecycle"],
    ) as ArkMainDeclarationLifecycleCatalogEntry["kind"];
    const entryFamily = expectEnum(
        entry.entryFamily,
        `${pathText}.entryFamily`,
        ["page_build", "page_lifecycle"],
    ) as ArkMainDeclarationLifecycleCatalogEntry["entryFamily"];
    const entryShape = expectEnum(
        entry.entryShape,
        `${pathText}.entryShape`,
        ["declaration_owner_slot"],
    ) as ArkMainDeclarationLifecycleCatalogEntry["entryShape"];
    const reasonPrefix = expectString(entry.reasonPrefix, `${pathText}.reasonPrefix`);
    return {
        ownerKind: ownerKind as "component",
        phase,
        kind,
        entryFamily,
        entryShape,
        reasonPrefix,
        entries: expectLifecycleMatchRefArray(entry.entries, `${pathText}.entries`),
    };
}

function expectRecord(value: unknown, pathText: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${pathText} must be an object`);
    }
    return value as Record<string, unknown>;
}

function expectString(value: unknown, pathText: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${pathText} must be a non-empty string`);
    }
    return value.trim();
}

function expectEnum<T extends string>(value: unknown, pathText: string, allowed: readonly T[]): T {
    const text = expectString(value, pathText);
    if (!allowed.includes(text as T)) {
        throw new Error(`${pathText} invalid: ${text}`);
    }
    return text as T;
}

function expectLifecycleMatchRefArray(value: unknown, pathText: string): ArkMainLifecycleMatchRef[] {
    if (!Array.isArray(value)) {
        throw new Error(`${pathText} must be an array`);
    }
    return value.map((item, index) => {
        const ref = expectRecord(item, `${pathText}[${index}]`);
        const match = expectRecord(ref.match, `${pathText}[${index}].match`);
        const kind = expectEnum(match.kind, `${pathText}[${index}].match.kind`, ["method"]);
        return {
            match: {
                kind,
                exact: expectString(match.exact, `${pathText}[${index}].match.exact`),
            },
        };
    });
}
