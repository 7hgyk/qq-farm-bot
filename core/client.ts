export {};
/**
 * 主程序 - 进程管理器
 * 负责启动 Web 面板，并管理多个 Bot 子进程
 */
const path = require('node:path');
const fs = require('node:fs');

// 全局异常兜底：崩溃前把原因同步写进 stdout，避免 Render 上"无日志秒死"。
// 用 fs.writeSync 而不是 console，保证进程退出前一定刷出去。
function fatalLog(label: string, detail: any): void {
    let text: string;
    try {
        text = detail instanceof Error
            ? JSON.stringify({ name: detail.name, message: detail.message, stack: detail.stack })
            : (typeof detail === 'string' ? detail : JSON.stringify(detail));
    } catch {
        text = String(detail);
    }
    const line = `[FATAL] ${label}: ${text}\n`;
    try {
        fs.writeSync(1, line);
    } catch {
        try { process.stderr.write(line); } catch { /* ignore */ }
    }
}

process.on('unhandledRejection', (reason: any) => {
    fatalLog('unhandledRejection', reason);
});

process.on('uncaughtException', (err: any) => {
    fatalLog('uncaughtException', err);
    process.exit(1);
});

process.on('SIGTERM', () => {
    let mem = '';
    try {
        const m = process.memoryUsage();
        mem = ` rss=${Math.round(m.rss / 1048576)}MB heapUsed=${Math.round(m.heapUsed / 1048576)}MB`;
    } catch { /* ignore */ }
    fatalLog('signal', `SIGTERM received, exiting (uptime=${Math.round(process.uptime())}s${mem})`);
    process.exit(0);
});

process.on('SIGINT', () => {
    let mem = '';
    try {
        const m = process.memoryUsage();
        mem = ` rss=${Math.round(m.rss / 1048576)}MB heapUsed=${Math.round(m.heapUsed / 1048576)}MB`;
    } catch { /* ignore */ }
    fatalLog('signal', `SIGINT received, exiting (uptime=${Math.round(process.uptime())}s${mem})`);
    process.exit(0);
});

// tsx/bun 直接跑 client.ts 时用 src，避免 stale dist 缺新路由。
// node client.js / 打包产物仍优先加载已编译的 dist。
const runningFromSource = /\.[cm]?tsx?$/.test(__filename);
const distDir = path.join(__dirname, 'dist');
const baseDir = !runningFromSource && fs.existsSync(distDir) ? './dist' : './src';

const {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
} = require(`${baseDir}/controllers/admin`);
const { createRuntimeEngine } = require(`${baseDir}/runtime/runtime-engine`);
const { createModuleLogger } = require(`${baseDir}/services/logger`);
const mainLogger = createModuleLogger('main');

// 打包后 worker 由当前可执行文件以 --worker 模式启动
const isWorkerProcess: boolean = process.env.FARM_WORKER === '1';
if (isWorkerProcess) {
    require(`${baseDir}/core/worker`);
} else {
    const runtimeEngine = createRuntimeEngine({
        processRef: process,
        mainEntryPath: __filename,
        startAdminServer,
        onStatusSync: (accountId: string, status: any) => {
            emitRealtimeStatus(accountId, status);
        },
        onLog: (entry: any, accountId?: string) => {
            // 确保日志条目包含 accountId
            if (accountId && entry) {
                entry.accountId = accountId;
            }
            emitRealtimeLog(entry);
        },
        onAccountLog: (entry: any) => {
            emitRealtimeAccountLog(entry);
        },
    });

    runtimeEngine.start({
        startAdminServer: true,
        autoStartAccounts: false,
    }).catch((err: any) => {
        mainLogger.error('runtime bootstrap failed', { error: err && err.message ? err.message : String(err) });
    });
}
