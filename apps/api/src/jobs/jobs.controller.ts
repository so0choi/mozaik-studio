import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Req, Res } from '@nestjs/common';
import * as fs from 'fs';
import { JobsService } from './jobs.service';
import { receiveUpload } from './upload';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  async create(@Req() req: any, @Res({ passthrough: true }) res: any) {
    const { jobId, filename } = await receiveUpload(req, res, this.jobs.storage, this.jobs.cfg.maxUploadBytes);
    return this.jobs.create(req.user.username, jobId, filename);
  }

  @Get()
  list(@Req() req: any) {
    return this.jobs.list(req.user.username);
  }

  @Get(':id')
  get(@Req() req: any, @Param('id') id: string) {
    return this.jobs.toJob(this.jobs.getOwned(id, req.user.username));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Req() req: any, @Param('id') id: string) {
    this.jobs.getOwned(id, req.user.username);
    this.jobs.removeJob(id);
  }

  @Get(':id/video')
  video(@Req() req: any, @Res() res: any, @Param('id') id: string) {
    this.jobs.getOwned(id, req.user.username);
    streamWithRange(req, res, this.jobs.videoPath(id, 'normalized.mp4'));
  }

  @Get(':id/tracks')
  tracks(@Req() req: any, @Param('id') id: string) {
    this.jobs.getOwned(id, req.user.username);
    return this.jobs.jsonFile(id, 'tracks');
  }

  @Get(':id/review')
  review(@Req() req: any, @Param('id') id: string) {
    this.jobs.getOwned(id, req.user.username);
    return this.jobs.jsonFile(id, 'review');
  }

  @Get(':id/meta')
  meta(@Req() req: any, @Param('id') id: string) {
    this.jobs.getOwned(id, req.user.username);
    return this.jobs.jsonFile(id, 'meta');
  }

  @Get(':id/thumbs/:name')
  thumb(@Req() req: any, @Res() res: any, @Param('id') id: string, @Param('name') name: string) {
    this.jobs.getOwned(id, req.user.username);
    const p = this.jobs.thumbPath(id, name);
    res.type('image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(p).pipe(res);
  }

  @Get(':id/edits')
  getEdits(@Req() req: any, @Param('id') id: string) {
    this.jobs.getOwned(id, req.user.username);
    return this.jobs.getEdits(id);
  }

  @Put(':id/edits')
  putEdits(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    this.jobs.getOwned(id, req.user.username);
    return this.jobs.putEdits(id, body);
  }

  @Post(':id/render')
  @HttpCode(202)
  async render(@Req() req: any, @Param('id') id: string) {
    this.jobs.getOwned(id, req.user.username);
    await this.jobs.requestRender(id);
    return { ok: true };
  }

  @Get(':id/output')
  async output(@Req() req: any, @Res() res: any, @Param('id') id: string) {
    const row = this.jobs.getOwned(id, req.user.username);
    if (await this.jobs.renderPending(id)) throw new NotFoundException('렌더가 끝나지 않았습니다.');
    res.download(this.jobs.videoPath(id, 'output.mp4'), this.jobs.outputName(row));
  }

  @Post(':id/manual')
  @HttpCode(202)
  async manual(@Req() req: any, @Param('id') id: string, @Body() body: unknown) {
    this.jobs.getOwned(id, req.user.username);
    await this.jobs.requestManual(id, body);
    return { ok: true };
  }

  @Get(':id/manual/:mid')
  manualStatus(@Req() req: any, @Param('id') id: string, @Param('mid') mid: string) {
    this.jobs.getOwned(id, req.user.username);
    return this.jobs.manualStatus(id, mid);
  }
}

function streamWithRange(req: any, res: any, file: string) {
  const size = fs.statSync(file).size;
  res.set('Accept-Ranges', 'bytes');
  res.type('video/mp4');
  const header: string | undefined = req.headers.range;
  if (!header) {
    res.set('Content-Length', String(size));
    fs.createReadStream(file).pipe(res);
    return;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  let start = NaN;
  let end = NaN;
  if (m && (m[1] || m[2])) {
    if (m[1] === '') {
      const n = Number(m[2]);
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.status(416).set('Content-Range', `bytes */${size}`).end();
    return;
  }
  res.status(206);
  res.set('Content-Range', `bytes ${start}-${end}/${size}`);
  res.set('Content-Length', String(end - start + 1));
  fs.createReadStream(file, { start, end }).pipe(res);
}
