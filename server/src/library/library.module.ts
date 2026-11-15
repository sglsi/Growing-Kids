import { Module } from '@nestjs/common'
import { LibraryController } from './library.controller'
import { LibraryFolderController } from './library-folder.controller'
import { LibraryService } from './library.service'
import { LibraryFolderService } from './library-folder.service'
import { LibraryImageCombineService } from './library-image-combine.service'
import { StorageModule } from '../storage/storage.module'
import { SecurityModule } from '../security/security.module'

@Module({
  imports: [StorageModule, SecurityModule],
  controllers: [LibraryController, LibraryFolderController],
  // D-063：多图合成服务只用 StorageService + LibraryService，不引 PDF 模块，
  // 避免模块间循环依赖。
  // D-068：文件夹服务依赖 UgcTextGuard（SecurityModule）；LibraryService 只依赖
  // LibraryFolderService（后者不反向依赖 LibraryService），无循环。
  providers: [LibraryService, LibraryFolderService, LibraryImageCombineService],
  exports: [LibraryService, LibraryFolderService],
})
export class LibraryModule {}
