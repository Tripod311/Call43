FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install && npm run build
ENV CALL43_PORT=8145
ENV CALL43_PASSWORD=upupaepops
EXPOSE 8145
CMD ["node", "server_dist/index.js"]