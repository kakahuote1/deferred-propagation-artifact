import * as fs from "fs";

export function loadArkMainCoreCapabilityPayload(
    catalogPath: string,
    capability: string,
): Record<string, unknown> {
    const catalog = loadStrictArkMainCatalog(catalogPath, capability);
    const { id: _id, kind: _kind, status: _status, description: _description, provenance: _provenance, ...payload } = catalog;
    return payload;
}

function loadStrictArkMainCatalog(catalogPath: string, capability: string): Record<string, unknown> {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
    const catalog = expectRecord(parsed, catalogPath);
    rejectOldAssetDocumentFields(catalog, catalogPath);
    const kind = expectString(catalog.kind, `${catalogPath}.kind`);
    if (kind !== capability) {
        throw new Error(`${catalogPath} kind must be ${capability}, got ${kind}`);
    }
    const status = expectString(catalog.status, `${catalogPath}.status`);
    if (status !== "official") {
        throw new Error(`${catalogPath} status must be official, got ${status}`);
    }
    const provenance = expectRecord(catalog.provenance, `${catalogPath}.provenance`);
    const source = expectString(provenance.source, `${catalogPath}.provenance.source`);
    if (source !== "builtin") {
        throw new Error(`${catalogPath} provenance.source must be builtin, got ${source}`);
    }
    return catalog;
}

function rejectOldAssetDocumentFields(catalog: Record<string, unknown>, catalogPath: string): void {
    const oldFields = ["plane", "surfaces", "bindings", "effectTemplates", "canonicalApiId", "surfaceId"];
    const present = oldFields.filter(field => Object.prototype.hasOwnProperty.call(catalog, field));
    if (present.length > 0) {
        throw new Error(`${catalogPath} is an internal arkmain catalog and must not contain old asset fields: ${present.join(", ")}`);
    }
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
