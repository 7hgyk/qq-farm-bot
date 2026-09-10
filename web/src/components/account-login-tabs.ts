export type LoginTab = 'code' | 'wx_qr' | 'qq_qr' | 'yyb_qr'

export interface LoginTabAvailability {
  codeLogin: boolean
  wechatQrLogin: boolean
  qqQrLogin: boolean
  yybQrLogin: boolean
}

/**
 * 当前登录方式被关闭时，挑选第一个仍可用的登录页签。
 * 优先级：Code > 应用宝 > 微信扫码 > QQ扫码；全部关闭时回退到 code。
 */
export function pickAvailableLoginTab(availability: LoginTabAvailability): LoginTab {
  if (availability.codeLogin)
    return 'code'
  if (availability.yybQrLogin)
    return 'yyb_qr'
  if (availability.wechatQrLogin)
    return 'wx_qr'
  if (availability.qqQrLogin)
    return 'qq_qr'
  return 'code'
}

/** 该页签对应的登录方式是否可用。 */
export function isLoginTabEnabled(tab: LoginTab, availability: LoginTabAvailability): boolean {
  switch (tab) {
    case 'code':
      return availability.codeLogin
    case 'wx_qr':
      return availability.wechatQrLogin
    case 'qq_qr':
      return availability.qqQrLogin
    case 'yyb_qr':
      return availability.yybQrLogin
    default:
      return false
  }
}
