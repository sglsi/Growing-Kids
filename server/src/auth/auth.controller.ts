import { Body, Controller, Get, HttpCode, Patch, Post, Req } from '@nestjs/common'
import { AuthService } from './auth.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { LoginDto, UpdateProfileDto } from './auth.types'

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * 微信登录
   * 前端：wx.login() 拿 code → POST 到这里（附带 anonymous_id 以便迁移匿名数据）
   * 返回：{ user, migrated }，前端把 user.id 存为 X-User-Id 用于后续请求
   */
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    const data = await this.authService.login(dto.code, dto.anonymous_id, {
      nickname: dto.nickname,
      avatar_url: dto.avatar_url,
    })
    return { code: 200, msg: 'success', data }
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
}
