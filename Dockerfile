FROM node:20-alpine AS modules-builder
WORKDIR /workspace/server

COPY server/package.json ./
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm install && npm run build

FROM registry.heroiclabs.com/heroiclabs/nakama:3.22.0
RUN mkdir -p /nakama/data/modules/build
COPY --from=modules-builder /workspace/server/build/main.js /nakama/data/modules/build/main.js
COPY nakama-config.yml /nakama/data/nakama-config.yml

ENTRYPOINT ["/bin/sh", "-ecx"]
CMD ["/nakama/nakama migrate up --database.address ${DB_ADDRESS} && exec /nakama/nakama --name nakama1 --config /nakama/data/nakama-config.yml --database.address ${DB_ADDRESS} --socket.server_key ${NAKAMA_SERVER_KEY}"]
