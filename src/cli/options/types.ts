import type { LogLevelName } from "../../logger.js";

export interface RunOptions {
    debug: boolean;
    refreshCache: boolean;
    logLevel: LogLevelName;
    email: string | null;
    csvPath: string | null;
    yes: boolean;
    listLastRequested: boolean;
    rollbackLastRequested: boolean;
    listLastRecords: number;
    rollbackLastRecords: number;
    startTimestamp: string | null;
    endTimestamp: string | null;
}
