import { DateTime } from "luxon";

const DATE_INPUT_FORMATS = [
    "yyyy-MM-dd HH:mm:ss",
    "yyyy-MM-dd HH:mm",
    "yyyy-MM-dd'T'HH:mm:ss",
    "yyyy-MM-dd'T'HH:mm",
    "M/d/yy H:mm:ss.SSS",
    "M/d/yy H:mm:ss",
    "M/d/yy H:mm.SSS",
    "M/d/yy H:mm",
    "M/d/yyyy H:mm:ss.SSS",
    "M/d/yyyy H:mm:ss",
    "M/d/yyyy H:mm.SSS",
    "M/d/yyyy H:mm",
    "M/d/yy'T'H:mm:ss.SSS",
    "M/d/yy'T'H:mm:ss",
    "M/d/yy'T'H:mm.SSS",
    "M/d/yy'T'H:mm",
    "M/d/yyyy'T'H:mm:ss.SSS",
    "M/d/yyyy'T'H:mm:ss",
    "M/d/yyyy'T'H:mm.SSS",
    "M/d/yyyy'T'H:mm",
] as const;

function stripTrailingOffset(raw: string): string {
    return raw.trim().replace(/(?:Z|[+-]\d{2}:\d{2})$/i, "");
}

function parseAsLocalDateTime(raw: string): DateTime | null {
    const cleaned = stripTrailingOffset(raw);

    for (const fmt of DATE_INPUT_FORMATS) {
        const parsed = DateTime.fromFormat(cleaned, fmt, {
            zone: "local",
            setZone: false,
            locale: "en-US",
        });
        if (parsed.isValid) return parsed;
    }

    const isoParsed = DateTime.fromISO(cleaned, {
        zone: "local",
        setZone: false,
    });

    if (isoParsed.isValid) return isoParsed;
    return null;
}

export function toLocalIsoDateTime(raw: string): string {
    const parsed = parseAsLocalDateTime(raw);
    if (!parsed) {
        throw new Error(`Invalid date: "${raw}"`);
    }
    return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZ");
}
