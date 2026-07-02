FROM node:20-bookworm-slim
WORKDIR /app

# Install deps (better-sqlite3 needs build tooling if no prebuilt binary matches)
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Build the frontend
COPY . .
RUN npm run build

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "run", "gateway"]
