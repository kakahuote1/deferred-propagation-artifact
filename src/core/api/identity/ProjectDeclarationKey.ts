export interface ProjectDeclarationKey {
    file: string;
    exportPath: string[];
    ownerPath: string[];
    memberName: string;
    parameterTypes: string[];
    returnType: string;
}

export function projectDeclarationKeyString(key: ProjectDeclarationKey): string {
    return JSON.stringify({
        file: normalizeProjectDeclarationFile(key.file),
        exportPath: key.exportPath,
        ownerPath: key.ownerPath,
        memberName: key.memberName,
        parameterTypes: key.parameterTypes,
        returnType: key.returnType,
    });
}

function normalizeProjectDeclarationFile(value: string): string {
    const normalized = String(value || "")
        .replace(/\\/g, "/")
        .replace(/^@/, "")
        .replace(/:\s*$/, "")
        .replace(/^\/+|\/+$/g, "");
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
