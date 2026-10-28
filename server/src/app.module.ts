import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { AppController } from './app.controller'
import { AppService } from './app.service'

// 基础设施
import { StorageModule } from './storage/storage.module'
import { UsersModule } from './users/users.module'
import { SettingsModule } from './settings/settings.module'
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
import { AnswerSearchModule } from './answer-search/answer-search.module'
import { MaintenanceModule } from './maintenance/maintenance.module'
import { QuotaModule } from './quota/quota.module'
import { MemoryModule } from './memory/memory.module'
import { ChatModule } from './chat/chat.module'
// v3 遗留模块：此前漏注册导致 /api/questions、/api/materials 全部 404
// （2026-10-19 补注册，同时补齐 user_id 隔离）
import { QuestionsModule } from './questions/questions.module'
import { MaterialsModule } from './materials/materials.module'
import { JobsModule } from './jobs/jobs.module'

@Module({
  imports: [
    ScheduleModule.forRoot(),
    StorageModule,
    UsersModule,
    SettingsModule, // 用户设置：AI 外发开关（R-合规-02）
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
    AnswerSearchModule, // 题目答案：联网搜索为主 + 大模型兜底
    MaintenanceModule,
    QuotaModule, // 策略 6：配额
    MemoryModule, // 成长记忆
    ChatModule, // 智能客服
    QuestionsModule, // 题目（v3 遗留，2026-10-19 补注册 + 补用户隔离）
    MaterialsModule, // 素材（v3 遗留，同上）
    JobsModule, // 异步任务（R-上线-01：长任务提交+轮询，绕开微信 60s 超时天花板）
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
