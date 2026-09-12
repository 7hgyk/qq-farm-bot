import crypto from 'node:crypto';
import { getNativeWxLoginCode } from './native-protocol';

const QR_CONNECT_URL = 'https://open.weixin.qq.com/connect/qrconnect';
const QR_IMAGE_BASE = 'https://open.weixin.qq.com/connect/qrcode/';
const QR_POLL_URL = 'https://long.open.weixin.qq.com/connect/l/qrconnect';
const CALLBACK_URL = 'https://yybadaccess.3g.qq.com/pc_yyb/pcyyb_oauth';
const LOGIN_BUFFER_URL = 'https://yybadaccess.3g.qq.com/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth';
const OAUTH_APP_ID = 'wxd44977328b36e647';
const USER_AGENT = 'Mozilla/5.0';
const LOGIN_BUFFER_ACCESS_KEY = 'wgrdg373hy26ww2';

export type ScanStatus = 'waiting' | 'scanned' | 'authorized' | 'cancelled' | 'expired';

export interface WxLoginSession {
    cookies: Map<string, string>;
    uuid: string;
    oauthCode?: string;
    openid?: string;
    accessToken?: string;
    refreshToken?: string;
    loginBuffer?: string;
}

interface HttpResult {
    status: number;
    body: Buffer;
    headers: Headers;
}

function cookieHeader(cookies: Map<string, string>): string {
    return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}

function storeCookies(cookies: Map<string, string>, headers: Headers): void {
    const headerValue = headers.get('set-cookie');
    const values = typeof (headers as any).getSetCookie === 'function'
        ? (headers as any).getSetCookie()
        : headerValue ? [headerValue] : [];
    for (const value of values) {
        const pair = value.split(';', 1)[0].trim();
        const separator = pair.indexOf('=');
        if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
}

async function request(url: string, cookies: Map<string, string>, init: RequestInit = {}, timeout = 35_000): Promise<HttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        let currentUrl = url;
        let method = init.method || 'GET';
        let body = init.body;
        for (let redirects = 0; redirects <= 5; redirects++) {
            const headers = new Headers(init.headers);
            headers.set('User-Agent', USER_AGENT);
            if (cookies.size) headers.set('Cookie', cookieHeader(cookies));
            const response = await fetch(currentUrl, { ...init, method, body, headers, redirect: 'manual', signal: controller.signal });
            storeCookies(cookies, response.headers);
            const location = response.headers.get('location');
            if (response.status < 300 || response.status >= 400 || !location) {
                return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
            }
            currentUrl = new URL(location, currentUrl).toString();
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
                method = 'GET';
                body = undefined;
            }
        }
        throw new Error('Too many redirects while contacting WeChat');
    } finally {
        clearTimeout(timer);
    }
}

function requiredCookie(cookies: Map<string, string>, name: string): string {
    const value = cookies.get(name);
    if (!value) throw new Error(`WeChat OAuth callback did not provide ${name}`);
    return value;
}

export class WxLoginService {
    async createQrSession(): Promise<{ session: WxLoginSession; qr: Buffer }> {
        const cookies = new Map<string, string>();
        const params = new URLSearchParams({
            appid: OAUTH_APP_ID,
            redirect_uri: `${CALLBACK_URL}?login_type=WX`,
            response_type: 'code',
            scope: 'snsapi_login,snsapi_runtime_pcsdk',
            state: 'web',
            fast_login: '1',
            self_redirect: 'true',
        });
        const page = await request(`${QR_CONNECT_URL}?${params}`, cookies);
        if (page.status < 200 || page.status >= 300) throw new Error(`Unable to create WeChat QR session (HTTP ${page.status})`);
        const uuid = /\/connect\/qrcode\/([^"'>\s]+)/.exec(page.body.toString('utf8'))?.[1];
        if (!uuid) throw new Error('Unable to parse the WeChat QR session');
        const qr = await request(`${QR_IMAGE_BASE}${encodeURIComponent(uuid)}`, cookies);
        if (qr.status < 200 || qr.status >= 300) throw new Error(`Unable to download WeChat QR image (HTTP ${qr.status})`);
        return { session: { cookies, uuid }, qr: qr.body };
    }

    async poll(session: WxLoginSession): Promise<ScanStatus> {
        if (session.oauthCode) return 'authorized';
        const params = new URLSearchParams({ uuid: session.uuid, _: String(Date.now()) });
        const response = await request(`${QR_POLL_URL}?${params}`, session.cookies, {}, 35_000);
        if (response.status < 200 || response.status >= 300) throw new Error(`WeChat QR polling failed (HTTP ${response.status})`);
        const body = response.body.toString('utf8');
        const errcode = /wx_errcode\s*=\s*(\d+)/.exec(body)?.[1];
        if (errcode === '408') return 'waiting';
        if (errcode === '404') return 'scanned';
        if (errcode === '403') return 'cancelled';
        if (errcode === '402') return 'expired';
        if (errcode === '405') {
            const code = /wx_code\s*=\s*'([^']+)'/.exec(body)?.[1];
            if (!code) throw new Error('WeChat authorization response did not include a code');
            session.oauthCode = code;
            return 'authorized';
        }
        throw new Error('Unrecognized WeChat QR polling response');
    }

