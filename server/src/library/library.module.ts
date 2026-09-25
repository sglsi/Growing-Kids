import { Module } from '@nestjs/common'
import { LibraryController } from './library.controller'
import { LibraryService } from './library.service'
import { StorageModule } from '../storage/storage.module'

@Module({
  imports: [StorageModule],
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
