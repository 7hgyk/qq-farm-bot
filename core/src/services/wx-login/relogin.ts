export {};
/**
 * 微信登录态彻底失效（refresh_token 无效/过期）时的自动重新扫码服务。
 *
 * 通过通知渠道推送"二维码图片外链"（由本服务托管在 bot 后台的公网地址上），
 * 用户扫码后自动确认、写回账号凭据并重新启动账号，全程无需登录后台。
 * 二维码外链按需生成/续期，消息里的链接长期有效，过期后重新打开即为新码。
 */

const crypto = require('node:crypto');

const POLL_INTERVAL_MS = 2500;
const SCAN_DEADLINE_MS = 600_000;
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

// token -> { account, createdAt }：一次"重新扫码请求"，消息里的链接长期有效
const reloginRequests = new Map();
// token -> { session, qr, scanning }：当前活跃的微信扫码会话
const reloginEntries = new Map();

let lastPublicOrigin = '';
let activeService = null;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPrivateHost(host: string): boolean {
    const name = host.split(':')[0].toLowerCase();
    if (name === 'localhost' || name === '127.0.0.1' || name === '0.0.0.0' || name === '::1') return true;
    if (/^10\./.test(name) || /^192\.168\./.test(name) || /^172\.(1[6-9]|2\d|3[01])\./.test(name)) return true;
    if (!name.includes('.')) return true;
    return false;
}

/** 记录最近一次可公网访问的来源地址，用于拼二维码外链（无需用户配置）。 */
function recordPublicOrigin(req: any): void {
    try {
        const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
        if (!host || isPrivateHost(host)) return;
        const protoRaw = String((req.headers && req.headers['x-forwarded-proto']) || (req.secure ? 'https' : 'http')).split(',')[0].trim();
        const proto = protoRaw === 'https' ? 'https' : 'http';
        lastPublicOrigin = `${proto}://${host}`;
    } catch {
        // 忽略
    }
}

/** 优先用环境变量（Render 会自动注入 RENDER_EXTERNAL_URL），否则用记录到的来源。 */
function resolvePublicBaseUrl(): string {
    const env = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
    if (env) return env.replace(/\/+$/, '');
    return lastPublicOrigin;
}

