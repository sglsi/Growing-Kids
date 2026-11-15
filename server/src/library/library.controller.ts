import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, HttpCode, BadRequestException,
} from '@nestjs/common'
import { LibraryService } from './library.service'
import { LibraryImageCombineService } from './library-image-combine.service'
import { requireUserId, type RequestWithUser } from '../shared/user-context'
import type { CreateLibraryDocDto } from './library.types'

interface IdsBody { ids?: string[] }

@Controller('library')
export class LibraryController {
  constructor(
    private readonly libraryService: LibraryService,
    private readonly imageCombineService: LibraryImageCombineService,
  ) {}

  @Get()
  @HttpCode(200)
  async list(
    @Req() req: RequestWithUser,
    @Query('subject_id') subjectId?: string,
    @Query('keyword') keyword?: string,
    /** 按年级检索（`P-005`）：本年级优先，0 命中才扩散；不传 = 不按年级过滤 */
    @Query('grade') grade?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    const userId = requireUserId(req)
    const data = await this.libraryService.list(userId, {
      subject_id: subjectId, keyword,
      grade: grade ? Number(grade) : undefined,
      page: page ? Number(page) : 1,
      page_size: pageSize ? Number(pageSize) : 20,
    })
    data.list = await this.libraryService.withUrls(data.list)
    return { code: 200, msg: 'success', data }
  }

  @Post()
  @HttpCode(200)
  async create(@Req() req: RequestWithUser, @Body() dto: CreateLibraryDocDto) {
    const userId = requireUserId(req)
    const doc = await this.libraryService.create(userId, dto)
    const [withUrl] = await this.libraryService.withUrls([doc])
    return { code: 200, msg: 'success', data: withUrl }
  }

  /**
   * D-063：多张图片按给定顺序合成**一份一图一页的 PDF**，只归档成品到资料库。
   *
   * `keys` 必须是本链路 `purpose=temp` 上传返回的对象 key，**数组顺序就是 PDF 页序**；
   * 临时图不建条目、由孤儿 GC 回收，不会在资料库/收件箱多出 N 条原图。
   */
  @Post('combine-images')
  @HttpCode(200)
  async combineImages(
    @Req() req: RequestWithUser,
    @Body() body: { keys?: string[]; name?: string },
  ) {
    const userId = requireUserId(req)
    if (!body || !Array.isArray(body.keys)) throw new BadRequestException('keys 必须是数组')
    const data = await this.imageCombineService.combine(userId, body.keys, body.name)
    return { code: 200, msg: 'success', data }
  }

  @Post('index-text')
  @HttpCode(200)
  async indexText(
    @Req() req: RequestWithUser,
    @Body() body: { force?: boolean; limit?: number },
  ) {
    const userId = requireUserId(req)
    const data = await this.libraryService.reindexText(userId, {
      force: body?.force === true,
      limit: Math.min(200, Number(body?.limit) || 50),
    })
    return { code: 200, msg: 'success', data }
  }

  @Patch(':id')
  @HttpCode(200)
  async update(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() body: { name?: string; subject_id?: string | null; grade?: number | null },
  ) {
    const userId = requireUserId(req)
    const data = await this.libraryService.update(userId, id, {
      name: body?.name,
      subject_id: body?.subject_id,
      grade: body?.grade,
    })
    return { code: 200, msg: 'success', data }
  }

  @Post('batch-delete')
  @HttpCode(200)
  async batchDelete(@Req() req: RequestWithUser, @Body() body: IdsBody) {
    const userId = requireUserId(req)
    if (!body || !Array.isArray(body.ids)) throw new BadRequestException('ids 必须是数组')
    const data = await this.libraryService.removeMany(userId, body.ids)
    return { code: 200, msg: 'success', data }
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    const userId = requireUserId(req)
    const data = await this.libraryService.remove(userId, id)
    return { code: 200, msg: 'success', data }
  }
}
