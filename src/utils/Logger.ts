export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

export class Logger {
    private static _instance: Logger;
    private _logLevel: LogLevel = 'info'

    private readonly levels: Record<LogLevel, number>= {
        debug: 1, 
        info: 2,
        warn: 3,
        error: 4,
        none: 5
    }

    private readonly styles: Record<LogLevel, string> = {
        debug: 'color: #888888; background-color: #f5f5f5; padding: 2px 4px; border-radius: 3px;', 
        info: 'color: #1e40af; background-color: #eff6ff; padding: 2px 4px; border-radius: 3px;',  
        warn: 'color: #92400e; background-color: #fffbeb; padding: 2px 4px; border-radius: 3px;', 
        error: 'color: #991b1b; background-color: #fee2e2; padding: 2px 4px; border-radius: 3px;', 
        none: '', 
    }
    //Singletone    
    private constructor(){}

    public static getInstance(): Logger {
        if (!Logger._instance) {
            Logger._instance = new Logger();
        }
        return Logger._instance;
    }

    public setLevel (level:LogLevel):void{
        this._logLevel = level
    }

    private shouldLog(level: LogLevel): boolean {
        return this.levels[level] <= this.levels[this._logLevel]; 
    }

    
    public debug(message:string, ...args:any[]):void{
        if(this.shouldLog('debug')){
            const tag = '[Player:DEBUG]';
            console.debug(`%c${tag}`, this.styles.debug, message, ...args);
        }
    }

    public info(message:string, ...args:any[]):void{
        if(this.shouldLog('info')){
            const tag = '[Player:INFO]';
            console.info(`%c${tag}`, this.styles.info, message, ...args);
        }
    }

    public warn(message: string, ...args: any[]): void {
        if (this.shouldLog('warn')) {
            const tag = '[Player:WARN]';
            console.warn(`%c${tag}`, this.styles.warn, message, ...args);
        }
    }

    public error(message: string, ...args: any[]): void {
        if (this.shouldLog('error')) {
            const tag = '[Player:ERROR]';
            console.error(`%c${tag}`, this.styles.error, message, ...args);
        }
    }
}
export const playerLogger = Logger.getInstance();