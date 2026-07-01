import * as fs from "fs";
import * as path from "path";
import { loadArkMainCoreCapabilityPayload } from "../ArkMainAssetCatalog";

interface ArkMainCatalogMatchRef {
    match: {
        kind: "method" | "class" | "decorator";
        exact: string;
    };
}

interface ArkMainFrameworkCatalogDocument {
    reactiveAnchorEntries: ArkMainCatalogMatchRef[];
    abilityBaseEntries: ArkMainCatalogMatchRef[];
    abilityHandoffTargetEntries: ArkMainCatalogMatchRef[];
    pageEntries: ArkMainCatalogMatchRef[];
    routerOwnerEntries: ArkMainCatalogMatchRef[];
    navigationSourceOwnerEntries: ArkMainCatalogMatchRef[];
    routerSourceEntries: ArkMainCatalogMatchRef[];
    routerTriggerEntries: ArkMainCatalogMatchRef[];
    watchLikeDecoratorEntries: ArkMainCatalogMatchRef[];
    ownerDecoratorEntries: ArkMainCatalogMatchRef[];
    builderDecoratorEntry: ArkMainCatalogMatchRef;
    deferredContinuationEntries: ArkMainCatalogMatchRef[];
    frameworkCallbackEntries: ArkMainCatalogMatchRef[];
}

const catalog = loadFrameworkCatalog();

export const ARK_MAIN_REACTIVE_ANCHOR_EXACT_NAMES = exactNames(catalog.reactiveAnchorEntries, "method");
export const ARK_MAIN_ABILITY_BASE_EXACT_NAMES = new Set(exactNames(catalog.abilityBaseEntries, "class"));
export const ARK_MAIN_ABILITY_HANDOFF_TARGET_EXACT_NAMES = new Set(exactNames(catalog.abilityHandoffTargetEntries, "method"));
export const ARK_MAIN_PAGE_EXACT_NAMES = new Set(exactNames(catalog.pageEntries, "method"));
export const ARK_MAIN_ROUTER_OWNER_EXACT_NAMES = new Set(exactNames(catalog.routerOwnerEntries, "class"));
export const ARK_MAIN_NAVIGATION_SOURCE_OWNER_EXACT_NAMES = new Set(exactNames(catalog.navigationSourceOwnerEntries, "class"));
export const ARK_MAIN_ROUTER_SOURCE_EXACT_NAMES = new Set(exactNames(catalog.routerSourceEntries, "method"));
export const ARK_MAIN_ROUTER_TRIGGER_EXACT_NAMES = new Set(exactNames(catalog.routerTriggerEntries, "method"));
export const ARK_MAIN_WATCH_LIKE_DECORATOR_EXACT_NAMES = new Set(exactNames(catalog.watchLikeDecoratorEntries, "decorator"));
export const ARK_MAIN_OWNER_DECORATOR_EXACT_NAMES = new Set(exactNames(catalog.ownerDecoratorEntries, "decorator"));
export const ARK_MAIN_BUILDER_EXACT_NAME = exactName(catalog.builderDecoratorEntry, "decorator");
export const ARK_MAIN_DEFERRED_CONTINUATION_EXACT_NAMES = new Set(exactNames(catalog.deferredContinuationEntries, "method"));
export const ARK_MAIN_FRAMEWORK_CALLBACK_EXACT_NAMES = new Set(exactNames(catalog.frameworkCallbackEntries, "method"));

function loadFrameworkCatalog(): ArkMainFrameworkCatalogDocument {
    const catalogPath = resolveFrameworkCatalogPath();
    if (!fs.existsSync(catalogPath) || !fs.statSync(catalogPath).isFile()) {
        throw new Error(`arkmain framework catalog not found: ${catalogPath}`);
    }
    return validateFrameworkCatalog(
        loadArkMainCoreCapabilityPayload(catalogPath, "arkmain.framework-catalog"),
        catalogPath,
    );
}

