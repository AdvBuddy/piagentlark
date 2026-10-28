import http from 'node:http';
import { adaptDefault } from '@larksuiteoapi/node-sdk';
/**
 * Webhook transport: the SDK exposes its event dispatcher without a public
 * accessor, so the adaptor is mounted on a plain Node HTTP server. Signature
 * decryption and URL-verification challenges are handled by the SDK.
 */
export async function startWebhookServer(channel, config, logger) {
    const dispatcher = channel.dispatcher;
    if (!dispatcher) {
        throw new Error('飞书通道未暴露事件分发器，无法启用 webhook 模式；可设置 FEISHU_CONNECTION_MODE=websocket 改用长连接');
    }
    const { host, port, path } = config.lark.webhook;
    const handle = adaptDefault(path, dispatcher, { autoChallenge: true });
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === path) {
            void handle(req, res).catch((error) => {
                logger.warn('处理 webhook 请求失败', error);
                if (!res.headersSent)
                    res.statusCode = 500;
                res.end();
            });
            return;
        }
        res.statusCode = 404;
        res.end('not found');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
    });
    logger.info(`webhook 服务已启动 http://${host}:${port}${path}`);
    return server;
}
