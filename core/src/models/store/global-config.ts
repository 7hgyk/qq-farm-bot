import type { AccountConfig, LoginSettings, OfflineReminder, SystemConfig, UIConfig } from '../../types/config';
export {};

const { readTextFile, writeJsonFileAtomic } = require('../../services/json-db');
const { CONFIG, DEFAULT_CLIENT_VERSION, DEFAULT_TIME_ZONE, DEFAULT_DEVICE_INFO: DEFAULT_DEVICE_INFO_DEFAULT, DEFAULT_PLATFORM, normalizeTimeZone, resolveClientVersionUpdatedAt } = require('../../config/config');

const sharedState = require('./shared-state');

const {
    STORE_FILE,
    PUSHOO_CHANNELS,
    DEFAULT_OFFLINE_REMINDER,
    DEFAULT_LOGIN_SETTINGS,
    globalConfig,
    normalizeAccountConfig,
    cloneAccountConfig,
    DEFAULT_ACCOUNT_CONFIG,
} = sharedState;

function normalizeOfflineReminder(input: unknown): OfflineReminder {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    let offlineDeleteSec = Number.parseInt(src.offlineDeleteSec, 10);
    if (!Number.isFinite(offlineDeleteSec) || offlineDeleteSec < 0) {
        offlineDeleteSec = DEFAULT_OFFLINE_REMINDER.offlineDeleteSec;
    }
    const rawChannel = (src.channel !== undefined && src.channel !== null)
        ? String(src.channel).trim().toLowerCase()
        : '';
    const endpoint = (src.endpoint !== undefined && src.endpoint !== null)
        ? String(src.endpoint).trim()
        : DEFAULT_OFFLINE_REMINDER.endpoint;
    const migratedChannel = rawChannel
        || (PUSHOO_CHANNELS.has(String(endpoint || '').trim().toLowerCase())
            ? String(endpoint || '').trim().toLowerCase()
            : DEFAULT_OFFLINE_REMINDER.channel);
    const channel = PUSHOO_CHANNELS.has(migratedChannel)
        ? migratedChannel
        : DEFAULT_OFFLINE_REMINDER.channel;
    const token = (src.token !== undefined && src.token !== null)
        ? String(src.token).trim()
        : DEFAULT_OFFLINE_REMINDER.token;
    const secret = (src.secret !== undefined && src.secret !== null)
        ? String(src.secret).trim()
        : DEFAULT_OFFLINE_REMINDER.secret;
    const title = (src.title !== undefined && src.title !== null)
        ? String(src.title).trim()
        : DEFAULT_OFFLINE_REMINDER.title;
    const msg = (src.msg !== undefined && src.msg !== null)
        ? String(src.msg).trim()
        : DEFAULT_OFFLINE_REMINDER.msg;
    return {
        channel,
        endpoint,
        token,
        secret,
        title,
        msg,
        offlineDeleteSec,
    };
}

