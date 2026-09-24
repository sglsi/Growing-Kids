import { Module } from '@nestjs/common'
import { PdfController } from './pdf.controller'
import { PdfService } from './pdf.service'
import { StorageService } from '../storage/storage.service'
import { MaterialsModule } from '../materials/materials.module'
import { DocumentsModule } from '../documents/documents.module'

@Module({
  imports: [MaterialsModule, DocumentsModule],
  controllers: [PdfController],
  providers: [PdfService, StorageService],
})
export class PdfModule {}