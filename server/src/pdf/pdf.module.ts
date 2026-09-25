import { Module } from '@nestjs/common'
import { PdfController } from './pdf.controller'
import { PdfService } from './pdf.service'
import { StorageModule } from '../storage/storage.module'
import { TimelineModule } from '../timeline/timeline.module'
import { DocumentsModule } from '../documents/documents.module'

@Module({
  imports: [StorageModule, TimelineModule, DocumentsModule],
  controllers: [PdfController],
  providers: [PdfService],
})
export class PdfModule {}
