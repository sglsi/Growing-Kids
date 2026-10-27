import { BadRequestException, Body, Controller, Get, HttpCode, Patch, Post, Query, Req } from '@nestjs/common'
import { AuthService } from './auth.service'
import { QrLoginService } from './qr-login.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import { signAuthToken } from '../shared/auth-token'
import type { LoginDto, QrAuthorizeDto, UpdateProfileDto } from './auth.types'

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly qrLoginService: QrLoginService,
  ) {}

  /**
   * 微信登录
   * 前端：wx.login() 拿 code → POST 到这里（附带 anonymous_id 以便迁移匿名数据）
   * 返回：{ user, migrated }，前端把 user.id 存为 X-User-Id 用于后续请求
   *
   * deviceId 取中间件透传的 X-Device-Id：① 正式账号绑定设备（本地身份丢失
   * 也能找回）；② 设备名下历史遗留匿名号一并迁移（思傅 2026-10-20 反馈
   * 「分类没迁全」的根因——丢过 gk_user_id 的匿名号没被覆盖到）。
   */
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: RequestWithUser) {
    const data = await this.authService.login(dto.code, dto.anonymous_id, {
      nickname: dto.nickname,
      avatar_url: dto.avatar_url,
    }, req.deviceId)
    // 一并签发身份令牌：前端存下来，后续请求带 X-Auth-Token（防伪造身份头）
    const token = signAuthToken(data.user.id)
    return { code: 200, msg: 'success', data: token ? { ...data, auth_token: token } : data }
  }

  /**
   * 匿名身份引导（2026-10-27 严格令牌化的配套入口）。
   *
   * 为什么需要：严格模式下业务请求只认 `X-Auth-Token`，而首次启动的小程序
   * 手上还没有令牌。前端此时发一个请求会拿到 401 + `reason=NEED_AUTH_TOKEN`
   * ⇒ 调本端点，用 `X-Device-Id` 换一张令牌（同一设备永远是同一匿名身份），
   * 再重放原请求。
   *
   * 为什么不在中间件里「顺手建号」：那等于把鉴权缺口留在所有业务路由上；
   * 收敛成一个显式端点后，「谁能凭空获得身份」这件事只有一处、可审计。
   */
  @Post('anonymous')
  @HttpCode(200)
  async anonymous(@Req() req: RequestWithUser) {
    if (!req.userId) {
      throw new BadRequestException('缺少 X-Device-Id，无法建立匿名身份')
    }
    const token = signAuthToken(req.userId)
    return {
      code: 200,
      msg: 'success',
      data: { user_id: req.userId, is_anonymous: !!req.isAnonymous, auth_token: token },
    }
  }

  /** 当前用户（前端启动时可用 X-User-Id 校验身份是否有效） */
  @Get('me')
  @HttpCode(200)
  async me(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    const data = await this.authService.me(userId)
    return { code: 200, msg: 'success', data }
  }

  /** 更新昵称 / 头像 */
  @Patch('profile')
  @HttpCode(200)
  async updateProfile(@Req() req: RequestWithUser, @Body() dto: UpdateProfileDto) {
    const userId = requireUserId(req)
    const data = await this.authService.updateProfile(userId, dto)
    return { code: 200, msg: 'success', data }
  }

  /** 退出登录（前端清除本地 X-User-Id 即可，服务端无状态） */
  @Post('logout')
  @HttpCode(200)
  async logout() {
    const data = await this.authService.logout()
    return { code: 200, msg: 'success', data }
  }

  // ------------------------------------------------------------
  // H5 扫码登录（思傅 2026-10-20 拍板）：电脑浏览器无 wx.login，
  // H5 出二维码 → 手机微信扫码授权 → 两端同一 openid 账号。
  // ------------------------------------------------------------

  /** 创建扫码票据（H5 未登录时调用，返回 token 拼落地 URL 画二维码） */
  @Post('qr-login/ticket')
  @HttpCode(200)
  async createQrTicket() {
    const data = this.qrLoginService.createTicket()
    return { code: 200, msg: 'success', data }
  }

  /** 查询票据状态（H5 轮询，约 1.5s 一次）；authorized 时附带 user 供落本地身份 */
  @Get('qr-login/status')
  @HttpCode(200)
  async qrTicketStatus(@Query('token') token: string) {
    const data = await this.qrLoginService.getStatus(token || '')
    return { code: 200, msg: 'success', data }
  }

  /** 手机端授权（扫码落地页：wx.login 拿 code 后调用） */
  @Post('qr-login/authorize')
  @HttpCode(200)
  async authorizeQrTicket(@Body() dto: QrAuthorizeDto, @Req() req: RequestWithUser) {
    const data = await this.qrLoginService.authorize(dto.token, dto.code, dto.anonymous_id, req.deviceId)
    const token = data?.user?.id ? signAuthToken(data.user.id) : ''
    return { code: 200, msg: 'success', data: token ? { ...data, auth_token: token } : data }
  }
}
