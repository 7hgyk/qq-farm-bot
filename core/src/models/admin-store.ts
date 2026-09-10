export {};
const fs = require('node:fs');
const crypto = require('node:crypto');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { CONFIG } = require('../config/config');
const security = require('./auth-security');

const ADMIN_FILE: string = getDataFile('admin.json');

// 默认管理员用户名（非敏感，仅作为未配置 ADMIN_USERNAME 时的兜底）
const DEFAULT_ADMIN_USERNAME = 'ikun';

interface AdminRecord {
    username: string;
    password: string;
    createdAt: number;
    mustChangePassword?: boolean;
}

let admin: AdminRecord | null = null;

function envUsername(): string {
    const raw = String(CONFIG.adminUsername || '').trim();
    return raw || DEFAULT_ADMIN_USERNAME;
}

function envPassword(): string {
    return String(CONFIG.adminPassword || '');
}

function generateRandomPassword(): string {
    return crypto.randomBytes(18).toString('base64url');
}

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

    const username = envUsername();
    const password = envPassword();

    if (!admin) {
        // 首次启动：优先使用 ADMIN_PASSWORD，未配置则随机生成并打印一次
        const initialPassword = password || generateRandomPassword();
        admin = {
            username,
            password: security.hashPassword(initialPassword),
            createdAt: Date.now(),
        };
        saveAdmin();
        if (password) {
            console.log(`[管理员] 已创建默认账号 ${username}（密码来自 ADMIN_PASSWORD 环境变量）`);
        } else {
            console.log(`[管理员] 已创建默认账号 ${username}`);
            console.log(`[管理员] 未配置 ADMIN_PASSWORD，已生成随机密码（仅本次显示，请立即保存）：${initialPassword}`);
        }
        return admin;
    }

    // 已存在 admin.json：配置了 ADMIN_PASSWORD 时以环境变量为准，强制同步
    let changed = false;
    if (password && !security.verifyPassword(password, admin.password)) {
        admin.password = security.hashPassword(password);
        delete admin.mustChangePassword;
        changed = true;
        console.log('[管理员] 检测到 ADMIN_PASSWORD 环境变量与已存凭据不一致，已按环境变量更新管理员密码');
    }
    if (admin.username !== username) {
        admin.username = username;
        changed = true;
        console.log(`[管理员] 已按 ADMIN_USERNAME 环境变量更新管理员用户名为 ${username}`);
    }
    if (changed) saveAdmin();

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
