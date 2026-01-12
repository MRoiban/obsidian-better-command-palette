export enum LogLevel {
    ERROR = 0,
    WARN = 1,
    INFO = 2,
    DEBUG = 3,
}

interface LogMessage {
    level: LogLevel;
    message: string;
    data?: any;
    timestamp: Date;
}

// Declare global debug flag for TypeScript
declare global {
    interface Window {
        BETTER_COMMAND_PALETTE_DEBUG?: boolean;
    }
}

class Logger {
    private static instance: Logger;

    private logLevel: LogLevel = LogLevel.WARN; // Only errors and warnings by default

    private constructor() {
        // Logging is disabled by default (only errors/warnings)
        // Users can enable debug logging in browser console with:
        // window.BETTER_COMMAND_PALETTE_DEBUG = true
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    /**
     * Check if debug mode is enabled via global window variable
     */
    private isDebugEnabled(): boolean {
        if (typeof window !== 'undefined' && window.BETTER_COMMAND_PALETTE_DEBUG === true) {
            return true;
        }
        return false;
    }

    public setLogLevel(level: LogLevel): void {
        this.logLevel = level;
    }

    public error(message: string, data?: any): void {
        this.log(LogLevel.ERROR, message, data);
    }

    public warn(message: string, data?: any): void {
        this.log(LogLevel.WARN, message, data);
    }

    public info(message: string, data?: any): void {
        this.log(LogLevel.INFO, message, data);
    }

    public debug(message: string, data?: any): void {
        this.log(LogLevel.DEBUG, message, data);
    }

    private log(level: LogLevel, message: string, data?: any): void {
        // For info/debug levels, check if debug mode is explicitly enabled
        if (level > LogLevel.WARN && !this.isDebugEnabled()) {
            return;
        }

        // Check if the log level is enabled
        if (level > this.logLevel && !this.isDebugEnabled()) {
            return;
        }

        const logMessage: LogMessage = {
            level,
            message,
            data,
            timestamp: new Date(),
        };

        this.output(logMessage);
    }

    private output(logMessage: LogMessage): void {
        const prefix = `[BCP:${LogLevel[logMessage.level]}]`;
        const fullMessage = `${prefix} ${logMessage.message}`;

        switch (logMessage.level) {
            case LogLevel.ERROR:
                if (logMessage.data) {
                    console.error(fullMessage, logMessage.data);
                } else {
                    console.error(fullMessage);
                }
                break;
            case LogLevel.WARN:
                if (logMessage.data) {
                    console.warn(fullMessage, logMessage.data);
                } else {
                    console.warn(fullMessage);
                }
                break;
            case LogLevel.INFO:
                if (logMessage.data) {
                    console.log(fullMessage, logMessage.data);
                } else {
                    console.log(fullMessage);
                }
                break;
            case LogLevel.DEBUG:
                if (logMessage.data) {
                    console.log(fullMessage, logMessage.data);
                } else {
                    console.log(fullMessage);
                }
                break;
        }
    }
}

// Export singleton instance
export const logger = Logger.getInstance();

// Convenience exports for cleaner usage
export const {
    error, warn, info, debug,
} = logger;

