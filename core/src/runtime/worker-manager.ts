export {};
const { createScheduler } = require('../services/scheduler');

const DEFAULT_API_CALL_TIMEOUT_MS = 10000;
// 好友现场天气需要逐个 Enter/Leave，单批最多 5 位好友；
// 好友列表只读缓存或拉一次名单，给的余量少一些。
const API_CALL_TIMEOUTS_MS: Record<string, number> = {
    getPetDiary: 90000,
    operatePetDiary: 180000,
    getPetDiaryRecords: 30000,
    getPetDiaryFriend: 30000,
    scanWeatherFriends: 60000,
    getWeatherFriends: 30000,
};

interface WorkerManagerOptions {
    fork: any;
    WorkerThread: any;
    runtimeMode?: string;
    processRef: any;
    mainEntryPath: string;
    workerScriptPath: string;
    workers: Record<string, any>;
    globalLogs: any[];
    log: (tag: string, msg: string, extra?: any) => void;
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    normalizeStatusForPanel: (data: any, accountId: string, accountName: string) => any;
    buildConfigSnapshotForAccount: (accountId: string) => any;
    getOfflineAutoDeleteMs: () => number;
    triggerOfflineReminder: (payload: any) => void;
    sendConfiguredPush?: (payload: any) => Promise<void> | void;
    addOrUpdateAccount: (acc: any) => any;
    deleteAccount: (id: string) => void;
    getLoginSettings?: () => any;
    onStatusSync?: (accountId: string, status: any, accountName?: string) => void;
    onWorkerLog?: (entry: any, accountId: string, accountName?: string) => void;
}

