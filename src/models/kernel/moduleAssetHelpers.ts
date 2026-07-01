import type {
    AssetBinding,
    AssetDocumentBase,
    AssetEndpoint,
    AssetSurface,
    CoreCapabilityTemplate,
    InvokeSurface,
} from "../../core/assets/schema";
import { parseCanonicalApiId } from "../../core/api/identity/CanonicalApiId";

interface BuiltinModuleAssetInput {
    id: string;
    description: string;
    semanticsFamily: string;
    surfaces: AssetSurface[];
    role: AssetBinding["role"];
    capability: CoreCapabilityTemplate["capability"];
    payload: Record<string, unknown>;
}

export function createBuiltinModuleAsset(input: BuiltinModuleAssetInput): AssetDocumentBase {
    const templateId = `template:${input.id}:capability`;
    return {
        id: input.id,
        plane: "module",
        status: "official",
        surfaces: input.surfaces,
        bindings: input.surfaces.map((surface, index) => ({
            bindingId: `binding:${input.id}:${String(index + 1).padStart(4, "0")}`,
            surfaceId: surface.surfaceId,
            canonicalApiId: surface.canonicalApiId,
            assetId: input.id,
            plane: "module",
            role: input.role,
            endpoint: endpointForSurface(surface),
            effectTemplateRefs: [templateId],
            semanticsFamily: input.semanticsFamily,
            metadata: {
                description: input.description,
            },
            completeness: "complete",
            confidence: "certain",
        })),
        effectTemplates: [
            {
                id: templateId,
                kind: "core.capability",
                capability: input.capability,
                payload: input.payload,
                confidence: "certain",
            },
        ],
        provenance: {
            source: "builtin",
        },
    };
}

export function canonicalInvokeSurfaceFromId(canonicalApiId: string): InvokeSurface {
    if (!canonicalApiId || !parseCanonicalApiId(canonicalApiId)) {
        throw new Error(`module invoke surface requires a valid canonicalApiId: ${canonicalApiId}`);
    }
    return {
        surfaceId: surfaceIdForCanonicalApiId(canonicalApiId),
        canonicalApiId,
        kind: "invoke",
        confidence: "certain",
        provenance: {
            source: "sdk",
        },
    };
}

export function canonicalDecoratorSurfaceFromId(canonicalApiId: string): AssetSurface {
    const parsed = parseCanonicalApiId(canonicalApiId);
    if (!canonicalApiId || !parsed || parsed.invoke !== "decorator" || !parsed.member.startsWith("decorator:")) {
        throw new Error(`module decorator surface requires a valid decorator canonicalApiId: ${canonicalApiId}`);
    }
    return {
        surfaceId: surfaceIdForCanonicalApiId(canonicalApiId),
        canonicalApiId,
        kind: "decorator",
        confidence: "certain",
        provenance: {
            source: "sdk",
        },
    };
}

function surfaceIdForCanonicalApiId(canonicalApiId: string): string {
    return `surface:${canonicalApiId}`;
}

function endpointForSurface(surface: AssetSurface): AssetEndpoint | undefined {
    if (surface.kind === "invoke") {
        return {
            base: { kind: "receiver" },
        };
    }
    if (surface.kind === "decorator") {
        const decoratorName = decoratorNameFromCanonicalApiId(surface.canonicalApiId);
        return {
            base: { kind: "receiver" },
            accessPath: [decoratorName],
        };
    }
    return undefined;
}

function decoratorNameFromCanonicalApiId(canonicalApiId: string | undefined): string {
    const parts = parseCanonicalApiId(String(canonicalApiId || ""));
    if (!parts || !parts.member.startsWith("decorator:")) {
        throw new Error(`decorator surface must declare a decorator canonicalApiId`);
    }
    const name = parts.member.slice("decorator:".length).trim();
    if (!name) {
        throw new Error(`decorator surface canonicalApiId must include decorator member name`);
    }
    return name;
}
