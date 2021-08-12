# NodeJS Websocket server for the Moduda chrome extension

This repo contains the node websocket server for the [Moduda](https://moduda.live) chrome extension.

### Running Locally

To run the server locally, we recommend using `docker compose`. From the root directory of this project, simply run:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

### Deploying to AWS

In case anybody is interested, this server is running in an AWS ECS cluster in production.

To deploy, I simply run:

```bash
ecs-cli compose service up --cluster-config <ECS_CONFIG_NAME> --ecs-profile <ECS_PROFILE_NAME>
```
