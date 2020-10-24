import { RedisClient } from "redis";

export function getUsersInParty(client: RedisClient, partyId: string): Promise<Array<string>> {
  return new Promise((resolve, reject) => {
    client.smembers(`${partyId}:users`, (err, res) => {
      if (err) {
        reject(err);
      }
      resolve(res);
    });
  });
}
