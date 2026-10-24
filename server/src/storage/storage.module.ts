import { Module } from '@nestjs/common'
import { StorageService } from './storage.service'
import { BlobService } from './blob.service'
import { IngestService } from './ingest.service'
import { TierStatsService } from './tier-stats.service'
import { BaiduNetdiskService } from './baidu-netdisk.service'
import { StorageController } from './storage.controller'

@Module({
  controllers: [StorageController],
  providers: [StorageService, BlobService, IngestService, TierStatsService, BaiduNetdiskService],
  exports: [StorageService, BlobService, IngestService, TierStatsService, BaiduNetdiskService],
})
export class StorageModule {}
