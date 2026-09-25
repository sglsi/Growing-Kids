import { Module } from '@nestjs/common'
import { DocumentController } from './document.controller'
import { DocumentService } from './document.service'
import { StorageModule } from '../storage/storage.module'
import { DocumentsModule } from '../documents/documents.module'

@Module({
  imports: [StorageModule, DocumentsModule],
  controllers: [DocumentController],
  providers: [DocumentService],
})
export class DocumentModule {}
