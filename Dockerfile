FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

COPY . .

CMD ["node", "src/index.ts"]
