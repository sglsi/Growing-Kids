import { Module } from '@nestjs/common'
import { MemoryController } from './memory.controller'
import { MemoryService } from './memory.service'
import { StorageModule } from '../storage/storage.module'
import { SecurityModule } from '../security/security.module'

@Module({
  imports: [StorageModule, SecurityModule],
  controllers: [MemoryController],
  providers: [MemoryService],
})
export class MemoryModule {}