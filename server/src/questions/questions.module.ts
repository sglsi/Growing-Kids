import { Module } from '@nestjs/common'
import { QuestionsController } from './questions.controller'
import { QuestionsService } from './questions.service'
import { SecurityModule } from '../security/security.module'

@Module({
  imports: [SecurityModule],
  controllers: [QuestionsController],
  providers: [QuestionsService],
  exports: [QuestionsService],
})
export class QuestionsModule {}
