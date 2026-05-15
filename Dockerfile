FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm exec vue-tsc --noEmit && pnpm exec vite build --base /

FROM nginx:1.27-alpine AS runtime

RUN rm -rf /usr/share/nginx/html/*
COPY --from=builder /app/dist /usr/share/nginx/html

RUN printf '%s\n' \
    'server {' \
    '  listen 8080;' \
    '  server_name _;' \
    '  root /usr/share/nginx/html;' \
    '  index index.html;' \
    '  location / {' \
    '    try_files $uri $uri/ /index.html;' \
    '  }' \
    '  location ~* \.(?:js|css|svg|png|jpg|jpeg|gif|ico|woff2?)$ {' \
    '    expires 7d;' \
    '    add_header Cache-Control "public, immutable";' \
    '  }' \
    '  location = /healthz { return 200 "ok"; add_header Content-Type text/plain; }' \
    '}' > /etc/nginx/conf.d/default.conf

RUN sed -i 's/user  nginx;/user  nginx;\npid \/tmp\/nginx.pid;/' /etc/nginx/nginx.conf \
 && sed -i 's|/var/run/nginx.pid|/tmp/nginx.pid|' /etc/nginx/nginx.conf || true

EXPOSE 8080
USER nginx
CMD ["nginx", "-g", "daemon off;"]
