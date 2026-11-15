import { Module } from '@nestjs/common'
import { LibraryController } from './library.controller'
import { LibraryService } from './library.service'
import { LibraryImageCombineService } from './library-image-combine.service'
import { StorageModule } from '../storage/storage.module'

@Module({
  imports: [StorageModule],
  controllers: [LibraryController],
  // D-063：多图合成服务只用 StorageService + LibraryService，不引 PDF 模块，
  // 避免模块间循环依赖。
  providers: [LibraryService, LibraryImageCombineService],
  exports: [LibraryService],
})
export class LibraryModule {}
