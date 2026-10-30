import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';

/** Shared by main.ts and the e2e tests so they exercise the same pipeline. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  (app as any).useBodyParser?.('json', { limit: '10mb' });
}
