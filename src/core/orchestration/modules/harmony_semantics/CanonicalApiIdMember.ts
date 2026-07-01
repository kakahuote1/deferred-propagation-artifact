import { assertValidCanonicalApiId, parseCanonicalApiId } from "../../../api/identity";

export function memberNameFromCanonicalApiId(canonicalApiId: string): string {
    assertValidCanonicalApiId(canonicalApiId);
    const parts = parseCanonicalApiId(canonicalApiId);
    if (!parts) {
        throw new Error(`invalid canonicalApiId: ${canonicalApiId}`);
    }
    const member = String(parts.member || "").trim();
    const colonParts = member.split(":").filter(Boolean);
    const rawName = colonParts[colonParts.length - 1] || "";
    const dotParts = rawName.split(".").filter(Boolean);
    const name = dotParts[dotParts.length - 1] || rawName;
    if (!name) {
        throw new Error(`canonicalApiId member has no concrete name: ${canonicalApiId}`);
    }
    return name;
}

export function decoratorNamesFromCanonicalApiIds(canonicalApiIds: readonly string[] | undefined): string[] {
    const out = new Set<string>();
    for (const canonicalApiId of canonicalApiIds || []) {
        assertValidCanonicalApiId(canonicalApiId);
        const parts = parseCanonicalApiId(canonicalApiId);
        if (!parts || !parts.member.startsWith("decorator:") || parts.invoke !== "decorator") {
            throw new Error(`canonicalApiId is not a decorator identity: ${canonicalApiId}`);
        }
        out.add(memberNameFromCanonicalApiId(canonicalApiId));
    }
    return [...out.values()].sort((left, right) => left.localeCompare(right));
}
