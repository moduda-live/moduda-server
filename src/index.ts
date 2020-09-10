import ws from "ws";
import express from "express";
import http from "http";
import { v4 as uuidv4 } from "uuid";
import redis from "redis";

const SERVER_ID = process.env.SERVER_ID; // for horizontally scaling with docker
const SERVER_PORT = 8080;
const REDIS_HOST = "127.0.0.1";
const REDIS_PORT = 6379;

declare module "ws" {
  export class WebSocket extends ws {
    id: string;
  }
}

// express + websocket server
const app = express();
const server = http.createServer(app);
const wss = new ws.Server({ server });

// redis
const cli = redis.createClient(REDIS_PORT, REDIS_HOST);
const sub = cli.duplicate();
const pub = cli.duplicate();

sub.on("message", (channel, message) => {
  console.log(`Received message from ${channel}:  ${message}`);
});

// express endpoint
app.get("/", (_, res) => {
  res.send("Websocket server for the movens chrome extension");
});

// wss handlers
const parties = new Set<string>();

function createChannelAndSub(partyId: string) {
  parties.add(partyId);
  sub.subscribe(partyId);
}

function getUsersInParty(partyId: string, callback: (err: Error | null, res: string[]) => void) {
  cli.hvals(`${partyId}:users`, (err, res) => {
    callback(err, res);
  });
}

class User {
  userId: string;
  partyId: string;

  constructor(userId: string, partyId: string) {
    this.userId = userId;
    this.partyId = partyId;
  }
}

wss.on("connection", (socket, req) => {
  socket.id = uuidv4();
  console.log(`New user ${socket.id} connected!`);

  socket.send(
    JSON.stringify({
      type: "userId",
      payload: {
        userId: socket.id
      }
    })
  );

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data as string);
    } catch (error) {
      console.log("Malformed message from client");
      socket.send(
        JSON.stringify({
          type: "error",
          payload: { message: "Message sent was not in JSON format" }
        })
      );
    }

    switch (msg.type) {
      case "getCurrentPartyUsers": {
        const { partyId } = msg.payload;
        // 1) Subscribe to channel partyId
        createChannelAndSub(partyId);
        // 2) Get currently existing sockets and send
        getUsersInParty(partyId, (err, users) => {
          if (err) {
            console.error("Error fetching data for users");
          } else {
            console.log(`There are ${users.length} users currently in party ${partyId}`);
            socket.send(JSON.stringify({ type: "currentPartyUsers", payload: { users } }));
          }
        });
        // 3) Create User instance and save it to "partyId:participants" using hset
        const newUser = new User(socket.id, partyId);
        cli.hset(`${partyId}:users`, socket.id, JSON.stringify(newUser));
        break;
      }
      default: {
        console.log("Could not identify message type");
        socket.send(
          JSON.stringify({ type: "error", payload: { message: "Not a valid message type" } })
        );
      }
    }
  });
});

wss.on("error", (error) => {
  console.error(error);
});

server.listen(SERVER_PORT, () => {
  console.log(`Websocket server listening on port ${SERVER_PORT}`);
});
