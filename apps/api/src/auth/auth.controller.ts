import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { AppConfig, CONFIG } from '../config';
import { COOKIE_NAME } from './jwt-cookie.guard';
import { Public } from './public.decorator';

const TWELVE_HOURS_S = 12 * 60 * 60;
// Compared when the user is unknown so response time does not reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);
export const LOGIN_FAILED = '아이디 또는 비밀번호가 맞지 않습니다.';

@Controller('auth')
export class AuthController {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  private cookieOpts() {
    return { httpOnly: true, sameSite: 'lax' as const, secure: this.cfg.cookieSecure, path: '/' };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: any, @Res({ passthrough: true }) res: any) {
    const username = typeof body?.username === 'string' ? body.username : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const hash = this.cfg.users.get(username);
    const ok = await bcrypt.compare(password, hash ?? DUMMY_HASH);
    if (!hash || !ok) throw new UnauthorizedException(LOGIN_FAILED);
    const token = jwt.sign({ sub: username }, this.cfg.jwtSecret, { expiresIn: TWELVE_HOURS_S });
    res.cookie(COOKIE_NAME, token, { ...this.cookieOpts(), maxAge: TWELVE_HOURS_S * 1000 });
    return { username };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: any) {
    res.clearCookie(COOKIE_NAME, this.cookieOpts());
    return { ok: true };
  }

  @Get('me')
  me(@Req() req: any) {
    return { username: req.user.username };
  }
}
