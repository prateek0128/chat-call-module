export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

const consoleLogger: Logger = {
  info: () => undefined,
  warn: (m, ...a) => console.warn(`[commskit] ${m}`, ...a),
  error: (m, ...a) => console.error(`[commskit] ${m}`, ...a),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

let current: Logger = consoleLogger;

/** Replace the kit-wide logger (default: warnings and errors to the console). */
export function setLogger(logger: Logger): void {
  current = logger;
}

export const logger: Logger = {
  info: (m, ...a) => current.info(m, ...a),
  warn: (m, ...a) => current.warn(m, ...a),
  error: (m, ...a) => current.error(m, ...a),
};
