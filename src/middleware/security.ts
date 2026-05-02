import helmet from 'helmet';
import type { Express } from '../types';

export function applySecurity(app: Express): void {
  const helmetMiddleware = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://unpkg.com"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://api.fontshare.com"],
        fontSrc: ["'self'", 'data:', "https://fonts.gstatic.com", "https://api.fontshare.com", "https://cdn.fontshare.com"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", "https://unpkg.com"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false
  });

  app.use(helmetMiddleware);
}
