import { Module } from '@nestjs/common'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { QrLoginService } from './qr-login.service'
import { UsersModule } from '../users/users.module'

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [AuthService, QrLoginService],
})
export class AuthModule {}
