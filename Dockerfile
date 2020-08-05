FROM ubuntu:20.04

RUN mkdir shell-bot
RUN chmod 777 shell-bot
WORKDIR shell-bot

RUN apt -qq update -y

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Dhaka

RUN apt -qq install -y make python npm build-essential wget git
RUN git clone https://github.com/abirxox/terminal-bot.git

RUN wget https://raw.githubusercontent.com/devillD/terminal-bot/master/package.json
RUN wget https://raw.githubusercontent.com/devillD/terminal-bot/master/package-lock.json
RUN wget https://raw.githubusercontent.com/devillD/terminal-bot/master/start.sh
RUN npm install
COPY . .
CMD ["bash","start.sh"]