function sanitizeGlobalConfigBeforeSave(): void {
    sharedState.accountFallbackConfig = normalizeAccountConfig(globalConfig.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
    globalConfig.defaultAccountConfig = cloneAccountConfig(sharedState.accountFallbackConfig);

    const map = (globalConfig.accountConfigs && typeof globalConfig.accountConfigs === 'object')
        ? globalConfig.accountConfigs
        : {};
    const nextMap: Record<string, AccountConfig> = {};
    for (const [id, cfg] of Object.entries(map)) {
        const sid = String(id || '').trim();
        if (!sid) continue;
        nextMap[sid] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
    }
    globalConfig.accountConfigs = nextMap;

}

function saveGlobalConfig(): void {
    const { ensureDataDir } = require('../../config/runtime-paths');
    ensureDataDir();
    try {
        const oldJson: string = readTextFile(STORE_FILE, '');

        sanitizeGlobalConfigBeforeSave();
        const newJson = JSON.stringify(globalConfig, null, 2);

        if (oldJson !== newJson) {
            console.warn('[系统] 正在保存配置到:', STORE_FILE);
            writeJsonFileAtomic(STORE_FILE, globalConfig);
        }
    } catch (e: any) {
        console.error('保存配置失败:', e.message);
    }
}

function getUI(): UIConfig {
    return { ...globalConfig.ui };
}

function setUITheme(theme: unknown): UIConfig {
    const t = String(theme || '').toLowerCase();
    const next: UIConfig['theme'] = (t === 'light') ? 'light' : 'dark';
    // Import here to avoid circular - use direct globalConfig mutation
    if (globalConfig.ui) {
        globalConfig.ui.theme = next;
    }
    saveGlobalConfig();
    return getUI();
}

function getOfflineReminder(): OfflineReminder {
    return normalizeOfflineReminder(globalConfig.offlineReminder);
}

function normalizeLoginSettings(input: unknown): LoginSettings {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    const delayRaw = Number.parseInt(src.yybReconnectDelayMin, 10);
    const attemptsRaw = Number.parseInt(src.yybReconnectMaxAttempts, 10);
    return {
        codeLogin: typeof src.codeLogin === 'boolean' ? src.codeLogin : DEFAULT_LOGIN_SETTINGS.codeLogin,
        wechatQrLogin: typeof src.wechatQrLogin === 'boolean' ? src.wechatQrLogin : DEFAULT_LOGIN_SETTINGS.wechatQrLogin,
        qqQrLogin: typeof src.qqQrLogin === 'boolean' ? src.qqQrLogin : DEFAULT_LOGIN_SETTINGS.qqQrLogin,
        yybQrLogin: typeof src.yybQrLogin === 'boolean' ? src.yybQrLogin : DEFAULT_LOGIN_SETTINGS.yybQrLogin,
        yybAutoReconnect: typeof src.yybAutoReconnect === 'boolean' ? src.yybAutoReconnect : DEFAULT_LOGIN_SETTINGS.yybAutoReconnect,
        yybReconnectDelayMin: Math.max(2, Math.min(480, Number.isFinite(delayRaw) ? delayRaw : DEFAULT_LOGIN_SETTINGS.yybReconnectDelayMin)),
        yybReconnectMaxAttempts: Math.max(1, Math.min(100, Number.isFinite(attemptsRaw) ? attemptsRaw : DEFAULT_LOGIN_SETTINGS.yybReconnectMaxAttempts)),
        napCatEndpoint: typeof src.napCatEndpoint === 'string' ? src.napCatEndpoint.trim() : DEFAULT_LOGIN_SETTINGS.napCatEndpoint,
        napCatSignature: typeof src.napCatSignature === 'string' ? src.napCatSignature.trim() : DEFAULT_LOGIN_SETTINGS.napCatSignature,
    };
}

function getLoginSettings(): LoginSettings {
    return normalizeLoginSettings(globalConfig.loginSettings);
}

function setLoginSettings(cfg: Partial<LoginSettings> | undefined): LoginSettings {
    const next = normalizeLoginSettings({ ...getLoginSettings(), ...(cfg || {}) });
    if (next.qqQrLogin && (!next.napCatEndpoint || !next.napCatSignature)) {
        throw new Error('开启 QQ 扫码登录前，请配置 NapCat 接口地址和接口签名');
    }
    globalConfig.loginSettings = next;
    globalConfig.loginSettingsCustomized = true;
    saveGlobalConfig();
    return getLoginSettings();
}

function setOfflineReminder(cfg: Partial<OfflineReminder> | undefined): OfflineReminder {
    const current = normalizeOfflineReminder(globalConfig.offlineReminder);
    globalConfig.offlineReminder = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
    globalConfig.offlineReminderCustomized = true;
    saveGlobalConfig();
    return getOfflineReminder();
}

function getSystemConfig(): SystemConfig | null {
    return globalConfig.systemConfig ? { ...globalConfig.systemConfig } : null;
}

function setSystemConfig(config: Partial<SystemConfig> | undefined): SystemConfig | null {
    if (!config || typeof config !== 'object') return null;
    const DEFAULT_DEVICE_INFO = { clientVersion: DEFAULT_CLIENT_VERSION, ...DEFAULT_DEVICE_INFO_DEFAULT };
    const srcDevice = (config.deviceInfo && typeof config.deviceInfo === 'object') ? config.deviceInfo : {};
    const topVersion = String(config.clientVersion || '').trim();
    const deviceVersion = String((srcDevice as any).clientVersion || '').trim();
    const requestedVersion = deviceVersion || topVersion;
    const clientVersion = requestedVersion || DEFAULT_DEVICE_INFO.clientVersion;
    const currentVersion = String(globalConfig.systemConfig?.clientVersion || DEFAULT_DEVICE_INFO.clientVersion).trim();
    const currentUpdatedAt = Number(globalConfig.systemConfig?.clientVersionUpdatedAt);
    const clientVersionUpdatedAt = resolveClientVersionUpdatedAt(
        clientVersion,
        currentVersion,
        currentUpdatedAt,
        config.clientVersionUpdatedAt,
    );
    const deviceInfo = {
        os: String((srcDevice as any).os || DEFAULT_DEVICE_INFO.os).trim(),
        clientVersion,
        sysSoftware: String((srcDevice as any).sysSoftware || DEFAULT_DEVICE_INFO.sysSoftware).trim(),
        network: String((srcDevice as any).network || DEFAULT_DEVICE_INFO.network).trim(),
        memory: String((srcDevice as any).memory || DEFAULT_DEVICE_INFO.memory).trim(),
        deviceId: String((srcDevice as any).deviceId || DEFAULT_DEVICE_INFO.deviceId).trim(),
        userAgent: String((srcDevice as any).userAgent || DEFAULT_DEVICE_INFO.userAgent).trim(),
    };
    globalConfig.systemConfig = {
        serverUrl: String(config.serverUrl || '').trim(),
        clientVersion: deviceInfo.clientVersion,
        clientVersionUpdatedAt,
        platform: String(config.platform || DEFAULT_PLATFORM).trim(),
        os: deviceInfo.os,
        timeZone: normalizeTimeZone(config.timeZone || DEFAULT_TIME_ZONE),
        deviceInfo,
    };
    saveGlobalConfig();
    return { ...globalConfig.systemConfig };
}

// Initialize on load
const { loadGlobalConfig } = sharedState;
loadGlobalConfig();
// Apply offlineReminder normalization after load
globalConfig.offlineReminder = normalizeOfflineReminder(globalConfig.offlineReminder);
globalConfig.loginSettings = normalizeLoginSettings(globalConfig.loginSettings);

// 环境变量覆盖：PUSHPLUS_TOKEN / PUSHPLUS_CHANNEL。
// 每次启动都以环境变量为准，避免每次部署后还要在面板里手动重填 Token。
function applyPushplusEnvOverrides(): boolean {
    const token = String(CONFIG.pushplusToken || '').trim();
    const channel = String(CONFIG.pushplusChannel || '').trim().toLowerCase();
    if (!token && !channel) return false;
    const current = normalizeOfflineReminder(globalConfig.offlineReminder);
    let changed = false;
    if (channel && PUSHOO_CHANNELS.has(channel) && channel !== current.channel) {
        current.channel = channel;
        changed = true;
    }
    if (token && token !== current.token) {
        current.token = token;
        if (!channel && current.channel === DEFAULT_OFFLINE_REMINDER.channel) {
            current.channel = 'pushplus';
        }
        changed = true;
    }
    if (!changed) return false;
    globalConfig.offlineReminder = current;
    globalConfig.offlineReminderCustomized = true;
    console.log(`[系统] 已按 PUSHPLUS_* 环境变量更新下线提醒渠道: channel=${current.channel}, token=${token ? '已设置' : '未变更'}`);
    return true;
}

if (applyPushplusEnvOverrides() || sharedState.systemConfigMigrated) {
    saveGlobalConfig();
    sharedState.systemConfigMigrated = false;
}

module.exports = {
    saveGlobalConfig,
    getUI,
    setUITheme,
    getLoginSettings,
    setLoginSettings,
    getOfflineReminder,
    setOfflineReminder,
    getSystemConfig,
    setSystemConfig,
};
