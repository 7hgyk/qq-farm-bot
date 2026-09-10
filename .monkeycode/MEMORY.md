# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### Project Knowledge Entry

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent
- Category: [Category]
- Instructions:
  - [Knowledge points]

## Deduplication Strategy

- Check for similar entries before adding; merge or skip duplicates.

## Entries

[微信应用宝(YYB)免扫码续期链路]
- Date: 2026-09-10
- Context: 排查掉线重连续期失败（GetLoginBuffer error 40188 invalid scope）
- Category: Troubleshooting & Debugging
- Instructions:
  - yybad `pcyyb_get_wx_login_buffer_auth` 接受的微信 accessToken 短时效（约十几分钟即 invalid scope 40188），但同一 token 在有效期内可多次调用。
  - 微信扫码回调(`pcyyb_oauth`)下发 cookie：openid/accesstoken/refreshtoken/expires_in/scope/appid/logintype；`refreshtoken` 已持久化到账号（refreshToken 字段）。
  - accessToken 失效时用 `https://api.weixin.qq.com/sns/oauth2/refresh_token?appid=wxd44977328b36e647&grant_type=refresh_token&refresh_token=...` 刷新，无需 appsecret；刷新后 access_token/refresh_token 均滚动更新，需回写存储。
  - loginBuffer 换出的 code 被真实 ws 登录消费后 loginBuffer 即被拒(ManualAuth rejected)，重连必须先续期。
  - 微信 refresh_token 长期有效(约30天)；过期后只能重新扫码。

[core 服务运维]
- Date: 2026-09-10
- Context: 部署预览与测试
- Category: Operations & Deployment
- Instructions:
  - core 无热重载：改 TS 后需 kill 重启后台终端 `pnpm -C core dev`（tsx client.ts，端口 3007）。
  - core 重启后账号不会自动拉起，需登录管理接口后调 `POST /api/accounts/:id/start`（登录 `POST /api/login`，默认 admin/admin，header 用 `x-admin-token`）。
  - 测试续期回退的快捷方法：用管理接口 `POST /api/accounts` 传 `{id,name,loginBuffer,accessToken}` 写入无效值即可强制走回退链（会自动重启账号），成功后凭据自愈并落库。

[仓库行尾规范]
- Date: 2026-09-10
- Context: 修复 EOL 噪声 diff
- Category: Workflow & Collaboration
- Instructions:
  - 仓库多为 CRLF/混合行尾，改文件必须最小 diff，禁止整体行尾转换；可用脚本按 `git show HEAD:<file>` 逐行恢复 EOL 校正。

[登录态彻底失效时推送二维码自动重新登录]
- Date: 2026-09-12
- Context: refresh_token 过期后无法自动续期，实现"通知推送二维码、扫码即自动恢复"
- Category: Features & Architecture
- Instructions:
  - 触发点：worker-manager `startWorkerAsync` 捕获到 `openid/accessToken 续期登录态失败: ... 微信登录态已彻底失效（refresh_token 无效/过期 ... 原始信息: invalid refresh_token）` 时，调用 runtime-engine 注入的 `requestReloginQr`（仅"彻底失效"触发，其它失败仍按原逻辑）。
  - 服务 `services/wx-login/relogin.ts`：`requestRelogin(account)` 生成微信二维码并经通知渠道推送；后台轮询当前会话，`authorized` 后自动 `confirm` → 写回 openid/accessToken/refreshToken/loginBuffer → 重启账号；二维码过期/超时则清理会话，等下次访问链接再生成新码（同一账号 request 幂等，24h 内复用）。
  - 免登录路由 `controllers/admin/relogin-routes.ts`：`GET /api/relogin/:token/qr`（JPEG 图片）与 `GET /api/relogin/:token`（极简扫码页），凭随机 token 保护；必须挂在全局 `/api` 鉴权中间件之前（`controllers/admin/index.ts` 中早于 `mountAuthRoutes`）。
  - 通知里图片只能用**外链 URL**：pushplus/微信 **不渲染** `data:image/base64` 内嵌图（这是踩过的坑）。公网地址优先 `process.env.PUBLIC_BASE_URL` / `RENDER_EXTERNAL_URL`（Render 自动注入），否则用 `recordPublicOrigin(req)` 从访问请求自动推断（过滤 localhost/内网 IP）。
  - pushplus 的 pushoo 实现写死 `template:'markdown'`，无法发 HTML；需在 `services/push.ts` 直发 `template:'html'`（`sendPushplusHtml`，支持 pushplus / pushplushxtrip），且 pushplus content 上限约 2 万字。
  - 已实测全链路：登录态失效 → 推送二维码 → 扫码 → 自动写回凭据并重启账号，全程无需登录后台。

[全局默认策略（新账号自动套用）]
- Date: 2026-09-12
- Context: 每新增账号都要手动配策略太麻烦，改为可配置全局默认
- Category: Features & Architecture
- Instructions:
  - 新账号在 `ensureAccountConfig` 里继承 `sharedState.accountFallbackConfig`（即持久化的 `globalConfig.defaultAccountConfig`），不再用硬编码的 DEFAULT_ACCOUNT_CONFIG。
  - `POST /api/settings/default`（带 `x-account-id`）把该账号的整份 AccountConfig 复制为全局默认；`GET /api/settings/default` 读取当前默认。
  - 前端：设置页「策略设置」→「设为全局默认策略」按钮（store `saveDefaultFromAccount`）。
  - 只影响新增账号，已有账号配置不变。
