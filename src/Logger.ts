type ConsoleMethod = 'log' | 'warn' | 'error' | 'info' | 'debug';

// Flag to control the debug output
let debugEnabled = true;

// Function to enable or disable debug messages
export const setDebugEnabled = (enabled: boolean) => {
  debugEnabled = enabled;
};

// Function to wrap console methods with color and log level prefix
const wrapConsoleMethod = (method: ConsoleMethod, color: string) => {
  const originalMethod = console[method].bind(console);

  console[method] = (...args: unknown[]) => {
    // For debug method, respect the debugEnabled flag
    if (method === 'debug' && !debugEnabled) return;

    const now = new Date();
    const time = now.toTimeString().split(' ')[0];
    const prefix = `\x1b[${color}m[${method}:${time}]\x1b[0m`; // ANSI escape code for color

    // Call the original console method with colored prefix and log level
    originalMethod(prefix, ...args);
  };
};

// ANSI color codes for terminal
const COLORS = {
  white: '37',     // White
  yellow: '33',    // Yellow
  red: '31',       // Red
  green: '32',     // Green
  orange: '35'     // Magenta (approximate substitute for orange in terminals)
};

// Wrap standard methods with specific colors
wrapConsoleMethod('log', COLORS.white);
wrapConsoleMethod('warn', COLORS.yellow);
wrapConsoleMethod('error', COLORS.red);

// Wrap custom methods with specific colors
wrapConsoleMethod('info', COLORS.green);
wrapConsoleMethod('debug', COLORS.orange);
