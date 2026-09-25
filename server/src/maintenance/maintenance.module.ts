import { Module } from '@nestjs/common'
import { MaintenanceService } from './maintenance.service'
import { UsersModule } from '../users/users.module'
import { StorageModule } from '../storage/storage.module'

@Module({
  imports: [UsersModule, StorageModule],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
