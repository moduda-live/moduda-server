FROM node:15

RUN echo "Building for production..."

WORKDIR /usr/node/app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build



FROM node:15

WORKDIR /usr/node/app

COPY package*.json ./

RUN npm install --only=production

COPY --from=0 /usr/node/app/build .

# RUN npm install pm2 -g
# CMD ["pm2-runtime","app.js"]

EXPOSE 80

CMD ["node", "index.js"]
