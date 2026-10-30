import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { AppConfig, CONFIG } from '../config';
import { IS_PUBLIC } from './public.decorator';

export const COOKIE_NAME = 'studio_token';

/** Global guard. Swap this class when an internal SSO is chosen. */
@Injectable()
export class JwtCookieGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) throw new UnauthorizedException('로그인이 필요합니다.');
    try {
      const payload = jwt.verify(token, this.cfg.jwtSecret) as jwt.JwtPayload;
      if (typeof payload.sub !== 'string') throw new Error('no sub');
      req.user = { username: payload.sub };
      return true;
    } catch {
      throw new UnauthorizedException('로그인이 필요합니다.');
    }
  }
}
