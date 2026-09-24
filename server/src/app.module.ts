import { Module } from '@nestjs/common'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { SubjectsModule } from './subjects/subjects.module'
import { QuestionsModule } from './questions/questions.module'
import { UploadModule } from './upload/upload.module'
import { OcrModule } from './ocr/ocr.module'
import { SearchModule } from './search/search.module'
import { DocumentModule } from './document/document.module'
import { MaterialsModule } from './materials/materials.module'
import { ImageModule } from './image/image.module'
import { PdfModule } from './pdf/pdf.module'

@Module({
  imports: [
    SubjectsModule,
    QuestionsModule,
    UploadModule,
    OcrModule,
    SearchModule,
    DocumentModule,
    MaterialsModule,
    ImageModule,
    PdfModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
