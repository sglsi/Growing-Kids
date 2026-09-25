import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * 统一将 POST 请求的 201 状态码改为 200（前端约定只用 200）。
 */
@Injectable()
export class HttpStatusInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const response = http.getResponse();
    const request = http.getRequest();

    return next.handle().pipe(
      map((data) => {
        if (request.method === 'POST' && response.statusCode === 201) {
          response.status(200);
        }
        return data;
      }),
    );
  }
}
