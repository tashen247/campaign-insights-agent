FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run gen-data
ENV PORT=3000 PUBLIC_BASE_URL=http://localhost:3000
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
