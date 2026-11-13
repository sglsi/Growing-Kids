import { Module } from '@nestjs/common'
import { CurriculumController } from './curriculum.controller'
import { CurriculumService } from './curriculum.service'

/** P-028 / D-045：知识点讲解标签的只读字典出口（不参与检索链路） */
@Module({
  controllers: [CurriculumController],
  providers: [CurriculumService],
})
export class CurriculumModule {}
