import ws from "ws";
import express from "express";
import http from "http";
import { v4 as uuidv4 } from "uuid";
import redis from "redis";
import { getUsersInParty, addUser, getUser, removeUser } from "./service/users";
import { assert } from "console";

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

function relayMessageToUsersInPartyExcept(
  partyId: string,
  excludeUserId: string,
  msgType: string,
  data: any
) {
  if (clients.has(partyId)) {
    const localStoredUsersForParty = clients.get(partyId);

    if (localStoredUsersForParty) {
      localStoredUsersForParty.forEach((peer, id) => {
        if (id !== excludeUserId) {
          peer.send(
            JSON.stringify({
              type: msgType,
              payload: {
                ...data
              }
            })
          );
        }
      });
    }
  }
}

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
      relayMessageToUsersInPartyExcept(channel, msg.data.senderId, "newForeignMessage", msg.data);
      break;
    }
    case "setUserMute": {
      relayMessageToUsersInPartyExcept(channel, msg.data.userId, msg.command, msg.data);
      break;
    }
    case "timeUpdate": {
      relayMessageToUsersInPartyExcept(channel, msg.data.userId, msg.command, msg.data);
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

function broadcast(partyId: string, command: string, payload: any) {
  pub.publish(
    partyId,
    JSON.stringify({
      command,
      data: payload
    })
  );
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

  socket.on("close", async () => {
    // remove user represented by the closed socket from party locally
    clients.get(socket.partyId)?.delete(socket.userId);
    // delete from redis
    removeUser(pub, socket.partyId, socket.userId);

    const partyEmpty = clients.get(socket.partyId)?.size === 0;

    if (partyEmpty) {
      // do nothing else if party is empty
      return;
    }

    const remainingUserIds = Array.from(clients.get(socket.partyId)?.keys() ?? []);
    const remainingUsers = await Promise.all(
      remainingUserIds.map((id) => getUser(pub, socket.partyId, id))
    );
    assert(remainingUsers.length > 0, "Number of users remaining in the party is more than 0");

    const isThereRoomOwner = remainingUsers.some((user) => user.isOwner);
    if (isThereRoomOwner) {
      // the room owner is by definition also an admin so no need to worry, let's return
      return;
    }

    // the previous room owner just left the party, let's assign a new room owner
    const remainingAdmins = remainingUsers.filter((user) => user.isAdmin === "true");

    let randomAdmin: { [key: string]: string };

    if (remainingAdmins.length > 0) {
      // there are admins left, let's pick one of them for new room ownership
      randomAdmin = remainingAdmins[Math.floor(Math.random() * remainingAdmins.length)];
    } else {
      randomAdmin = remainingUsers[Math.floor(Math.random() * remainingUsers.length)];
    }

    remainingUsers.forEach((user) => {
      const peer = clients.get(socket.partyId)?.get(user.userId);
      peer?.send(
        JSON.stringify({
          type: "promoteToRoomOwner",
          payload: {
            userId: randomAdmin.userId,
            username: randomAdmin.username
          }
        })
      );
    });
  });

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
        // 1) Set add socket to set of sockets by partyId
        socket.partyId = partyId;
        if (!clients.has(partyId)) {
          clients.set(partyId, new Map());
        }
        clients.get(partyId)?.set(socket.userId, socket);

        // 2) Subscribe to channel partyId
        sub.subscribe(partyId);
        // 3) Get currently existing sockets and send
        getUsersInParty(pub, partyId)
          .then((users) => {
            console.log(`There are ${users.length} users currently in party ${partyId}`);
            console.log("users info: ", users);
            socket.send(JSON.stringify({ type: "currentPartyUsers", payload: { users } }));
            // 4) Add joining user to redis
            const isUserCreatingRoom = users.length === 0 ? "true" : "false";
            const joiningUser = {
              userId: socket.userId,
              username,
              isAdmin: isUserCreatingRoom,
              isRoomOwner: isUserCreatingRoom
            };
            addUser(pub, partyId, joiningUser);
          })
          .catch(() => {
            console.error("Error fetching data for users");
          });
        break;
      }
      case "newSignal": {
        const data = {
          ...msg.payload,
          returnSignal: false
        };
        broadcast(socket.partyId, "redirectSignal", data);
        break;
      }
      case "returnSignal": {
        const data = {
          ...msg.payload,
          returnSignal: true
        };
        broadcast(socket.partyId, "redirectSignal", data);
        break;
      }
      case "broadcastMessage": {
        broadcast(socket.partyId, "broadcastMessage", msg.payload);
        break;
      }
      case "setUserMute": {
        const data = {
          ...msg.payload,
          userId: socket.userId
        };
        broadcast(socket.partyId, "setUserMute", data);
        break;
      }
      case "timeUpdate": {
        const data = {
          ...msg.payload,
          userId: socket.userId
        };
        broadcast(socket.partyId, "timeUpdate", data);
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

wss.on("close", () => {
  // TODO: Cleanup?
});

server.listen(SERVER_PORT, () => {
  console.log(`Websocket server listening on port ${SERVER_PORT}`);
});
