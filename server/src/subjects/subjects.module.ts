import { Module } from '@nestjs/common'
import { SubjectsController } from './subjects.controller'
import { SubjectsService } from './subjects.service'
import { SecurityModule } from '../security/security.module'

@Module({
  imports: [SecurityModule],
  controllers: [SubjectsController],
  providers: [SubjectsService],
  exports: [SubjectsService],
})
export class SubjectsModule {}