    async confirm(session: WxLoginSession): Promise<{ openid: string; accessToken: string; refreshToken: string; loginBuffer: string }> {
        if (!session.oauthCode) throw new Error('Waiting for scan authorization');
        const params = new URLSearchParams({ login_type: 'WX', code: session.oauthCode, state: 'web' });
        const callback = await request(`${CALLBACK_URL}?${params}`, session.cookies);
        if (callback.status < 200 || callback.status >= 400) throw new Error(`WeChat authorization callback failed (HTTP ${callback.status})`);
        const openid = requiredCookie(session.cookies, 'openid');
        const accessToken = requiredCookie(session.cookies, 'accesstoken');
        const refreshToken = String(session.cookies.get('refreshtoken') || '').trim();
        const loginBuffer = await this.getWxLoginBuffer(openid, accessToken);
        session.cookies.clear();
        session.openid = openid;
        session.accessToken = accessToken;
        session.refreshToken = refreshToken;
        session.loginBuffer = loginBuffer;
        return { openid, accessToken, refreshToken, loginBuffer };
    }

    /**
     * 用 refresh_token 向微信刷新 access_token（refresh_token 有效期更长，支持免扫码续期）。
     */
    async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; openid: string }> {
        const token = String(refreshToken || '').trim();
        if (!token) throw new Error('缺少 refresh_token，无法刷新微信 access_token');
        const params = new URLSearchParams({ appid: OAUTH_APP_ID, grant_type: 'refresh_token', refresh_token: token });
        const response = await request(`https://api.weixin.qq.com/sns/oauth2/refresh_token?${params}`, new Map<string, string>(), {}, 15_000);
        if (response.status < 200 || response.status >= 300) throw new Error(`Unable to refresh WeChat access token (HTTP ${response.status})`);
        const data = JSON.parse(response.body.toString('utf8'));
        if (!data || data.errcode || !String(data.access_token || '').trim()) {
            throw new Error(`WeChat access token refresh failed: ${data && data.errmsg ? data.errmsg : 'invalid response'}`);
        }
        return {
            accessToken: String(data.access_token).trim(),
            refreshToken: String(data.refresh_token || token).trim(),
            openid: String(data.openid || '').trim(),
        };
    }

    /**
     * 用 openid + accessToken 直接向 yybad 换取 loginBuffer，不依赖 OAuth session/cookie。
     * 微信 YYB loginBuffer 是一次性的：一旦换出的 code 被真实 ws 连接消费即失效，
     * 掉线重连时用它换取全新 loginBuffer 再换 code，实现免扫码续期。
     */
    async getWxLoginBuffer(openid: string, accessToken: string): Promise<string> {
        if (!String(openid || '').trim() || !String(accessToken || '').trim()) {
            throw new Error('缺少 openid 或 accessToken，无法换取微信登录缓冲');
        }
        const cookies = new Map<string, string>();
        const payload = JSON.stringify({ extInfo: { listS: { unionid: { value: [openid] }, user_id: { value: [openid] }, access_token: { value: [accessToken] } }, listI: { user_type: { value: [0] } } } });
        const timestamp = String(Date.now());
        const nonce = String(crypto.randomInt(1000, 10000));
        const signature = crypto.createHash('md5').update(`${payload}${timestamp}${LOGIN_BUFFER_ACCESS_KEY}${nonce}`).digest('hex');
        const response = await request(LOGIN_BUFFER_URL, cookies, {
            method: 'POST', body: payload,
            headers: { 'Content-Type': 'application/json', 'Ual-Access-Businessid': 'pc_yyb_auth', 'Ual-Access-Timestamp': timestamp, 'Ual-Access-Nonce': nonce, 'Ual-Access-Signature': signature },
        });
        if (response.status < 200 || response.status >= 300) throw new Error(`Unable to obtain WeChat login buffer (HTTP ${response.status})`);
        let data: any;
        try {
            data = JSON.parse(response.body.toString('utf8'));
        } catch {
            throw new Error(`WeChat login buffer response is not JSON: ${response.body.toString('utf8').slice(0, 200)}`);
        }
        const loginBuffer = data?.code === 0 ? data?.ext_info?.list_s?.login_buffer?.value?.[0] : '';
        if (typeof loginBuffer !== 'string' || !loginBuffer) {
            const code = data && data.code !== undefined ? data.code : 'n/a';
            const msg = (data && (data.msg || data.message)) || '';
            throw new Error(`WeChat login buffer response is invalid (code=${code}${msg ? `, msg=${String(msg).slice(0, 200)}` : ''})`);
        }
        return loginBuffer;
    }

    async issueCode(session: WxLoginSession, appId: string): Promise<string> {
        if (!session.loginBuffer) throw new Error('WeChat login session has not been confirmed');
        return getNativeWxLoginCode(session.loginBuffer, appId);
    }

    destroy(session: WxLoginSession): void {
        session.cookies.clear();
        session.oauthCode = undefined;
        session.openid = undefined;
        session.accessToken = undefined;
        session.refreshToken = undefined;
        session.loginBuffer = undefined;
    }
}
