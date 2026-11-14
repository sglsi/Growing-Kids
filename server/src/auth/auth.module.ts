import { Module } from '@nestjs/common'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { QrLoginService } from './qr-login.service'
import { UsersModule } from '../users/users.module'
import { SecurityModule } from '../security/security.module'

@Module({
  imports: [UsersModule, SecurityModule],
  controllers: [AuthController],
  providers: [AuthService, QrLoginService],
})
export class AuthModule {}
