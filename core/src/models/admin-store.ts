export {};
const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const security = require('./auth-security');

const ADMIN_FILE: string = getDataFile('admin.json');

// 默认管理员凭据（首次启动且不存在 admin.json 时使用）
const DEFAULT_ADMIN_USERNAME = 'ikun';
const DEFAULT_ADMIN_PASSWORD = 'J!RZpE9jvQ8QkRwB';

interface AdminRecord {
    username: string;
    password: string;
    createdAt: number;
    mustChangePassword?: boolean;
}

let admin: AdminRecord | null = null;

function normalizeAdmin(raw: any): AdminRecord | null {
    if (!raw || typeof raw !== 'object' || !String(raw.password || '').trim()) return null;
    return {
        username: String(raw.username || DEFAULT_ADMIN_USERNAME).trim() || DEFAULT_ADMIN_USERNAME,
        password: String(raw.password),
        createdAt: Number(raw.createdAt) || Date.now(),
        mustChangePassword: raw.mustChangePassword === true || undefined,
    };
}

function saveAdmin(): void {
    ensureDataDir();
    if (!admin) return;
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ admin }, null, 2), 'utf8');
}

function loadAdmin(): AdminRecord {
    ensureDataDir();
    if (admin) return admin;
    try {
        if (fs.existsSync(ADMIN_FILE)) {
            const data = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
            admin = normalizeAdmin(data?.admin || data);
        }
    } catch {
        admin = null;
    }
    if (!admin) {
        admin = {
            username: DEFAULT_ADMIN_USERNAME,
            password: security.hashPassword(DEFAULT_ADMIN_PASSWORD),
            createdAt: Date.now(),
        };
        saveAdmin();
        console.log(`[管理员] 已创建默认账号 ${DEFAULT_ADMIN_USERNAME}`);
    }
    return admin;
}

function getAdminInfo(): { username: string; role: 'admin'; mustChangePassword: boolean } {
    const current = loadAdmin();
    return { username: current.username, role: 'admin', mustChangePassword: current.mustChangePassword === true };
}

function validateAdmin(username: string, password: string, ip: string = 'unknown'): any {
    security.loadLoginAttempts();
    const rateLimit = security.checkRateLimit(ip);
    if (!rateLimit.allowed) return { error: 'rate_limit', ...rateLimit };
    const lockout = security.checkAdminLockout();
    if (lockout.locked) return { error: 'locked', ...lockout };

    const current = loadAdmin();
    if (username !== current.username || !security.verifyPassword(password, current.password)) {
        const attempt = security.recordFailedAttempt();
        return attempt.locked
            ? { error: 'locked', message: attempt.message }
            : { error: 'invalid_credentials', message: `用户名或密码错误，剩余尝试次数: ${attempt.remainingAttempts}` };
    }

    security.clearFailedAttempts();
    if (security.needsRehash(current.password)) {
        current.password = security.hashPassword(password);
        saveAdmin();
    }
    return getAdminInfo();
}

function changePassword(oldPassword: string, newPassword: string): { ok: boolean; error?: string; message?: string } {
    const current = loadAdmin();
    if (!security.verifyPassword(oldPassword, current.password)) return { ok: false, error: '当前密码错误' };
    const validation = security.validatePasswordStrength(newPassword);
    if (!validation.valid) return { ok: false, error: validation.errors.join('；') };
    current.password = security.hashPassword(newPassword);
    delete current.mustChangePassword;
    saveAdmin();
    return { ok: true, message: '密码修改成功' };
}

loadAdmin();

module.exports = { getAdminInfo, validateAdmin, changePassword };
