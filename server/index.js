import { config } from "./config.js";
import { createStaticServer } from "./http-server.js";
import { attachWsServer } from "./ws-server.js";
import { logger } from "./logger.js";

const httpServer = createStaticServer();
attachWsServer(httpServer, config);

httpServer.on("error", (error) => {
  logger.error("http", "server_listen_failed", {
    port: config.port,
    error,
  });
});

httpServer.listen(config.port, () => {
  logger.info("http", "server_started", {
    port: config.port,
    url: `http://localhost:${config.port}`,
    logFile: logger.filePath,
  });
});
