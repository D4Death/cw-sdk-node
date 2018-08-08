import { Big } from "big.js";
import * as crypto from "crypto";
import { EventEmitter } from "events";
import * as pjson from "pjson";
import * as WebSocket from "ws";

// Protobuf message constructors
import {
  APIAuthenticationMessage,
  AuthenticationResult,
  ClientMessage,
  MarketUpdateMessage,
  StreamMessage
} from "./proto-builders";

// Protobuf message type definitions
import {
  ProtobufClient,
  ProtobufMarkets,
  ProtobufStream
} from "../modules/proto";

export interface IStreamOptions {
  url?: string;
  apiKey: string;
  secretKey: string;
  subscriptions?: string[];
  reconnect?: boolean;
  backoff?: boolean;
  reconnectTimeout?: number;
  maxReconnectTimeout?: number;
  verbose?: boolean;
  nonce?: string;
}

// Listeners
// A client can listen on any of the following events, states, or errors

// Connection states. Each of these will also emit EVENT.STATE_CHANGE
export enum STATE {
  AUTHENTICATING = "authenticating",
  CONNECTED = "connected",
  CONNECTING = "connecting",
  DISCONNECTED = "disconnected",
  WAITING_TO_CONNECT = "waiting to connect",
  WAITING_TO_RECONNECT = "waiting to reconnect"
}

// Client events
export enum EVENT {
  CLIENT_ERROR = "client error",
  MARKET_UPDATE = "market update",
  PAIR_UPDATE = "pair update",
  STATE_CHANGE = "state change"
}

// Connection errors; Each of these will also emit EVENT.ERROR
export enum ERROR {
  BAD_NONCE = "bad nonce",
  BAD_TOKEN = "bad token",
  CONNECTION_REFUSED = "connection refused",
  MISSING_API_KEY = "missing api key",
  MISSING_SECRET_KEY = "missing secret key",
  PROTOBUF = "protobuf",
  TOKEN_EXPIRED = "token expired",
  UNKNOWN = "unknown error"
}

// These will be overwritten by the opts object passed to the constructor
const defaultOptions: IStreamOptions = {
  url: "wss://sb.cryptowat.ch",

  // apiKey and secretKey are both Required. Obtain from https://cryptowat.ch/account/stream-api
  // These defaults will be overwritten by environment variables CW_API_KEY and CW_SECRET_KEY,
  // and environment variables will be overwritten by settings passed to the constructor.
  apiKey: "",
  secretKey: "",

  // A list of subscriptions to subscribe to on connection
  subscriptions: [],

  // Whether the library should reconnect automatically
  reconnect: true,

  // Reconnection backoff: if true, then the reconnection time will be initially
  // reconnectTimeout, then will double with each unsuccessful connection attempt.
  // It will not exceed maxReconnectTimeout
  backoff: true,

  // Initial reconnect timeout (seconds), minimum 1s
  reconnectTimeout: 1,

  // The maximum amount of time between reconnect tries (applies to backoff)
  maxReconnectTimeout: 30,

  // If true, client outputs detailed log messages
  verbose: false
};

/**
 * StreamClient manages a connection to Cryptowatch websocket api
 */

export class CWStreamClient extends EventEmitter {
  private session: IStreamOptions;
  private currentState: STATE;

  // Handles Websocket connection to the CW Stream service
  private conn: WebSocket;

  // shouldReconnect is used internally to avoid reconnecting if the client wants to disconnect.
  // This is separate from this.session.reconnect, which is a config option.
  private reconnectDisabled: boolean;

  constructor(opts: IStreamOptions) {
    super();

    if (process.env.CW_API_KEY) {
      opts.apiKey = process.env.CW_API_KEY;
    }
    if (process.env.CW_SECRET_KEY) {
      opts.secretKey = process.env.CW_SECRET_KEY;
    }

    this.session = Object.assign(defaultOptions, opts);

    if (this.session.apiKey.length === 0) {
      throw new Error(ERROR.MISSING_API_KEY);
    }
    if (this.session.secretKey.length === 0) {
      throw new Error(ERROR.MISSING_SECRET_KEY);
    }

    this.currentState = STATE.WAITING_TO_CONNECT;

    // Register internal event handlers

    // Log and emit every state change
    Object.keys(STATE).forEach(s => {
      this.on(STATE[s], () => {
        this.currentState = STATE[s];
        this.log("info", `state change: ${STATE[s]}`);
        this.emit(EVENT.STATE_CHANGE, STATE[s]);
      });
    });

    // Log and emit every error
    Object.keys(ERROR).forEach(e => {
      this.on(ERROR[e], () => {
        this.log("error", ERROR[e]);
        this.emit(EVENT.CLIENT_ERROR, ERROR[e]);
      });
    });
  }

  public connect(): void {
    this.reconnectDisabled = false;
    this.emit(STATE.CONNECTING);
    this.conn = new WebSocket(this.session.url);
    this.conn.once("open", () => {
      this.authenticate();
    });
    this.conn.on("message", (data: Buffer) => this.handleMessage(data));
    this.conn.once("close", () => {
      this.emit(STATE.DISCONNECTED);
      if (this.session.reconnect && !this.reconnectDisabled) {
        this.reconnect();
      }
    });
    this.conn.once("error", err => {
      this.emit(ERROR.CONNECTION_REFUSED);
      this.emit(STATE.DISCONNECTED);
      if (this.session.reconnect) {
        this.reconnect();
      }
    });
  }

