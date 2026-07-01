import type { CanonicalApiDescriptor } from "./CanonicalApiDescriptor";
import { createCanonicalApiRegistry, type CanonicalApiRegistry } from "./CanonicalApiRegistry";
import { createOfficialCanonicalApiRegistry } from "./OfficialCanonicalApiRegistry";

export function createDefaultCanonicalApiRegistry(): CanonicalApiRegistry {
    return createOfficialCanonicalApiRegistry();
}

export function mergeCanonicalApiRegistries(registries: readonly CanonicalApiRegistry[]): CanonicalApiRegistry {
    const descriptors = new Map<string, CanonicalApiDescriptor>();
    for (const registry of registries) {
        for (const descriptor of registry.listDescriptors()) {
            const existing = descriptors.get(descriptor.canonicalApiId);
            if (existing && JSON.stringify(existing) !== JSON.stringify(descriptor)) {
                throw new Error(`canonical API registry descriptor conflict: ${descriptor.canonicalApiId}`);
            }
            descriptors.set(descriptor.canonicalApiId, descriptor);
        }
    }
    return createCanonicalApiRegistry([...descriptors.values()]);
}
