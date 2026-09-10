export {};
/**
 * 重新扫码登录的免登录路由：
 * 二维码图片与扫码页通过随机 token 保护，供微信/手机直接访问（无需后台登录）。
 * 必须挂载在全局 /api 鉴权中间件之前。
 */

import type { Application, Request, Response } from 'express';

const { getReloginQr, getReloginRequest } = require('../../services/wx-login/relogin');

function renderPage(token: string): string {
    const ts = Date.now();
    return [
        '<!doctype html>',
        '<html lang="zh-CN"><head><meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width,initial-scale=1" />',
        '<title>微信重新登录</title></head>',
        '<body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;text-align:center;padding:24px">',
        '<h3>请用微信扫描下方二维码</h3>',
        `<p><img src="/api/relogin/${token}/qr?t=${ts}" style="width:260px;height:260px;border:1px solid #eee" alt="登录二维码" /></p>`,
        '<p style="color:#888;font-size:13px">扫码成功后会自动完成登录并重启账号，可关闭本页。二维码过期后刷新本页即为新码。</p>',
        '</body></html>',
    ].join('');
}

function mountReloginRoutes(app: Application): void {
    app.get('/api/relogin/:token/qr', async (req: Request, res: Response) => {
        const token = String(req.params.token || '');
        if (!getReloginRequest(token)) return res.status(404).type('text/plain').send('relogin link expired');
        try {
            const entry = await getReloginQr(token);
            if (!entry || !entry.qr) return res.status(404).type('text/plain').send('qr unavailable');
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.type('jpeg').send(entry.qr);
        } catch (error: any) {
            res.status(502).type('text/plain').send(String((error && error.message) || error));
        }
    });

    app.get('/api/relogin/:token', async (req: Request, res: Response) => {
        const token = String(req.params.token || '');
        if (!getReloginRequest(token)) return res.status(404).type('text/plain').send('relogin link expired');
        try {
            const entry = await getReloginQr(token);
            if (!entry || !entry.qr) return res.status(404).type('text/plain').send('qr unavailable');
            res.set('Cache-Control', 'no-store');
            res.type('html').send(renderPage(token));
        } catch (error: any) {
            res.status(502).type('text/plain').send(String((error && error.message) || error));
        }
    });
}

module.exports = { mountReloginRoutes };
