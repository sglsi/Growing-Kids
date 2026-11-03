import { Module } from '@nestjs/common'
import { NetdiskController } from './netdisk.controller'
import { NetdiskSearchService } from './netdisk-search.service'
import { StorageModule } from '../storage/storage.module'

/** 百度网盘资料检索（「资料库搜题」第一顺位来源，见 netdisk-search.service 头部注释） */
@Module({
  imports: [StorageModule],
  controllers: [NetdiskController],
  providers: [NetdiskSearchService],
  exports: [NetdiskSearchService],
})
export class NetdiskModule {}
