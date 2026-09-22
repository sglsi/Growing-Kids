import { Module } from '@nestjs/common'
import { DocumentController } from './document.controller'
import { DocumentService } from './document.service'
import { StorageService } from '../storage/storage.service'

@Module({
  controllers: [DocumentController],
  providers: [DocumentService, StorageService],
})
export class DocumentModule {}