FROM node:24-alpine AS base

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN npm install -g pnpm@latest


FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches

RUN pnpm install --frozen-lockfile


FROM dependencies AS build

COPY . .

RUN APP_SECRET=build-only-secret \
    APP_URL=http://localhost:3000 \
    DATABASE_URL=postgres://stoat:stoat@db:5432/stoat \
    pnpm run build


FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

RUN apk add --no-cache ca-certificates git \
    && addgroup -S stoat \
    && adduser -S -G stoat stoat \
    && mkdir -p /app/data \
    && chown stoat:stoat /app/data

COPY --from=build --chown=stoat:stoat /app/build ./build
COPY --from=build --chown=stoat:stoat /app/package.json ./package.json
COPY --from=build --chown=stoat:stoat /app/node_modules ./node_modules
COPY --from=build --chown=stoat:stoat /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build --chown=stoat:stoat /app/drizzle ./drizzle

USER stoat

EXPOSE 3000

CMD ["node", "build"]
