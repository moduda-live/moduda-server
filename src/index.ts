import ws from "ws";
import express from "express";
import http from "http";
import { v4 as uuid } from "uuid";

const SERVER_ID = process.env.SERVER_ID; // for horizontally scaling with docker
const SERVER_PORT = 8080;

// const REDIS_HOST = "127.0.0.1";
// const REDIS_PORT = 6379;

declare module "ws" {
  export class WebSocket extends ws {
    id: string;
  }
}

const app = express();
const server = http.createServer(app);
const wss = new ws.Server({ server });

app.get("/", (_, res) => {
  res.send("Websocket server for the movens chrome extension");
});

wss.on("connection", (user, req) => {
  console.log("User connected from ", req.url);

  user.id = uuid();

  user.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data as string);
    } catch (error) {
      console.log("Malformed message from client");
      user.send(
        JSON.stringify({
          type: "error",
          payload: { message: "Message sent was not in JSON format" }
        })
      );
    }

    // msg is properly formatted here
    switch (msg.type) {
      case "join":
        // const {partyId} = msg.payload
        // create new channel from the party id
        // TODO: fetch users from given party using partyId
        user.send(
          JSON.stringify({ type: "currentPartyUsers", payload: { users: ["user1", "user2"] } })
        );
        break;
      default:
        console.log("Could not identify message type");
        user.send(
          JSON.stringify({ type: "error", payload: { message: "Not a valid message type" } })
        );
    }
  });
});

wss.on("error", (error) => {
  console.error(error);
});

server.listen(SERVER_PORT, () => {
  console.log(`Websocket server listening on port ${SERVER_PORT}`);
});
