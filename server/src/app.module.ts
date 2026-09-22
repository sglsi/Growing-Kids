import { Module } from '@nestjs/common'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { SubjectsModule } from './subjects/subjects.module'
import { QuestionsModule } from './questions/questions.module'
import { UploadModule } from './upload/upload.module'
import { OcrModule } from './ocr/ocr.module'
import { SearchModule } from './search/search.module'
import { DocumentModule } from './document/document.module'

@Module({
  imports: [
    SubjectsModule,
    QuestionsModule,
    UploadModule,
    OcrModule,
    SearchModule,
    DocumentModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
