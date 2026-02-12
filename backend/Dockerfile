FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json eslint.config.js ./
COPY prisma ./prisma
COPY src ./src

RUN npx prisma generate
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start:docker"]
