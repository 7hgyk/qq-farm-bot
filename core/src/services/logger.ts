export {};
// 精简日志：只输出到控制台（Render 会采集 stdout）。
// 不再写日志文件、不再依赖 winston —— 省内存、省磁盘 IO，也避免日志文件无限增长。
const DIAGNOSTIC_CODE_KEY_RE = /^(?:disconnect|close|error|http|status|exit|reason)Code$/i;
const SENSITIVE_KEY_RE = /code|token|password|passwd|auth|ticket|cookie|session/i;

const MAX_DEPTH = 4;
const MAX_STRING = 1000;
const MAX_ARRAY = 30;

function redactString(input: any): string {
    let text = String(input || '');
    text = text.replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]');
    text = text.replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
    if (text.length > MAX_STRING) text = `${text.slice(0, MAX_STRING)}...[Truncated]`;
    return text;
}

function sanitizeMeta(value: any, depth = 0): any {
    if (depth > MAX_DEPTH) return '[Truncated]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map(v => sanitizeMeta(v, depth + 1));

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
        if (DIAGNOSTIC_CODE_KEY_RE.test(k) && typeof v === 'number' && Number.isSafeInteger(v)) {
            out[k] = v;
        } else if (SENSITIVE_KEY_RE.test(String(k))) {
            out[k] = '[REDACTED]';
        } else {
            out[k] = sanitizeMeta(v, depth + 1);
        }
    }
    return out;
}

interface ModuleLogger {
    info: (message: string, meta?: any) => void;
    warn: (message: string, meta?: any) => void;
    error: (message: string, meta?: any) => void;
    debug: (message: string, meta?: any) => void;
}

const LEVEL_WEIGHT: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function createModuleLogger(moduleName = 'app'): ModuleLogger {
    const moduleTag = String(moduleName || 'app');
    const enabled = LEVEL_WEIGHT[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 2;

    const write = (level: string, message: string, meta?: any): void => {
        if ((LEVEL_WEIGHT[level] ?? 2) > enabled) return;
        const ts = new Date().toISOString();
        const safeMsg = redactString(message);
        const safeMeta = sanitizeMeta(meta || {});
        const hasMeta = safeMeta && typeof safeMeta === 'object' && Object.keys(safeMeta).length > 0;
        const line = `[${ts}] [${level}] [${moduleTag}] ${safeMsg}${hasMeta ? ` ${JSON.stringify(safeMeta)}` : ''}`;
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.log(line);
    };

    return {
        info: (message: string, meta?: any) => write('info', message, meta),
        warn: (message: string, meta?: any) => write('warn', message, meta),
        error: (message: string, meta?: any) => write('error', message, meta),
        debug: (message: string, meta?: any) => write('debug', message, meta),
    };
}

module.exports = {
    createModuleLogger,
    sanitizeMeta,
    redactString,
};
