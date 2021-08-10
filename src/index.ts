import ws from "ws";
import express, { Request, Response } from "express";
import http from "http";
import { v4 as uuidv4 } from "uuid";
import redis from "redis";
import { getUsersInParty, addUser, removeUser, updateUser, User } from "./service/users";
import { assert } from "console";
import path from "path";

const SERVER_ID = process.env.SERVER_ID || 1; // for horizontal scaling, unused atm
const SERVER_PORT = process.env.PORT || 8080;
const REDIS_HOST = "redis"; // "127.0.0.1";
const REDIS_PORT = 6379;

declare module "ws" {
  export class WebSocket extends ws {
    userId: string;
    partyId: string;
  }
}

// express + websocket server
const app = express();
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new ws.Server({ server });

// website
app.get("/", (_, res) => {
  res.render("index");
});

// room join page
app.get("/join", (req: Request, res: Response) => {
  const redirectUrl = req.query.redirectUrl;
  const partyId = req.query.partyId;
  res.render("join", { redirectUrl, partyId });
});

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
  if (!clients.has(channel)) return;

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
      const { userId, username, recipientId, signal, returnSignal } = msg.data;
      if (clients.get(channel)?.has(recipientId)) {
        const client = (clients.get(channel) as Map<string, ws.WebSocket>).get(
          recipientId
        ) as ws.WebSocket;
        client.send(
          JSON.stringify({
            type: returnSignal ? "returnedSignal" : "newForeignSignal",
            payload: {
              senderId: userId,
              ...(!returnSignal && { username: username }),
              signal
            }
          })
        );
      }
      break;
    }
    case "broadcastMessage": {
      relayMessageToUsersInPartyExcept(channel, msg.data.userId, "newForeignMessage", msg.data);
      break;
    }
    case "setUserMute":
    case "timeUpdate":
    case "setAdminControls": {
      console.log("msg.command :>> ", msg.command);
      relayMessageToUsersInPartyExcept(channel, msg.data.userId, msg.command, msg.data);
      break;
    }
    case "promoteToRoomOwner": {
      const userMapping = clients.get(channel);
      for (const userSocket of userMapping?.values() ?? []) {
        userSocket.send(
          JSON.stringify({
            type: "promoteToRoomOwner",
            payload: {
              userId: msg.data.userId,
              username: msg.data.username
            }
          })
        );
      }
      break;
    }
    default: {
      console.error("Invalid command");
    }
  }
});

function broadcast(socket: ws.WebSocket, command: string, payload: any) {
  pub.publish(
    socket.partyId,
    JSON.stringify({
      command,
      data: {
        ...payload,
        userId: socket.userId
      }
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
    try {
      // remove user represented by the closed socket from party locally
      clients.get(socket.partyId)?.delete(socket.userId);
      // delete from redis
      removeUser(pub, socket.partyId, socket.userId);

      const remainingUsers = await getUsersInParty(pub, socket.partyId);
      console.log("after deleting, remainingUsers :>> ", remainingUsers);

      const partyEmpty = !remainingUsers || remainingUsers.length === 0;

      if (partyEmpty) {
        // if party is empty, let's remove it
        return;
      }

      assert(remainingUsers.length > 0, "Number of users remaining in the party is more than 0");

      const isThereRoomOwner = remainingUsers.some((user) => user.isRoomOwner === "true");
      if (isThereRoomOwner) {
        // the room owner is by definition also an admin so no need to worry, let's return
        return;
      }

      // the previous room owner just left the party, let's assign a new room owner
      const remainingAdmins = remainingUsers.filter((user) => user.isAdmin === "true");

      let randomAdmin: User;

      if (remainingAdmins.length > 0) {
        // there are admins left, let's pick one of them for new room ownership
        randomAdmin = remainingAdmins[Math.floor(Math.random() * remainingAdmins.length)];
      } else {
        randomAdmin = remainingUsers[Math.floor(Math.random() * remainingUsers.length)];
      }

      console.log("Picked admin: ");
      console.log(randomAdmin);

      // first, update the user details for the randomAdmin user in redis
      await updateUser(pub, socket.partyId, {
        ...randomAdmin,
        isAdmin: "true"
      });

      // then, broadcast room promotion info to all remaining users of the party
      pub.publish(
        socket.partyId,
        JSON.stringify({
          command: "promoteToRoomOwner",
          data: {
            userId: randomAdmin.userId,
            username: randomAdmin.username
          }
        })
      );
    } catch (error) {
      console.error("Something went wrong while cleaning up after user left the party");
      console.error(error.message);
    }
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
      return;
    }

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
            console.log(
              "users info: ",
              users.map((u) => JSON.stringify(u))
            );
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
        broadcast(socket, "redirectSignal", data);
        break;
      }
      case "returnSignal": {
        const data = {
          ...msg.payload,
          returnSignal: true
        };
        broadcast(socket, "redirectSignal", data);
        break;
      }
      case "broadcastMessage":
      case "setUserMute":
      case "timeUpdate":
      case "setAdminControls": {
        broadcast(socket, msg.type, msg.payload);
        break;
      }
      default: {
        console.log("Could not identify message type");
        socket.send(
          JSON.stringify({
            type: "error",
            payload: { message: "Not a valid message type" }
          })
        );
      }
    }
  });
});

wss.on("close", () => {
  // TODO: Cleanup?
});

server.listen(SERVER_PORT, () => {
  console.log(`Websocket server ${SERVER_ID} listening on port ${SERVER_PORT}`);
});
