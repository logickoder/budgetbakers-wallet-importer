export type Logger = (message: string, details?: unknown) => void;

export function createLogger(enabled: boolean): Logger {
    return (message: string, details?: unknown): void => {
        if (!enabled) return;

        const timestamp = new Date().toISOString();
        if (details === undefined) {
            console.log(`[budgetbakers-importer ${timestamp}] ${message}`);
            return;
        }

        try {
            console.log(`[budgetbakers-importer ${timestamp}] ${message} ${JSON.stringify(details)}`);
        } catch {
            console.log(`[budgetbakers-importer ${timestamp}] ${message}`);
        }
    };
}