import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { AppController } from './app.controller'
import { AppService } from './app.service'

// 基础设施
import { StorageModule } from './storage/storage.module'
import { UsersModule } from './users/users.module'
import { UserContextMiddleware } from './shared/user-context'

// 业务模块（v4：统一 timeline）
import { AuthModule } from './auth/auth.module'
import { SubjectsModule } from './subjects/subjects.module'
import { TimelineModule } from './timeline/timeline.module'
import { LibraryModule } from './library/library.module'
import { UploadModule } from './upload/upload.module'
import { ImageModule } from './image/image.module'
import { DocumentModule } from './document/document.module'
import { DocumentsModule } from './documents/documents.module'
import { PdfModule } from './pdf/pdf.module'
import { OcrModule } from './ocr/ocr.module'
import { SearchModule } from './search/search.module'
import { MaintenanceModule } from './maintenance/maintenance.module'

@Module({
  imports: [
    ScheduleModule.forRoot(),
    StorageModule,
    UsersModule,
    AuthModule,
    SubjectsModule,
    TimelineModule,
    LibraryModule,
    UploadModule,
    ImageModule,
    DocumentModule,
    DocumentsModule,
    PdfModule,
    OcrModule,
    SearchModule,
    MaintenanceModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  // 全站注入用户上下文（匿名自动创建 / 已登录按 header 识别）
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(UserContextMiddleware).forRoutes('*')
  }
}
