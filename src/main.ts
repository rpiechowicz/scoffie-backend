import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { assertRuntimeEnv } from './config/assert-env';

async function bootstrap() {
  // Przed `NestFactory.create`: na produkcji brak sekretów ma zatrzymać start,
  // a nie wyjść dopiero jako podrabialny token przy pierwszym logowaniu.
  assertRuntimeEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const extraOrigins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const allowedOrigins = ['http://localhost:5173', ...extraOrigins];

  app.enableCors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
    exposedHeaders: ['x-access-token', 'x-request-id'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useStaticAssets(join(process.cwd(), 'public'), { prefix: '/static/' });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
