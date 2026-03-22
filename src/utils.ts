function extractTokenLike(value: unknown, keys: string[]): string | null {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return null;

    const obj = value as Record<string, unknown>;
    for (const key of keys) {
        if (typeof obj[key] === "string") return obj[key] as string;
    }
    return null;
}

export function requireTokenString(value: unknown, field: string): string {
    const token = extractTokenLike(value, [
        field,
        "token",
        "authToken",
        "csrfToken",
        "ssoKey",
        "ssoToken",
        "value",
    ]);
    if (!token) {
        throw new Error(`Expected a string token for ${field}, got: ${JSON.stringify(value)}`);
    }
    return token;
}