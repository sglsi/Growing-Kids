import {
  Controller, Get, Post, Patch, Delete, Body, Param, Req, HttpCode, BadRequestException,
} from '@nestjs/common'
import { LibraryFolderService } from './library-folder.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { LibraryFolder } from './library.types'

/**
 * D-068：资料库文件夹 CRUD。
 *
 * 🔴 刻意挂在独立的 `/api/library/folders` 前缀下，避免与 `LibraryController`
 *    的 `@Patch(':id')` / `@Delete(':id')` 抢路由（单段 :id 会吃掉 'folders'）。
 * 🔴 不进 `PUBLIC_ROUTES`：全部要求登录态，`requireUserId()` fail-closed。
 */
@Controller('library/folders')
export class LibraryFolderController {
  constructor(private readonly folders: LibraryFolderService) {}

  @Get()
  @HttpCode(200)
  async list(@Req() req: RequestWithUser) {
    const userId = requireUserId(req)
    return { code: 200, msg: 'success', data: await this.folders.list(userId) }
  }

  @Post()
  @HttpCode(200)
  async create(@Req() req: RequestWithUser, @Body() body: { name?: string; parent_id?: string | null }) {
    const userId = requireUserId(req)
    if (!body || typeof body.name !== 'string') throw new BadRequestException('缺少文件夹名称')
    return { code: 200, msg: 'success', data: await this.folders.create(userId, body.name, body.parent_id) }
  }

  @Patch(':id')
  @HttpCode(200)
  async update(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: { name?: string; parent_id?: string | null },
  ) {
    const userId = requireUserId(req)
    if (!body) throw new BadRequestException('缺少参数')
    // 只改传了的字段：改名与移动互不干扰，都不传则 400
    if (body.name === undefined && body.parent_id === undefined) {
      throw new BadRequestException('没有需要更新的字段')
    }
    let data: LibraryFolder | null = null
    if (body.name !== undefined) data = await this.folders.rename(userId, id, body.name)
    if (body.parent_id !== undefined) data = await this.folders.move(userId, id, body.parent_id)
    return { code: 200, msg: 'success', data }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    return { code: 200, msg: 'success', data: await this.folders.remove(userId, id) }
  }
}
