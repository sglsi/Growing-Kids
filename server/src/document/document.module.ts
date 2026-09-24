import { Module } from '@nestjs/common'
import { DocumentController } from './document.controller'
import { DocumentService } from './document.service'
import { StorageService } from '../storage/storage.service'
import { DocumentsModule } from '../documents/documents.module'

@Module({
  imports: [DocumentsModule],
  controllers: [DocumentController],
  providers: [DocumentService, StorageService],
})
export class DocumentModule {}