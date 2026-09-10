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