function createWorkerManager(options: WorkerManagerOptions) {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
        addOrUpdateAccount,
        deleteAccount,
        getLoginSettings,
        onStatusSync,
        onWorkerLog,
    } = options;
    const managerScheduler = createScheduler('worker_manager');
    const useThreadRuntime = runtimeMode === 'thread' && !(processRef as any).pkg && typeof WorkerThread === 'function';

    function createThreadWorker(account: any): any {
        const workerOptions: any = {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread',
            },
        };
        // When running from source with tsx, configure worker to use tsx
        if (workerScriptPath.endsWith('.ts')) {
            workerOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        const worker = new WorkerThread(workerScriptPath, workerOptions);
        worker.send = (payload: any) => worker.postMessage(payload);
        worker.kill = () => worker.terminate();
        return worker;
    }

    function createForkWorker(account: any): any {
        if ((processRef as any).pkg) {
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: { ...processRef.env, FARM_WORKER: '1', FARM_ACCOUNT_ID: String(account.id || '') },
            });
        }
        const forkOptions: any = {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...processRef.env, FARM_ACCOUNT_ID: String(account.id || '') },
        };
        if (workerScriptPath.endsWith('.ts')) {
            forkOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        return fork(workerScriptPath, [], forkOptions);
    }

    function createWorkerProcess(account: any): any {
        if (useThreadRuntime) return createThreadWorker(account);
        return createForkWorker(account);
    }

    const WX_APP_ID = 'wx5306c5978fdb76e4';
    const RECONNECT_SUCCESS_STABLE_MS = 60000;
    const RECONNECT_DELAY_MIN = 2;
    const RECONNECT_DELAY_MAX = 480;
    const RECONNECT_ATTEMPTS_MIN = 1;
    const RECONNECT_ATTEMPTS_MAX = 100;
    function resolveReconnectConfig(loginSettings: any): { delayMin: number; maxAttempts: number } {
        const logCfg = (loginSettings && typeof loginSettings === 'object') ? loginSettings : {};
        const delayRaw = Number.parseInt(logCfg.yybReconnectDelayMin, 10);
        const attemptsRaw = Number.parseInt(logCfg.yybReconnectMaxAttempts, 10);
        const delayMin = Number.isFinite(delayRaw)
            ? Math.max(RECONNECT_DELAY_MIN, Math.min(RECONNECT_DELAY_MAX, delayRaw))
            : RECONNECT_DELAY_MIN;
        const maxAttempts = Number.isFinite(attemptsRaw)
            ? Math.max(RECONNECT_ATTEMPTS_MIN, Math.min(RECONNECT_ATTEMPTS_MAX, attemptsRaw))
            : RECONNECT_ATTEMPTS_MIN;
        return { delayMin, maxAttempts };
    }
    // 离线重连状态：只对 loginType=yyb 的微信账号生效
    const reconnectScheduled = new Set<string>();
    const reconnectAttemptsMap = new Map<string, number>();

    /**
     * 微信(应用宝/YYB)账号启动/重连前用持久化的 loginBuffer 换新 Code。
     * 微信 Code 是一次性且短时效的，拿旧 Code 重连必然被 ws_error:400 拒绝，
     * 因此必须使用项目内 getNativeWxLoginCode 先行刷新登录态。
     */
    async function refreshYybCodeIfNeeded(account: any): Promise<void> {
        const isYybWx = !!account
            && String(account.platform || '').toLowerCase() === 'wx'
            && String(account.loginType || '') === 'yyb';
        if (!isYybWx) return;
        const { getNativeWxLoginCode } = require('../services/wx-login/native-protocol');
        let loginBuffer = String(account.loginBuffer || '').trim();
        const openid = String(account.openid || '').trim();
        const accessToken = String(account.accessToken || '').trim();
        const refreshToken = String(account.refreshToken || '').trim();
        if (!loginBuffer && (!openid || (!accessToken && !refreshToken))) {
            log('账号', `账号 ${account.name || account.id} 为微信账号但缺少 loginBuffer 与 (openid/accessToken)，无法自动刷新 Code（请重新扫码登录后生效）`, {
                accountId: String(account.id),
                accountName: account.name || '',
            });
            return;
        }
        let code: string | undefined;
        if (loginBuffer) {
            try {
                code = await getNativeWxLoginCode(loginBuffer, WX_APP_ID);
            } catch (err: any) {
                const reason = err && err.message ? err.message : String(err || 'unknown error');
                log('系统', `账号 ${account.name || account.id} 用当前 loginBuffer 换 Code 被拒(${String(reason).slice(0, 120)})，尝试用 openid/accessToken 续期新 loginBuffer`, {
                    accountId: String(account.id),
                    accountName: account.name || '',
                });
            }
        }
        if (!code && openid && (accessToken || refreshToken)) {
            try {
                const { WxLoginService } = require('../services/wx-login/service');
                const svc = new WxLoginService();
                let access = accessToken;
                let refresh = refreshToken;
                let oid = openid;
                if (!access && refresh) {
                    const refreshed = await svc.refreshAccessToken(refresh);
                    access = refreshed.accessToken;
                    refresh = refreshed.refreshToken || refresh;
                    if (refreshed.openid) oid = refreshed.openid;
                    Object.assign(account, { accessToken: access, refreshToken: refresh, openid: oid });
                    addOrUpdateAccount({ id: account.id, accessToken: access, refreshToken: refresh, openid: oid });
                    log('系统', `账号 ${account.name || account.id} 已刷新微信 access_token`, {
                        accountId: String(account.id),
                        accountName: account.name || '',
                    });
                }
                let newer: string;
                try {
                    newer = await svc.getWxLoginBuffer(oid, access);
                } catch (bufferErr: any) {
                    if (!refresh) throw bufferErr;
                    const refreshed = await svc.refreshAccessToken(refresh);
                    access = refreshed.accessToken;
                    refresh = refreshed.refreshToken || refresh;
                    if (refreshed.openid) oid = refreshed.openid;
                    Object.assign(account, { accessToken: access, refreshToken: refresh, openid: oid });
                    addOrUpdateAccount({ id: account.id, accessToken: access, refreshToken: refresh, openid: oid });
                    log('系统', `账号 ${account.name || account.id} accessToken 失效，已用 refresh_token 刷新后重试`, {
                        accountId: String(account.id),
                        accountName: account.name || '',
                    });
                    newer = await svc.getWxLoginBuffer(oid, access);
                }
                if (!String(newer || '').trim()) throw new Error('openid/accessToken 续期返回空的 loginBuffer');
                loginBuffer = String(newer).trim();
                Object.assign(account, { loginBuffer, openid: oid, accessToken: access, refreshToken: refresh });
                addOrUpdateAccount({ id: account.id, loginBuffer, openid: oid, accessToken: access, refreshToken: refresh });
                log('系统', `账号 ${account.name || account.id} 已通过 openid/accessToken 续期新 loginBuffer`, {
                    accountId: String(account.id),
                    accountName: account.name || '',
                });
                code = await getNativeWxLoginCode(loginBuffer, WX_APP_ID);
            } catch (err: any) {
                const reason = err && err.message ? err.message : String(err || 'unknown error');
                throw new Error(`openid/accessToken 续期登录态失败: ${reason}`);
            }
        }
        if (!code) throw new Error('应用宝刷新微信 Code 返回为空');
        Object.assign(account, { code: String(code), loginBuffer });
        addOrUpdateAccount({ id: account.id, code: String(code), loginBuffer, accessToken: String(account.accessToken || ''), refreshToken: String(account.refreshToken || '') });
        log('系统', `账号 ${account.name || account.id} 已刷新微信 Code`, {
            accountId: String(account.id),
            accountName: account.name || '',
        });
    }

    const startingIds = new Set<string>();

    function startWorker(account: any): boolean {
        const id = String(account?.id || '');
        if (!id || workers[account.id] || startingIds.has(id)) return false;
        void startWorkerAsync(account);
        return true;
    }

    async function startWorkerAsync(account: any): Promise<boolean> {
        if (!account || !account.id) return false;
        if (workers[account.id] || startingIds.has(String(account.id))) return false;
        startingIds.add(String(account.id));
        try {
            if (String(account.platform || '').toLowerCase() === 'wx'
                && String(account.loginType || '') === 'yyb') {
                try {
                    await refreshYybCodeIfNeeded(account);
                } catch (err: any) {
                    const reason = err && err.message ? err.message : String(err || 'unknown error');
                    log('错误', `账号 ${account.name || account.id} 微信启动前刷新 Code 失败: ${reason}`, {
                        accountId: String(account.id),
                        accountName: account.name || '',
                    });
                    addAccountLog('yyb_start_refresh_failed', `微信启动前刷新 Code 失败: ${reason}`, account.id, account.name || '', { reason });
                    return false;
                }
            }
            if (workers[account.id]) return false;
            return startWorkerInner(account);
        } finally {
            startingIds.delete(String(account.id));
        }
    }

    function startWorkerInner(account: any): boolean {
        if (!account || !account.id) return false;
        if (workers[account.id]) return false;

        log('系统', `正在启动账号: ${account.name}`, { accountId: String(account.id), accountName: account.name });

        let child: any = null;
        try {
            child = createWorkerProcess(account);
        } catch (err: any) {
            const reason = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${account.name} 启动失败: ${reason}`, { accountId: String(account.id), accountName: account.name });
            addAccountLog('start_failed', `账号 ${account.name} 启动失败`, account.id, account.name, { reason });
            return false;
        }

        workers[account.id] = {
            process: child,
            status: null,
            logs: [],
            requests: new Map(),
            reqId: 1,
            name: account.name,
            nick: account.nick || '',
            avatar: account.avatar || '',
            stopping: false,
            disconnectedSince: 0,
            autoDeleteTriggered: false,
            terminalHandled: false,
            wsError: null,
        };

        const initialConfigSnapshot = buildConfigSnapshotForAccount(account.id);
        child.send({
            type: 'start',
            config: {
                code: account.code,
                platform: account.platform,
                systemTimeZone: initialConfigSnapshot.systemTimeZone,
                systemServerUrl: initialConfigSnapshot.systemServerUrl,
                systemClientVersion: initialConfigSnapshot.systemClientVersion,
            },
        });
        child.send({ type: 'config_sync', config: initialConfigSnapshot });

        child.on('message', (msg: any) => {
            handleWorkerMessage(account.id, child, msg);
        });

        child.on('error', (err: any) => {
            log('系统', `账号 ${account.name} 子进程启动失败: ${err && err.message ? err.message : err}`, { accountId: String(account.id), accountName: account.name });
        });

        child.on('exit', (code: number, signal: string) => {
            const current = workers[account.id];
            if (!current || current.process !== child) return;
            const displayName = current.name || account.name;
            log('系统', `账号 ${displayName} 进程退出 (code=${code}, signal=${signal || 'none'})`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: useThreadRuntime ? 'thread' : 'fork',
            });

            managerScheduler.clear(`force_kill_${account.id}`);
            managerScheduler.clear(`restart_fallback_${account.id}`);

            if (current && current.requests && current.requests.size > 0) {
                for (const [reqId, req] of current.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${account.id}_${reqId}`);
                    try {
                        req.reject(new Error('Worker exited'));
                    } catch {}
                }
                current.requests.clear();
            }

            if (current && current.process === child) {
                delete workers[account.id];
            }
        });
        return true;
    }

    function stopWorker(accountId: string): void {
        const worker = workers[accountId];
        if (!worker) return;

        const proc = worker.process;
        worker.stopping = true;
        worker.process.send({ type: 'stop' });
        managerScheduler.setTimeoutTask(`force_kill_${accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === proc) {
                current.process.kill();
                delete workers[accountId];
            }
        });
    }

    function restartWorker(account: any): void {
        if (!account) return;
        const accountId = account.id;
        const worker = workers[accountId];
        if (!worker) { startWorker(account); return; }
        const proc = worker.process;
        let started = false;
        const startOnce = () => {
            if (started) return;
            started = true;
            managerScheduler.clear(`restart_fallback_${accountId}`);
            const current = workers[accountId];
            if (!current) { startWorker(account); return; }
            if (current.process !== proc) return;
            delete workers[accountId];
            startWorker(account);
        };
        const killIfStale = () => {
            const current = workers[accountId];
            if (!current || current.process !== proc) return false;
            try {
                current.process.kill();
            } catch {}
            delete workers[accountId];
            return true;
        };
        if (typeof proc.exitCode === 'number' || proc.signalCode) {
            startOnce();
            return;
        }
        proc.once('exit', startOnce);
        stopWorker(accountId);
        managerScheduler.setTimeoutTask(`restart_fallback_${accountId}`, 1500, () => {
            if (started) return;
            killIfStale();
            startOnce();
        });
    }

    function errorFromWorkerPayload(payload: any): Error & { code?: string | number; errorMessage?: string } {
        if (!payload || typeof payload !== 'object') return new Error(String(payload || 'Worker API error'));
        const error: Error & { code?: string | number; errorMessage?: string } = new Error(String(payload.message || 'Worker API error'));
        if (payload.name) error.name = String(payload.name);
        if (payload.code !== undefined && payload.code !== null && payload.code !== '') error.code = payload.code;
        const protocolMessage = payload.errorMessage ?? payload.error_message;
        if (protocolMessage !== undefined && protocolMessage !== null) error.errorMessage = String(protocolMessage);
        return error;
    }

    /**
     * 微信(应用宝)账号掉线自动补 Code 重连调度。
     * Code 是一次性短时效的，掉线后必须用 persist loginBuffer 换新码再重启；
     * 仅对 platform=wx 且 loginType=yyb 的账号生效，受 yybAutoReconnect 开关控制。
     */
    function scheduleReconnect(accountId: string, reason: string): void {
        const wrk = workers[accountId];
        const name = wrk ? wrk.name : String(accountId);
        if (reconnectScheduled.has(accountId)) {
            log('系统', `账号 ${name || accountId} 已在自动重连队列，忽略重复事件`, {
                accountId: String(accountId),
                accountName: name || '',
                reason,
            });
            return;
        }
        reconnectScheduled.add(accountId);
        log('系统', `账号 ${name} 触发应用宝离线重连调度 (${reason})`, {
            accountId: String(accountId),
            accountName: name,
            reason,
        });
        stopWorker(accountId);
        const { getAccounts } = require('../models/store');
        const loginSettings = typeof getLoginSettings === 'function' ? getLoginSettings() : {};
        const accountsData = getAccounts();
        const account = (accountsData.accounts || []).find((a: any) => String(a.id) === String(accountId));
        if (!account) {
            reconnectScheduled.delete(accountId);
            log('系统', `账号 ${name} 已不存在，取消自动重连`);
            return;
        }
        const isYybWx = String(account.platform || '').toLowerCase() === 'wx'
            && String(account.loginType || '') === 'yyb';
        if (!isYybWx || !loginSettings || !loginSettings.yybAutoReconnect) {
            reconnectScheduled.delete(accountId);
            log('系统', `账号 ${name} 未启用应用宝自动重连，已停止`);
            return;
        }
        if (!String(account.loginBuffer || '').trim()
            && (!String(account.openid || '').trim()
                || (!String(account.accessToken || '').trim() && !String(account.refreshToken || '').trim()))) {
            reconnectScheduled.delete(accountId);
            log('系统', `账号 ${name} 缺少 loginBuffer 及 (openid/accessToken)，无法自动补 Code 重连，请重新扫码`);
            return;
        }
        const { delayMin, maxAttempts } = resolveReconnectConfig(loginSettings);
        const currentAttempt = reconnectAttemptsMap.get(accountId) || 0;
        if (currentAttempt >= maxAttempts) {
            log('系统', `账号 ${name} 自动重连已达上限(${maxAttempts}次)，停止重连`, {
                accountId: String(accountId),
                attempts: currentAttempt,
            });
            reconnectAttemptsMap.delete(accountId);
            reconnectScheduled.delete(accountId);
            return;
        }
        const nextAttempt = currentAttempt + 1;
        reconnectAttemptsMap.set(accountId, nextAttempt);
        const fastFirstMs = 2000;
        const subsequentDelayMs = delayMin * 60 * 1000;
        const delayMs = nextAttempt === 1 ? fastFirstMs : subsequentDelayMs;
        const delayDesc = nextAttempt === 1 ? '2 秒' : `${delayMin} 分钟`;
        log('系统', `账号 ${name} 将在 ${delayDesc}后自动重连 (${nextAttempt}/${maxAttempts})`, {
            accountId: String(accountId),
            delayMs,
            attempt: nextAttempt,
            maxAttempts,
        });
        managerScheduler.setTimeoutTask(`reconnect_attempt_${accountId}`, delayMs, async () => {
            reconnectScheduled.delete(accountId);
            if (workers[accountId]) return;
            try {
                const { getAccounts: getAccountsNow } = require('../models/store');
                const latest = (getAccountsNow().accounts || []).find((a: any) => String(a.id) === String(accountId));
                if (!latest) {
                    log('系统', `账号 ${name} 已被删除，取消自动重连`);
                    reconnectAttemptsMap.delete(accountId);
                    return;
                }
                log('系统', `账号 ${name} 开始自动重连 (${nextAttempt}/${maxAttempts})`);
                const started = await startWorkerAsync(latest);
                if (started) {
                    managerScheduler.setTimeoutTask(`reconnect_reset_${accountId}`, RECONNECT_SUCCESS_STABLE_MS, () => {
                        if (workers[accountId]) reconnectAttemptsMap.delete(accountId);
                    });
                    addAccountLog('reconnect_success', `账号 ${name} 已通过应用宝补 Code 重连恢复在线 (${nextAttempt}/${maxAttempts})`, accountId, name, { attempt: nextAttempt, maxAttempts });
                } else {
                    log('系统', `账号 ${name} 本次自动重连未能启动，安排下一次重试`, {
                        accountId: String(accountId),
                        accountName: name,
                        attempt: nextAttempt,
                        maxAttempts,
                    });
                    scheduleReconnect(accountId, 'reconnect_retry');
                }
            } catch (e: any) {
                log('系统', `账号 ${name} 自动重连启动失败: ${e && e.message ? e.message : e}`);
            }
        });
    }

    function handleWorkerMessage(accountId: string, sourceProcess: any, msg: any): void {
        const worker = workers[accountId];
        if (!worker || worker.process !== sourceProcess) return;

        if (msg.type === 'status_sync') {
            worker.status = normalizeStatusForPanel(msg.data, accountId, worker.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, worker.status, worker.name);
            }

            const profile = msg.data && msg.data.status && typeof msg.data.status === 'object'
                ? msg.data.status
                : {};
            const accountUpdate: any = { id: accountId };
            let profileChanged = false;

            if (profile.name) {
                const newNick = String(profile.name).trim();
                if (newNick && newNick !== '未知' && newNick !== '未登录') {
                    if (worker.nick !== newNick) {
                        const oldNick = worker.nick;
                        worker.nick = newNick;
                        accountUpdate.nick = newNick;
                        profileChanged = true;
                        if (oldNick !== newNick) {
                            log('系统', `已同步账号昵称: ${oldNick || 'None'} -> ${newNick}`, { accountId, accountName: worker.name });
                        }
                    }
                }
            }

            const newAvatar = String(profile.avatarUrl || profile.avatar_url || '').trim();
            if (newAvatar && worker.avatar !== newAvatar) {
                worker.avatar = newAvatar;
                accountUpdate.avatar = newAvatar;
                profileChanged = true;
            }

            if (profileChanged) {
                addOrUpdateAccount(accountUpdate);
            }

            const connected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (connected) {
                worker.disconnectedSince = 0;
                worker.autoDeleteTriggered = false;
                worker.wsError = null;
            } else if (!worker.stopping) {
                const now = Date.now();
                if (!worker.disconnectedSince) worker.disconnectedSince = now;
                const offlineMs = now - worker.disconnectedSince;
                const autoDeleteMs = getOfflineAutoDeleteMs();
                if (!worker.autoDeleteTriggered && offlineMs >= autoDeleteMs) {
                    worker.autoDeleteTriggered = true;
                    const offlineMin = Math.floor(offlineMs / 60000);
                    log('系统', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，自动删除账号信息`);
                    triggerOfflineReminder({
                        accountId,
                        accountName: worker.name,
                        reason: 'offline_timeout',
                        offlineMs,
                    });
                    addAccountLog(
                        'offline_delete',
                        `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，已自动删除`,
                        accountId,
                        worker.name,
                        { reason: 'offline_timeout', offlineMs },
                    );
                    stopWorker(accountId);
                    try {
                        deleteAccount(accountId);
                    } catch (e: any) {
                        log('错误', `删除离线账号失败: ${e.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            const logEntry = {
                ...msg.data,
                accountId,
                accountName: worker.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {},
            };
            logEntry._searchText = `${logEntry.msg || ''} ${logEntry.tag || ''} ${JSON.stringify(logEntry.meta || {})}`.toLowerCase();
            worker.logs.push(logEntry);
            if (worker.logs.length > 1000) worker.logs.shift();
            globalLogs.push(logEntry);
            if (globalLogs.length > 1000) globalLogs.shift();
            if (typeof onWorkerLog === 'function') {
                onWorkerLog(logEntry, accountId, worker.name);
            }
        } else if (msg.type === 'error') {
            const workerError = errorFromWorkerPayload(msg.error);
            log('错误', `账号[${accountId}]进程报错: ${workerError.message}`, {
                accountId: String(accountId),
                accountName: worker.name,
                errorCode: workerError.code,
                errorName: workerError.name,
            });
        } else if (msg.type === 'ws_error') {
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            worker.wsError = { code, message, at: Date.now() };
            if (code === 400) {
                addAccountLog(
                    'ws_400',
                    `账号 ${worker.name} 登录失效，请更新 Code`,
                    accountId,
                    worker.name,
                );
                scheduleReconnect(accountId, `ws_error:${code}`);
            }
        } else if (msg.type === 'account_kicked') {
            if (worker.terminalHandled) return;
            worker.terminalHandled = true;
            const reason = msg.reason || '未知';
            log('系统', `账号 ${worker.name} 被踢下线，已自动停止账号`, { accountId: String(accountId), accountName: worker.name });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `kickout:${reason}`,
                offlineMs: 0,
            });
            addAccountLog('kickout_stop', `账号 ${worker.name} 被踢下线，已自动停止`, accountId, worker.name, { reason });
            stopWorker(accountId);
            scheduleReconnect(accountId, `kickout:${reason}`);
        } else if (msg.type === 'account_disconnected') {
            if (worker.terminalHandled) return;
            worker.terminalHandled = true;
            const source = String(msg.source || 'ws_close');
            const code = Number(msg.code) || 0;
            const reason = String(msg.reason || '连接已断开');
            const phase = String(msg.phase || 'unknown');
            if (worker.status?.connection) worker.status.connection.connected = false;
            if (worker.requests.size > 0) {
                for (const [reqId, req] of worker.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${accountId}_${reqId}`);
                    try { req.reject(new Error('账号连接已断开')); } catch {}
                }
                worker.requests.clear();
            }
            log('系统', `账号 ${worker.name} 连接已断开，已停止运行并等待 Helper 刷新 Code 或重新扫码`, {
                accountId: String(accountId),
                accountName: worker.name,
                source,
                code,
                phase,
            });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `disconnect:${source}:${phase}:${code}`,
                offlineMs: 0,
            });
            addAccountLog(
                'disconnect_stop',
                `账号 ${worker.name} 连接已断开，已停止运行并等待 Helper 刷新 Code 或重新扫码`,
                accountId,
                worker.name,
                { source, code, reason, phase, connectionId: Number(msg.connectionId) || 0 },
            );
            stopWorker(accountId);
            scheduleReconnect(accountId, `disconnect:${source}:${phase}:${code}`);
        } else if (msg.type === 'api_response') {
            const { id, result, error } = msg;
            managerScheduler.clear(`api_timeout_${accountId}_${id}`);
            const req = worker.requests.get(id);
            if (req) {
                if (error) req.reject(errorFromWorkerPayload(error));
                else req.resolve(result);
                worker.requests.delete(id);
            }
        } else if (msg.type === 'friend_blacklist_add') {
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist: addToBlacklist } = require('../models/store');
                addToBlacklist(accountId, gid);
                log('好友', `已将好友 ${msg.friendName || `GID:${gid}`} 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason,
                });
                const worker_process = workers[accountId];
                if (worker_process && worker_process.process) {
                    worker_process.process.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(accountId) });
                }
            }
        } else if (msg.type === 'known_friend_gids_sync') {
            const { setKnownFriendGids } = require('../models/store');
            const gids: number[] = Array.isArray(msg.gids)
                ? msg.gids.map(Number).filter((gid: number) => Number.isFinite(gid) && gid > 0)
                : [];
            const saved: number[] = setKnownFriendGids(accountId, gids);
            worker.process.send({
                type: 'config_sync',
                config: buildConfigSnapshotForAccount(accountId),
            });
            log('好友', `已同步并持久化 ${saved.length} 个好友 GID`, {
                accountId: String(accountId),
                accountName: worker.name,
                friendCount: saved.length,
            });
        } else if (msg.type === 'push_notify') {
            const title = String(msg.title || '').trim();
            const content = String(msg.content || '').trim();
            if (!title || !content || typeof sendConfiguredPush !== 'function') return;
            Promise.resolve(sendConfiguredPush({
                title,
                content,
                accountId,
                accountName: worker.name,
            })).catch((e: any) => {
                log('错误', `事件提醒发送异常: ${e && e.message ? e.message : e}`);
            });
        } else if (msg.type === 'known_friend_gid_remove') {
            const { getKnownFriendGids, setKnownFriendGids } = require('../models/store');
            const gid: number = Number(msg.gid) || 0;
            if (gid > 0) {
                const current: number[] = getKnownFriendGids(accountId);
                setKnownFriendGids(accountId, current.filter((item: number) => Number(item) !== gid));
                worker.process.send({
                    type: 'config_sync',
                    config: buildConfigSnapshotForAccount(accountId),
                });
            }
        }
    }

    function callWorkerApi(accountId: string, method: string, ...args: any[]): Promise<any> {
        const worker = workers[accountId];
        if (!worker) return Promise.reject(new Error('账号未运行'));
        if (worker.stopping || worker.terminalHandled) return Promise.reject(new Error('账号已离线'));

        return new Promise((resolve, reject) => {
            const id = worker.reqId++;
            worker.requests.set(id, { resolve, reject });

            const timeoutMs = API_CALL_TIMEOUTS_MS[method] || DEFAULT_API_CALL_TIMEOUT_MS;
            managerScheduler.setTimeoutTask(`api_timeout_${accountId}_${id}`, timeoutMs, () => {
                if (worker.requests.has(id)) {
                    worker.requests.delete(id);
                    reject(new Error('API Timeout'));
                }
            });

            worker.process.send({ type: 'api_call', id, method, args });
        });
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
    };
}

module.exports = {
    createWorkerManager,
};
