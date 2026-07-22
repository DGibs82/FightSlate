FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run db:generate
ENV PORT=8787
EXPOSE 8787
CMD ["npm","start"]
