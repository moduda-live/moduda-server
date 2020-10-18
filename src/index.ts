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
    userId: string;
    partyId: string;
  }
}

// express + websocket server
const app = express();
const server = http.createServer(app);
const wss = new ws.Server({ server });

// holds partyId -> User map
const clients = new Map<string, Map<string, ws.WebSocket>>();

// redis
const sub = redis.createClient(REDIS_PORT, REDIS_HOST);
const pub = sub.duplicate();

sub.on("message", (channel, message) => {
  let msg;
  try {
    msg = JSON.parse(message);
  } catch (error) {
    console.log("Invalid format for message");
    return;
  }

  if (!msg.command || !msg.data) {
    console.log("Invalid format for message");
    return;
  }

  // Properly formatted now
  switch (msg.command) {
    case "redirectSignal": {
      const { senderId, username, recipientId, signal, returnSignal } = msg.data;
      if (clients.has(channel) && clients.get(channel)?.has(recipientId)) {
        const client = (clients.get(channel) as Map<string, ws.WebSocket>).get(
          recipientId
        ) as ws.WebSocket;
        client.send(
          JSON.stringify({
            type: returnSignal ? "returnedSignal" : "newForeignSignal",
            payload: {
              senderId,
              ...(!returnSignal && { username: username }),
              signal
            }
          })
        );
      }
      break;
    }
    case "broadcastMessage": {
      const { senderId, content } = msg.data;
      console.log(`senderId: ${senderId}`);
      console.log(`content: ${content}`);
      if (clients.has(channel)) {
        const localStoredUsersForParty = clients.get(channel);

        if (!localStoredUsersForParty) {
          return;
        }

        localStoredUsersForParty.forEach((value, key) => {
          console.log(`key is ${key}`);
          if (key !== senderId) {
            value.send(
              JSON.stringify({
                type: "newForeignMessage",
                payload: {
                  senderId,
                  content
                }
              })
            );
          }
        });
      }
      break;
    }
    default: {
      console.error("Invalid command");
    }
  }
});

// express endpoint
app.get("/", (_, res) => {
  res.send("Websocket server for the movens chrome extension");
});

function getUsersInParty(partyId: string, callback: (err: Error | null, res: string[]) => void) {
  pub.smembers(`${partyId}:users`, (err, res) => {
    callback(err, res);
  });
}

wss.on("connection", (socket, req) => {
  socket.userId = uuidv4();
  console.log(`New user ${socket.userId} connected!`);

  socket.send(
    JSON.stringify({
      type: "userId",
      payload: {
        userId: socket.userId
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

    console.log("Message of type " + msg.type + " received");
    switch (msg.type) {
      case "getCurrentPartyUsers": {
        const { partyId, username } = msg.payload;
        console.log(`user ${username} joined`);
        // 1) Set add socket to set of sockets by partyId
        socket.partyId = partyId;
        if (!clients.has(partyId)) {
          clients.set(partyId, new Map());
        }
        clients.get(partyId)?.set(socket.userId, socket);

        // 2) Subscribe to channel partyId
        sub.subscribe(partyId);
        // 3) Get currently existing sockets and send
        getUsersInParty(partyId, (err, users) => {
          if (err) {
            console.error("Error fetching data for users");
          } else {
            console.log(`There are ${users.length} users currently in party ${partyId}`);
            socket.send(JSON.stringify({ type: "currentPartyUsers", payload: { users } }));
            // 4) Add userId to list of users
            pub.sadd(
              `${partyId}:users`,
              JSON.stringify({
                userId: socket.userId,
                username,
                isAdmin: users.length === 0 // initialize isAdmin to true if user is creating the party
              })
            );
          }
        });
        break;
      }
      case "newSignal": {
        const { senderId, username, recipientId, signal } = msg.payload;
        pub.publish(
          socket.partyId,
          JSON.stringify({
            command: "redirectSignal",
            data: {
              senderId,
              username,
              recipientId,
              signal,
              returnSignal: false
            }
          })
        );
        break;
      }
      case "returnSignal": {
        const { senderId, recipientId, signal } = msg.payload;
        pub.publish(
          socket.partyId,
          JSON.stringify({
            command: "redirectSignal",
            data: {
              senderId,
              recipientId,
              signal,
              returnSignal: true
            }
          })
        );
        break;
      }
      case "broadcastMessage": {
        pub.publish(
          socket.partyId,
          JSON.stringify({
            command: "broadcastMessage",
            data: msg.payload
          })
        );
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