  public generateToken(nonce: string): string {
    const hmac = crypto.createHmac(
      "sha512",
      Buffer.from(this.session.secretKey, "base64")
    );
    hmac.update(
      `stream_access;access_key_id=${this.session.apiKey};nonce=${nonce};`
    );
    return hmac.digest("base64");
  }

  public onConnect(fn: () => void): void {
    this.on(STATE.CONNECTED, () => fn());
  }

  public onDisconnect(fn: () => void): void {
    this.on(STATE.DISCONNECTED, () => fn());
  }

  public onStateChange(fn: (s: STATE) => void): void {
    this.on(EVENT.STATE_CHANGE, newState => fn(newState));
  }

  public onError(fn: (e: Error) => void): void {
    this.on(EVENT.CLIENT_ERROR, err => fn(err));
  }

  public onMarketUpdate(
    fn: (m: ProtobufMarkets.MarketUpdateMessage) => void
  ): void {
    this.on(EVENT.MARKET_UPDATE, marketUpdate => fn(marketUpdate));
  }

  public onPairUpdate(
    fn: (m: ProtobufMarkets.PairUpdateMessage) => void
  ): void {
    this.on(EVENT.PAIR_UPDATE, pairUpdate => fn(pairUpdate));
  }

  public send(data: Buffer | Uint8Array): void {
    this.conn.send(data);
  }

  public disconnect(): void {
    this.reconnectDisabled = true;
    this.conn.close();
  }

  public state(): STATE {
    return this.currentState;
  }

  public set(key: string, val: any): CWStreamClient {
    this.session[key] = val;
    return this;
  }

  public get(key: string): any {
    return this.session[key];
  }

  private reconnect(): void {
    setTimeout(() => {
      if (this.session.backoff) {
        if (this.session.reconnectTimeout < 1) {
          this.session.reconnectTimeout = 1;
        }
        this.session.reconnectTimeout *= 2;
        if (this.session.reconnectTimeout > this.session.maxReconnectTimeout) {
          this.session.reconnectTimeout = this.session.maxReconnectTimeout;
        }
      }
      this.connect();
    }, this.session.reconnectTimeout * 1000);
    this.emit(STATE.WAITING_TO_RECONNECT, this.session.reconnectTimeout);
  }

  private authenticate(): void {
    this.emit(STATE.AUTHENTICATING);

    // The client should never use their own nonce, this is only for testing
    // purposes
    const nonce = this.session.nonce ? this.session.nonce : this.getNonce();
    const token = this.generateToken(nonce);
    const authMsg = ClientMessage.create({
      apiAuthentication: APIAuthenticationMessage.create({
        apiKey: this.session.apiKey,
        nonce,
        // TODO this should be NODE_SDK, and JAVASCRIPT_SDK if transpiled for
        // browser
        source: ProtobufClient.APIAuthenticationMessage.Source.JAVASCRIPT_SDK,
        subscriptions: this.session.subscriptions,
        token,
        version: pjson.version
      })
    });
    this.send(ClientMessage.encode(authMsg).finish());
  }

  /**
   * Gets current unix time in nanoseconds, as a string. The use of big.js is
   * kind of a hack here to get around JavaScript converting the nonce to
   * scientific notation.
   */
  private getNonce(): string {
    return new Big(new Date().getTime() * 1000 * 1000).toPrecision(19);
  }

  private handleMessage(data: Buffer): void {
    // Heartbeat
    const bytes = new Uint8Array(data);
    if (bytes.length === 1 && bytes[0] === 1) {
      return;
    }

    let message;
    try {
      message = StreamMessage.decode(data);
    } catch (e) {
      this.emit(ERROR.PROTOBUF);
      this.log("error", e);
      return;
    }

    switch (message.body) {
      case "authenticationResult":
        this.authResultHandler(message.authenticationResult);
        break;
      case "marketUpdate":
        this.emit(EVENT.MARKET_UPDATE, message.marketUpdate);
        break;
      case "pairUpdate":
        this.emit(EVENT.PAIR_UPDATE, message.pairUpdate);
        break;
      default:
        this.emit(ERROR.PROTOBUF);
    }
  }

  private authResultHandler(authResult): void {
    switch (authResult.status) {
      case ProtobufStream.AuthenticationResult.Status.AUTHENTICATED:
        this.emit(STATE.CONNECTED);
        break;
      case ProtobufStream.AuthenticationResult.Status.TOKEN_EXPIRED:
        this.emit(ERROR.TOKEN_EXPIRED);
        this.disconnect();
        break;
      case ProtobufStream.AuthenticationResult.Status.BAD_NONCE:
        this.emit(ERROR.BAD_NONCE);
        this.disconnect();
        break;
      case ProtobufStream.AuthenticationResult.Status.BAD_TOKEN:
        this.emit(ERROR.BAD_TOKEN);
        this.disconnect();
        break;
      case ProtobufStream.AuthenticationResult.Status.UNKNOWN:
        this.emit(ERROR.UNKNOWN);
        this.disconnect();
        break;
      default:
        break;
    }
  }

  private log(level: string, ...msg: string[]): void {
    if (this.session.verbose) {
      console[level](...msg);
    }
  }
}
