import { RedisClient } from "redis";

interface User {
  userId: string;
  username: string;
  isAdmin: string;
}

export function getUser(
  client: RedisClient,
  partyId: string,
  userId: string
): Promise<{ [key: string]: string }> {
  return new Promise((resolve, reject) => {
    client.hgetall(`${partyId}:user:${userId}`, (err, user) => {
      if (err) {
        reject(err);
      }
      resolve(user);
    });
  });
}

export function getUsersInParty(client: RedisClient, partyId: string): Promise<Array<string>> {
  return new Promise((resolve, reject) => {
    client.smembers(`${partyId}:users`, (err, userIds) => {
      if (err) {
        reject(err);
      }

      console.log("userIds of users in party: ", userIds);
      if (userIds.length > 0) {
        Promise.all(userIds.map((userId) => getUser(client, partyId, userId)))
          .then((users) => {
            return users.map((user) => JSON.stringify(user));
          })
          .then((userStrs) => resolve(userStrs))
          .catch((err) => reject(err));
      } else {
        resolve([]);
      }
    });
  });
}

export function addUser(client: RedisClient, partyId: string, userDetails: User): Promise<void> {
  const { userId, username, isAdmin } = userDetails;
  return new Promise((resolve, reject) => {
    client
      .multi()
      .sadd(`${partyId}:users`, userId)
      .hmset(
        `${partyId}:user:${userId}`,
        "userId",
        userId,
        "username",
        username,
        "isAdmin",
        isAdmin
      )
      .exec((err) => {
        if (err) {
          reject(err);
        }
        resolve();
      });
  });
}