function resolveFrameworkCatalogPath(): string {
    const candidates = [
        path.resolve(__dirname, "../../../../../src/models/kernel/arkmain", "harmony", "framework.catalog.json"),
        path.resolve(process.cwd(), "src", "models", "kernel", "arkmain", "harmony", "framework.catalog.json"),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return candidates[0];
}

function validateFrameworkCatalog(value: unknown, catalogPath: string): ArkMainFrameworkCatalogDocument {
    const doc = expectRecord(value, catalogPath);
    return {
        reactiveAnchorEntries: expectMatchRefArray(doc.reactiveAnchorEntries, `${catalogPath}.reactiveAnchorEntries`, "method"),
        abilityBaseEntries: expectMatchRefArray(doc.abilityBaseEntries, `${catalogPath}.abilityBaseEntries`, "class"),
        abilityHandoffTargetEntries: expectMatchRefArray(doc.abilityHandoffTargetEntries, `${catalogPath}.abilityHandoffTargetEntries`, "method"),
        pageEntries: expectMatchRefArray(doc.pageEntries, `${catalogPath}.pageEntries`, "method"),
        routerOwnerEntries: expectMatchRefArray(doc.routerOwnerEntries, `${catalogPath}.routerOwnerEntries`, "class"),
        navigationSourceOwnerEntries: expectMatchRefArray(doc.navigationSourceOwnerEntries, `${catalogPath}.navigationSourceOwnerEntries`, "class"),
        routerSourceEntries: expectMatchRefArray(doc.routerSourceEntries, `${catalogPath}.routerSourceEntries`, "method"),
        routerTriggerEntries: expectMatchRefArray(doc.routerTriggerEntries, `${catalogPath}.routerTriggerEntries`, "method"),
        watchLikeDecoratorEntries: expectMatchRefArray(doc.watchLikeDecoratorEntries, `${catalogPath}.watchLikeDecoratorEntries`, "decorator"),
        ownerDecoratorEntries: expectMatchRefArray(doc.ownerDecoratorEntries, `${catalogPath}.ownerDecoratorEntries`, "decorator"),
        builderDecoratorEntry: expectMatchRef(doc.builderDecoratorEntry, `${catalogPath}.builderDecoratorEntry`, "decorator"),
        deferredContinuationEntries: expectMatchRefArray(doc.deferredContinuationEntries, `${catalogPath}.deferredContinuationEntries`, "method"),
        frameworkCallbackEntries: expectMatchRefArray(doc.frameworkCallbackEntries, `${catalogPath}.frameworkCallbackEntries`, "method"),
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

function expectMatchRefArray(value: unknown, pathText: string, kind: ArkMainCatalogMatchRef["match"]["kind"]): ArkMainCatalogMatchRef[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${pathText} must be a non-empty match ref array`);
    }
    return value.map((item, index) => expectMatchRef(item, `${pathText}[${index}]`, kind));
}

function expectMatchRef(value: unknown, pathText: string, kind: ArkMainCatalogMatchRef["match"]["kind"]): ArkMainCatalogMatchRef {
    const ref = expectRecord(value, pathText);
    const match = expectRecord(ref.match, `${pathText}.match`);
    const matchKind = expectString(match.kind, `${pathText}.match.kind`);
    if (matchKind !== kind) {
        throw new Error(`${pathText}.match.kind must be ${kind}`);
    }
    return {
        match: {
            kind,
            exact: expectString(match.exact, `${pathText}.match.exact`),
        },
    };
}

function exactNames(refs: ArkMainCatalogMatchRef[], kind: ArkMainCatalogMatchRef["match"]["kind"]): string[] {
    return refs.map(ref => exactName(ref, kind));
}

function exactName(ref: ArkMainCatalogMatchRef, kind: ArkMainCatalogMatchRef["match"]["kind"]): string {
    if (ref.match.kind !== kind) {
        throw new Error(`arkmain catalog entry expected ${kind}, got ${ref.match.kind}`);
    }
    return ref.match.exact;
}
