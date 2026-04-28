import { WebSocketServer } from "ws";
import { logger } from "./logger.js";
import { SpeechKitStreamingSession } from "./speechkit-stream.js";

let nextConnectionId = 1;

function sendJson(socket, payload) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(payload));
  }
}

export function attachWsServer(httpServer, config) {
  const wsServer = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    let pathname;

    try {
      ({ pathname } = new URL(request.url, "http://localhost"));
    } catch {
      logger.warn("ws", "bad_upgrade_url", { url: request.url });
      socket.destroy();
      return;
    }

    if (pathname !== "/ws/stt") {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (websocket) => {
      wsServer.emit("connection", websocket, request);
    });
  });

  wsServer.on("connection", (websocket) => {
    const connectionId = `ws-${nextConnectionId++}`;
    let session = null;

    logger.info("ws", "client_connected", { connectionId });

    websocket.on("message", (message, isBinary) => {
      try {
        if (isBinary) {
          if (!session) {
            return;
          }

          session.pushAudio(Buffer.from(message));
          return;
        }

        const payload = JSON.parse(message.toString());

        if (payload.type === "start") {
          session?.close();
          session = null;
          logger.info("ws", "stream_start_requested", {
            connectionId,
            sampleRate: payload.sampleRate,
            encoding: payload.encoding,
            deviceId: payload.deviceId,
          });
          session = new SpeechKitStreamingSession(config.speechkit, {
            onPartial: ({ text, latencyMs }) => {
              sendJson(websocket, { type: "partial", text, latencyMs });
            },
            onFinal: ({ text, latencyMs }) => {
              logger.info("speechkit", "final_transcript", { connectionId, text, latencyMs });
              sendJson(websocket, { type: "final", text, latencyMs });
            },
            onStatus: ({ message: statusMessage, codeType }) => {
              logger.warn("speechkit", "status_update", {
                connectionId,
                codeType,
                statusMessage,
              });
              sendJson(websocket, {
                type: "error",
                message: `SpeechKit status ${codeType}: ${statusMessage}`,
              });
            },
            onError: (error) => {
              logger.error("speechkit", "stream_error", { connectionId, error });
              session?.close();
              session = null;
              sendJson(websocket, { type: "error", message: error.message });
            },
            onEnd: () => {
              logger.info("speechkit", "stream_ended", { connectionId });
              session?.close();
              session = null;
              sendJson(websocket, { type: "state", activeLot: null });
            },
          }, { connectionId });

          sendJson(websocket, { type: "state", activeLot: null });
          return;
        }

        if (payload.type === "stop") {
          logger.info("ws", "stream_stop_requested", { connectionId });
          session?.close();
          session = null;
          sendJson(websocket, { type: "state", activeLot: null });
        }
      } catch (error) {
        logger.error("ws", "message_handler_failed", { connectionId, error });
        sendJson(websocket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    websocket.on("close", () => {
      logger.info("ws", "client_disconnected", { connectionId });
      session?.close();
      session = null;
    });
  });

  return wsServer;
}
