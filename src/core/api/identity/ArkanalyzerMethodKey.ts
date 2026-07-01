export type { ArkanalyzerMethodKey } from "./CanonicalApiDescriptor";

export function arkanalyzerMethodKeyString(key: import("./CanonicalApiDescriptor").ArkanalyzerMethodKey): string {
    return JSON.stringify({
        declaringFileName: normalizeArkanalyzerDeclaringFileName(key.declaringFileName),
        declaringNamespacePath: key.declaringNamespacePath || [],
        declaringClassName: key.declaringClassName,
        methodName: key.methodName,
        parameterTypes: key.parameterTypes || [],
        returnType: key.returnType,
        staticFlag: !!key.staticFlag,
    });
}

export function isKnownArkanalyzerMethodKey(key: import("./CanonicalApiDescriptor").ArkanalyzerMethodKey): boolean {
    const values = [
        key.declaringFileName,
        key.declaringClassName,
        key.methodName,
        key.returnType,
        ...(key.parameterTypes || []),
    ];
    return values.every(value => !String(value || "").includes("%unk"));
}

export function normalizeArkanalyzerDeclaringFileName(value: string): string {
    const normalized = String(value || "")
        .replace(/\\/g, "/")
        .replace(/^@/, "")
        .replace(/:\s*$/, "")
        .replace(/^\/+|\/+$/g, "")
        .trim();
    const sourceRoots = [
        "src/main/ets/",
        "src/ohostest/ets/",
        "src/test/ets/",
        "ets/",
    ];
    for (const root of sourceRoots) {
        const index = normalized.lastIndexOf(root);
        if (index >= 0) {
            return normalized.slice(index);
        }
    }
    return normalized;
}