function escapeHtml(input: any): string {
    return String(input == null ? '' : input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

interface ReloginQrOptions {
    store: any;
    log: (tag: string, msg: string, extra?: any) => void;
    addOrUpdateAccount: (acc: any) => any;
    startAccount: (account: any) => void;
    sendConfiguredPush: (payload: any) => Promise<void> | void;
}

function createReloginQrService(options: ReloginQrOptions) {
    const { store, log, addOrUpdateAccount, startAccount, sendConfiguredPush } = options;

    function resolveChannel(): string {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder() : null;
        return String((cfg && cfg.channel) || '').trim().toLowerCase();
    }

    function channelSupportsHtmlImage(): boolean {
        const channel = resolveChannel();
        return channel === 'pushplus' || channel === 'pushplushxtrip';
    }

    function findAccount(accountId: string): any {
        try {
            const data = store.getAccounts ? store.getAccounts() : null;
            return ((data && data.accounts) || []).find((item: any) => String(item.id) === accountId) || null;
        } catch {
            return null;
        }
    }

    async function createSession(): Promise<any> {
        const { WxLoginService } = require('./service');
        const wxLogin = new WxLoginService();
        const created = await wxLogin.createQrSession();
        return { wxLogin, session: created.session, qr: created.qr };
    }

    async function ensureEntry(token: string): Promise<any> {
        const requestInfo = reloginRequests.get(token);
        if (!requestInfo) return null;
        let entry = reloginEntries.get(token);
        if (!entry) {
            const created = await createSession();
            entry = { token, account: requestInfo.account, wxLogin: created.wxLogin, session: created.session, qr: created.qr, scanning: false };
            reloginEntries.set(token, entry);
        }
        return entry;
    }

    async function completeLogin(token: string, entry: any): Promise<void> {
        const account = entry.account || {};
        const accountId = String(account.id || '');
        const accountName = String(account.name || '');
        const label = `账号 ${accountName || accountId}`;
        try {
            await entry.wxLogin.confirm(entry.session);
            const credentials = {
                openid: entry.session.openid || '',
                accessToken: entry.session.accessToken || '',
                refreshToken: entry.session.refreshToken || '',
                loginBuffer: entry.session.loginBuffer || '',
            };
            addOrUpdateAccount({ id: account.id, ...credentials });
            log('系统', `${label} 重新扫码登录成功，已更新登录态并重新启动`, { accountId, accountName });
            const updated = findAccount(accountId) || { ...account, ...credentials };
            startAccount(updated);
        } catch (err: any) {
            log('错误', `${label} 确认重新登录失败: ${err && err.message ? err.message : err}`, { accountId, accountName });
        } finally {
            try { entry.wxLogin.destroy(entry.session); } catch { /* ignore */ }
            reloginEntries.delete(token);
        }
    }

    function startScan(token: string): void {
        const entry = reloginEntries.get(token);
        if (!entry || entry.scanning) return;
        entry.scanning = true;
        void (async () => {
            const deadline = Date.now() + SCAN_DEADLINE_MS;
            let timedOut = true;
            try {
                while (Date.now() < deadline) {
                    const current = reloginEntries.get(token);
                    if (!current) { timedOut = false; return; }
                    let status = '';
                    try {
                        status = await current.wxLogin.poll(current.session);
                    } catch (err: any) {
                        log('错误', `重新扫码轮询异常: ${err && err.message ? err.message : err}`);
                        await sleep(POLL_INTERVAL_MS);
                        continue;
                    }
                    if (status === 'authorized') {
                        timedOut = false;
                        await completeLogin(token, current);
                        return;
                    }
                    if (status === 'cancelled' || status === 'expired') {
                        timedOut = false;
                        try { current.wxLogin.destroy(current.session); } catch { /* ignore */ }
                        reloginEntries.delete(token);
                        log('系统', `重新登录二维码已过期，重新打开通知里的二维码即为新码`, {
                            accountId: String((current.account && current.account.id) || ''),
                            accountName: String((current.account && current.account.name) || ''),
                        });
                        return;
                    }
                    await sleep(POLL_INTERVAL_MS);
                }
            } finally {
                const cur = reloginEntries.get(token);
                if (cur) {
                    cur.scanning = false;
                    // 超时未扫码：清理会话，等下次访问链接时再生成新码，避免留下无人轮询的僵尸会话
                    if (timedOut) {
                        try { cur.wxLogin.destroy(cur.session); } catch { /* ignore */ }
                        reloginEntries.delete(token);
                    }
                }
            }
        })();
    }

    /** 供 HTTP 路由按需取用（打开消息里的二维码链接时调用）。 */
    async function ensureQrForRoute(token: string): Promise<any> {
        const entry = await ensureEntry(token);
        if (entry) startScan(token);
        return entry;
    }

    async function pushQr(account: any, token: string): Promise<void> {
        const accountId = String(account.id || '');
        const accountName = String(account.name || '');
        const title = `账号 ${accountName || accountId} 需要重新扫码登录`;
        const base = resolvePublicBaseUrl();
        if (base && channelSupportsHtmlImage()) {
            const imgUrl = `${base}/api/relogin/${token}/qr`;
            const pageUrl = `${base}/api/relogin/${token}`;
            const name = escapeHtml(accountName || accountId);
            const html = [
                '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;line-height:1.6">',
                `<p><b>账号 ${name} 微信登录态已失效，无法自动续期</b></p>`,
                '<p>请用微信扫描下方二维码完成重新登录，扫码成功后账号会自动恢复运行：</p>',
                `<p><img src="${imgUrl}" style="width:240px;height:240px;border:1px solid #eee" alt="登录二维码" /></p>`,
                `<p style="color:#888;font-size:12px">若二维码未显示，可<a href="${pageUrl}">点此打开扫码页</a>。</p>`,
                '</div>',
            ].join('');
            await sendConfiguredPush({
                title,
                content: '微信登录态已失效，请扫描二维码重新登录',
                html,
                accountId,
                accountName,
                logLabel: '重新扫码推送',
            });
        } else if (base) {
            await sendConfiguredPush({
                title,
                content: `微信登录态已彻底失效，无法自动续期，请打开以下链接扫码重新登录：${base}/api/relogin/${token}`,
                accountId,
                accountName,
                logLabel: '重新扫码推送',
            });
        } else {
            await sendConfiguredPush({
                title,
                content: '微信登录态已彻底失效，无法自动续期；未检测到可公网访问的地址，请登录后台重新扫码。',
                accountId,
                accountName,
                logLabel: '重新扫码推送',
            });
        }
    }

    /**
     * 请求为指定账号发起一次"重新扫码"流程（幂等：同一账号存在未过期请求时复用）。
     */
    function requestRelogin(input: any): void {
        const account = input || {};
        const accountId = String(account.id || '');
        if (!accountId) return;
        for (const info of reloginRequests.values()) {
            if (String((info.account && info.account.id) || '') === accountId && Date.now() - info.createdAt < REQUEST_TTL_MS) {
                return;
            }
        }
        const token = crypto.randomBytes(24).toString('hex');
        reloginRequests.set(token, { account, createdAt: Date.now() });
        void (async () => {
            try {
                if (resolvePublicBaseUrl()) {
                    await ensureQrForRoute(token);
                }
                await pushQr(account, token);
                log('系统', `账号 ${account.name || accountId} 已推送重新登录二维码，等待扫码`, { accountId, accountName: account.name || '', link: `${resolvePublicBaseUrl()}/api/relogin/${token}` });
            } catch (err: any) {
                log('错误', `账号 ${accountId} 推送重新登录二维码失败: ${err && err.message ? err.message : err}`, { accountId, accountName: account.name || '' });
            }
        })();
    }

    const service = { requestRelogin, ensureQrForRoute };
    activeService = service;
    return service;
}

/** HTTP 路由用：按 token 取当前有效的二维码会话（无则新建）。 */
async function getReloginQr(token: any): Promise<any> {
    if (!activeService) return null;
    return activeService.ensureQrForRoute(String(token || ''));
}

/** HTTP 路由用：token 是否对应一个有效的重新扫码请求。 */
function getReloginRequest(token: any): any {
    return reloginRequests.get(String(token || '')) || null;
}

module.exports = {
    createReloginQrService,
    recordPublicOrigin,
    resolvePublicBaseUrl,
    getReloginQr,
    getReloginRequest,
};
