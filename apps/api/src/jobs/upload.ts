import { BadRequestException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import multer from 'multer';
import * as path from 'path';
import { ALLOWED_EXT, Storage } from './storage';

export const MSG_BAD_EXT = 'mp4, mov, mkv, webm 파일만 올릴 수 있습니다.';
export const MSG_TOO_LARGE = '파일이 너무 큽니다. 2GB 이하 파일만 올릴 수 있습니다.';
export const MSG_NO_FILE = '업로드할 파일을 선택해 주세요.';

export interface Received {
  jobId: string;
  filename: string;
}

/** busboy reports non-ASCII filenames as latin1; recover UTF-8 when that round-trips cleanly. */
function fixName(name: string): string {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  const looksMojibake = /[\u0080-ÿ]/.test(name) && !utf8.includes('�');
  const out = looksMojibake ? utf8 : name;
  return path.basename(out.replace(/\\/g, '/')).slice(0, 255);
}

/**
 * Streams the multipart `file` straight into DATA_DIR/jobs/{id}/original.{ext} (multer diskStorage).
 * On any failure the job directory is removed so no orphan is left.
 */
export function receiveUpload(req: any, res: any, storage: Storage, maxBytes: number): Promise<Received> {
  const jobId = randomUUID();
  const storageEngine = multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = storage.jobDir(jobId);
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename: (_req, file, cb) => cb(null, `original${path.extname(file.originalname).toLowerCase()}`),
  });
  const upload = multer({
    storage: storageEngine,
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(fixName(file.originalname)).toLowerCase();
      if (!ALLOWED_EXT.includes(ext)) return cb(new BadRequestException(MSG_BAD_EXT));
      cb(null, true);
    },
  }).single('file');

  return new Promise((resolve, reject) => {
    const fail = (err: unknown) => {
      storage.removeDir(jobId);
      if (err instanceof HttpException) return reject(err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return reject(new PayloadTooLargeException(MSG_TOO_LARGE));
        return reject(new BadRequestException(MSG_NO_FILE));
      }
      reject(new BadRequestException('업로드를 처리하지 못했습니다. 다시 시도해 주세요.'));
    };
    // Client dropped mid-upload: multer may never call back, so clean up here as well.
    req.once('aborted', () => storage.removeDir(jobId));
    upload(req, res, (err: unknown) => {
      if (err) return fail(err);
      if (!req.file) return fail(new BadRequestException(MSG_NO_FILE));
      resolve({ jobId, filename: fixName(req.file.originalname) });
    });
  });
}
