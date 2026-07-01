import * as fs from "fs";
import * as path from "path";
import type { CanonicalApiDescriptor } from "./CanonicalApiDescriptor";
import { createCanonicalApiRegistry, type CanonicalApiRegistry } from "./CanonicalApiRegistry";
import { canonicalApiDescriptorFromIdSeed, type CanonicalApiDescriptorSeed } from "./CanonicalApiDescriptorFromId";
import { assertValidCanonicalApiId } from "./CanonicalApiId";
import { groupMirrorEquivalentDescriptors } from "./CanonicalApiDescriptorSemanticKey";
import { loadOfficialKernelModuleCanonicalApiDescriptorSeeds } from "./OfficialKernelModuleCanonicalApiRegistry";

const KERNEL_RULE_ASSET_DIRS = [
    "src/models/kernel/rules/sources",
    "src/models/kernel/rules/sinks",
    "src/models/kernel/rules/transfers",
    "src/models/kernel/rules/sanitizers",
];

const KERNEL_ARKMAIN_OFFICIAL_ASSET_FILES = [
    path.join("src", "models", "kernel", "arkmain", "harmony", "official_declarations.catalog.json"),
];

let descriptorCache: CanonicalApiDescriptor[] | undefined;

export function loadOfficialCanonicalApiDescriptors(): CanonicalApiDescriptor[] {
    if (!descriptorCache) {
        const seeds = loadOfficialCanonicalApiDescriptorSeeds();
        descriptorCache = seeds.map(seed => canonicalApiDescriptorFromIdSeed(seed));
        assertNoMirrorDuplicateCanonicalApiDescriptors(descriptorCache);
    }
    return descriptorCache.map(descriptor => ({ ...descriptor }));
}

export function createOfficialCanonicalApiRegistry(): CanonicalApiRegistry {
    return createCanonicalApiRegistry(loadOfficialCanonicalApiDescriptors());
}

function loadOfficialCanonicalApiDescriptorSeeds(): CanonicalApiDescriptorSeed[] {
    const canonicalApiIds = new Set<string>();
    for (const ruleDir of KERNEL_RULE_ASSET_DIRS) {
        for (const assetPath of listJsonFiles(resolveRepoPath(ruleDir))) {
            collectCanonicalApiIdsFromAssetFile(assetPath, canonicalApiIds);
        }
    }
    for (const assetPath of KERNEL_ARKMAIN_OFFICIAL_ASSET_FILES.map(resolveRepoPath)) {
        collectCanonicalApiIdsFromAssetFile(assetPath, canonicalApiIds);
    }
    for (const seed of loadOfficialKernelModuleCanonicalApiDescriptorSeeds()) {
        addCanonicalApiId(canonicalApiIds, seed.canonicalApiId, "kernel module registry");
    }
    return [...canonicalApiIds]
        .sort((left, right) => left.localeCompare(right))
        .map(canonicalApiId => ({ canonicalApiId }));
}

function collectCanonicalApiIdsFromAssetFile(assetPath: string, output: Set<string>): void {
    const asset = JSON.parse(fs.readFileSync(assetPath, "utf-8"));
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
        throw new Error(`${assetPath} must contain an asset object`);
    }
    const surfaces = Array.isArray((asset as any).surfaces) ? (asset as any).surfaces : [];
    for (const [index, surface] of surfaces.entries()) {
        addCanonicalApiId(output, surface?.canonicalApiId, `${assetPath}.surfaces[${index}]`);
    }
}

function addCanonicalApiId(output: Set<string>, canonicalApiId: unknown, where: string): void {
    if (typeof canonicalApiId !== "string" || canonicalApiId.trim().length === 0) {
        throw new Error(`${where} is missing canonicalApiId`);
    }
    assertValidCanonicalApiId(canonicalApiId);
    output.add(canonicalApiId.trim());
}

function listJsonFiles(dir: string): string[] {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`kernel asset directory not found: ${dir}`);
    }
    return fs.readdirSync(dir)
        .filter(name => name.endsWith(".json"))
        .map(name => path.join(dir, name))
        .sort((left, right) => left.localeCompare(right));
}

function resolveRepoPath(relativePath: string): string {
    return path.resolve(process.cwd(), relativePath);
}

function assertNoMirrorDuplicateCanonicalApiDescriptors(descriptors: readonly CanonicalApiDescriptor[]): void {
    const duplicateGroups = groupMirrorEquivalentDescriptors(descriptors)
        .filter(group => group.canonicalApiIds.length > 1);
    if (duplicateGroups.length === 0) return;
    const sample = duplicateGroups.slice(0, 5).map(group => ({
        representativeCanonicalApiId: group.representativeCanonicalApiId,
        canonicalApiIds: group.canonicalApiIds,
        declarationFiles: group.declarationFiles,
        member: group.memberName,
        parameterTypes: group.parameterTypes,
        returnType: group.returnType,
    }));
    throw new Error(`official canonical registry contains mirror duplicate API identities: ${JSON.stringify({
        duplicateGroupCount: duplicateGroups.length,
        sample,
    })}`);
}
