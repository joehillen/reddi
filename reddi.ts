//

import { Random } from "https://cdn.deno.land/random/versions/v1.1.2/raw/Random.js";

const PORT = Deno.env.get("REDDI_PORT") || "16661";
const OAUTH_CALLBACK =
  Deno.env.get("REDDI_OAUTH_CALLBACK") || `http://localhost:${PORT}`;
const CLIENT_ID = Deno.env.get("REDDI_CLIENT_ID") || "f9DcUNPm6x0nag";

const scopes = [
  "identity",
  "edit",
  "flair",
  "history",
  "modconfig",
  "modcontributors",
  "modflair",
  "modlog",
  "modposts",
  "modwiki",
  "mysubreddits",
  "privatemessages",
  "read",
  "report",
  "save",
  "submit",
  "subscribe",
  "vote",
  "wikiedit",
  "wikiread",
];

const authorization = {
  Authorization: "Basic " + btoa(CLIENT_ID + ":"),
};

export class Reddit {
  accessToken!: string;
  refreshToken!: string;
  state: string;
  code: string | null | undefined;

  constructor() {
    this.state = new Random().string(30);

    // @ts-ignore async constructor
    return (async () => {
      await this.auth();

      return this;
    })();
  }

  async auth() {
    let access;
    try {
      const json = await Deno.readTextFile("./access.json");
      access = JSON.parse(json);
      this.accessToken = access.access_token;
      this.refreshToken = access.refresh_token;
    } catch {
      // do nothing
    }

    if (!this.accessToken || !this.refreshToken) {
      await this.newToken();
    }
  }

  async oauthServer(): Promise<string> {
    console.log(`HTTP webserver running on port ${PORT}`);
    console.log(
      `\n\nGo here to generate an access token:\nhttps://www.reddit.com/api/v1/authorize?client_id=${CLIENT_ID}&response_type=code&state=${
        this.state
      }&redirect_uri=${OAUTH_CALLBACK}&duration=permanent&scope=${scopes.join(
        ","
      )}`
    );
    const server = Deno.listen({ port: Number(PORT) });

    // Connections to the server will be yielded up as an async iterable.
    for await (const conn of server) {
      const httpConn = Deno.serveHttp(conn);
      for await (const requestEvent of httpConn) {
        // It's ok that the handler is blocking because there should only be one request
        const params = new URLSearchParams(requestEvent.request.url);

        if (this.state === params.get("state")) {
          new Response("FAILURE: State does not match", {
            status: 400,
          });
          throw new Error("State does not match!");
        }

        const code = params.get("code");
        if (code) {
          return code;
        }

        const error = params.get("error");

        requestEvent.respondWith(
          new Response(
            `FAILURE: Failed to get code\nError from Reddit: ${error}`,
            {
              status: 500,
            }
          )
        );
        throw new Error(`Error from Reddit: ${error}`);
      }
    }

    throw new Error("Failed to get code");
  }

  async newToken() {
    const code = await this.oauthServer();

    const body = new FormData();
    body.append("grant_type", "authorization_code");
    body.append("code", code);
    body.append("redirect_uri", OAUTH_CALLBACK);
    await this.getAccessToken(body);
  }

  async refresh() {
    const body = new FormData();
    body.append("grant_type", "refresh_token");
    body.append("refresh_token", this.refreshToken);
    await this.getAccessToken(body);
  }

  async getAccessToken(body: FormData) {
    const resp = await fetch(`https://www.reddit.com/api/v1/access_token`, {
      method: "POST",
      headers: authorization,
      body,
    });

    const respBody = await resp.json();
    const accessToken = respBody.access_token;
    if (!accessToken) {
      throw new Error(
        `no access_token in response: ${JSON.stringify(respBody)}`
      );
    }

    const refreshToken = respBody.refresh_token;
    if (!refreshToken) {
      throw new Error(
        `no refresh_token in response: ${JSON.stringify(respBody)}`
      );
    }

    await Deno.writeTextFile("./access.json", JSON.stringify(respBody));

    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  async request(url: string, opts?: RequestInit) {
    const req = () => {
      return fetch(`https://oauth.reddit.com${url}`, {
        ...opts,
        headers: {
          ...opts?.headers,
          Authorization: `Bearer ${this.accessToken}`,
        },
      });
    };

    let resp = await req();
    if (resp.status === 403) {
      await this.refresh();
      resp = await req();

      if (resp.status === 403) {
        console.error(
          `Reddit request failed: ${JSON.stringify(resp)} ${await resp.text()}`
        );
        Deno.exit(1);
      }
    }

    return resp.json();
  }
}

async function main() {
  const reddit = await new Reddit();

  if (!Deno.args) {
    console.error(`Usage: reddi API_URL`);
    Deno.exit(1);
  }

  for (const url of Deno.args) {
    const resp = await reddit.request(url);
    console.log(JSON.stringify(resp, null, 2));
  }
}

if (import.meta.main) {
  await main();
}
