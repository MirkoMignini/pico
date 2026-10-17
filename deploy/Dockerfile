FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 procps && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts pnpm@11.2.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN pnpm build && pnpm prune --prod --ignore-scripts
USER 1000:1000
ENTRYPOINT ["node", "/app/dist/cli.js", "--instance", "/data"]
CMD ["serve"]
