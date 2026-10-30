import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadConfig } from './config';

async function bootstrap() {
  const cfg = loadConfig(); // throws when JWT_SECRET is unset
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(cfg.port);
}
bootstrap().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
