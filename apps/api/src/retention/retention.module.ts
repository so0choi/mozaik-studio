import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { RetentionService } from './retention.service';

@Module({ imports: [JobsModule], providers: [RetentionService] })
export class RetentionModule {}
