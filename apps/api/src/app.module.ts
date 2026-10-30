import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtCookieGuard } from './auth/jwt-cookie.guard';
import { CoreModule } from './core.module';
import { JobsModule } from './jobs/jobs.module';
import { RetentionModule } from './retention/retention.module';

@Module({
  imports: [CoreModule, AuthModule, JobsModule, RetentionModule],
  providers: [{ provide: APP_GUARD, useClass: JwtCookieGuard }],
})
export class AppModule {}
