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

class Logger {
    private static instance: Logger;
    private logLevel: LogLevel = LogLevel.INFO;
    private isProductionBuild: boolean;

    private constructor() {
        // Check if we're in development mode by looking at various environment indicators
        this.isProductionBuild = process.env.NODE_ENV === 'production';
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
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
        // In production, only log errors and warnings
        if (this.isProductionBuild && level > LogLevel.WARN) {
            return;
        }

        // Check if the log level is enabled
        if (level > this.logLevel) {
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
        const prefix = `[${LogLevel[logMessage.level]}] ${logMessage.timestamp.toISOString()}`;
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
export const { error, warn, info, debug } = logger; 