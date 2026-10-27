import { Module } from '@nestjs/common'
import { MaintenanceService } from './maintenance.service'
import { AccountController } from './account.controller'
import { UsersModule } from '../users/users.module'
import { StorageModule } from '../storage/storage.module'

@Module({
  imports: [UsersModule, StorageModule],
  // AccountController：账号注销（R-合规-03），与定时清理共用同一套「引用计数」释放逻辑
  controllers: [AccountController],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
