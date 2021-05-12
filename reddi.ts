import { Random } from "https://cdn.deno.land/random/versions/v1.1.2/raw/Random.js";
import * as path from "https://deno.land/std/path/mod.ts";
import xdg from "https://deno.land/x/xdg/src/mod.deno.ts";
import { ensureFile } from "https://deno.land/std@0.96.0/fs/mod.ts";
import { compareVersions } from "https://cdn.deno.land/compare_versions/versions/0.4.0/raw/mod.ts";

const REDDI_APP_CLIENT_ID = "f9DcUNPm6x0nag";

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

interface Config {
  // @ts-ignore match store request format
  accessToken?: string;
  refreshToken?: string;
  port: string;
  clientId: string;
  oauthCallback: string;
}

export class Reddit {
  config!: Config;
  configPath!: string;
  state: string;
  code: string | null | undefined;
  authorization!: { Authorization: string };

  constructor(configPath?: string) {
    if (compareVersions(Deno.version.deno, "1.9.1") < 0) {
      throw new Error(
        "reddi requires Deno >= 1.9.1 because of https://github.com/denoland/deno/issues/10182"
      );
    }
    this.state = new Random().string(30);

    // @ts-ignore async constructor
    return (async () => {
      this.configPath =
        configPath ||
        Deno.env.get("REDDI_CONFIG") ||
        path.join(xdg.data(), "reddi", "config.json");

      let config: Partial<Config> = {};
      try {
        const json = await Deno.readTextFile(this.configPath);
        config = JSON.parse(json);
      } catch {
        // do nothing
      }

      const accessToken = config.accessToken;
      const refreshToken = config.refreshToken;
      const clientId =
        config.clientId ||
        Deno.env.get("REDDI_CLIENT_ID") ||
        REDDI_APP_CLIENT_ID;

      this.authorization = {
        Authorization: "Basic " + btoa(clientId + ":"),
      };

      const port = config.port || Deno.env.get("REDDI_OAUTH_PORT") || "16661";
      const oauthCallback =
        config.oauthCallback ||
        Deno.env.get("REDDI_OAUTH_CALLBACK") ||
        `http://localhost:${port}`;

      this.config = {
        accessToken,
        refreshToken,
        port,
        clientId,
        oauthCallback,
      };

      if (!this.config.refreshToken || !this.config.accessToken) {
        await this.newAuthorization();
      }

      return this;
    })();
  }

  private async oauthServer(): Promise<string> {
    console.error(`HTTP webserver running on port ${this.config.port}`);
    console.error(
      `\nGo here to generate an authorization code:\nhttps://www.reddit.com/api/v1/authorize?client_id=${
        this.config.clientId
      }&response_type=code&state=${this.state}&redirect_uri=${
        this.config.oauthCallback
      }&duration=permanent&scope=${scopes.join(",")}`
    );
    const server = Deno.listen({ port: Number(this.config.port) });

    // Connections to the server will be yielded up as an async iterable.
    for await (const conn of server) {
      const httpConn = Deno.serveHttp(conn);
      for await (const requestEvent of httpConn) {
        // It's ok that the handler is blocking because there should only be one request
        const url = new URL(requestEvent.request.url);
        const params = new URLSearchParams(url.search);
        const state = params.get("state");

        if (this.state !== state) {
          await requestEvent.respondWith(
            new Response(`FAILURE: state does not match: ${this.state}`, {
              status: 400,
            })
          );
          throw new Error("State does not match!");
        }

        const code = params.get("code");
        if (code) {
          await requestEvent.respondWith(
            new Response("You can continue using reddi", {
              status: 200,
            })
          );
          return code;
        }

        const error = params.get("error");

        await requestEvent.respondWith(
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

  public async newAuthorization() {
    const code = await this.oauthServer();

    const body = new FormData();
    body.append("grant_type", "authorization_code");
    body.append("code", code);
    body.append("redirect_uri", this.config.oauthCallback);
    await this.getAccessToken(body);
  }

  public async refresh() {
    const body = new FormData();
    body.append("grant_type", "refresh_token");
    body.append("refresh_token", this.config.refreshToken!);
    await this.getAccessToken(body);
  }

  private async getAccessToken(body: FormData) {
    const resp = await fetch(`https://www.reddit.com/api/v1/access_token`, {
      method: "POST",
      headers: this.authorization,
      body,
    });

    const respBody = await resp.json();
    const accessToken = respBody.access_token;
    if (!accessToken) {
      throw new Error(
        `No access_token in response: ${JSON.stringify(respBody)}`
      );
    }

    const refreshToken = respBody.refresh_token;
    if (!refreshToken) {
      throw new Error(
        `No refresh_token in response: ${JSON.stringify(respBody)}`
      );
    }

    this.config.accessToken = accessToken;
    this.config.refreshToken = refreshToken;

    await ensureFile(this.configPath);
    await Deno.writeTextFile(this.configPath, JSON.stringify(this.config));
  }

  public async request(url: string, opts?: RequestInit) {
    const req = async () => {
      if (!this.config.accessToken) {
        await this.refresh();
      }
      return fetch(`https://oauth.reddit.com${url}`, {
        ...opts,
        headers: {
          ...opts?.headers,
          Authorization: `Bearer ${this.config.accessToken!}`,
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
