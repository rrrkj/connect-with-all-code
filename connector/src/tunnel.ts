import WebSocket from 'ws';
import pino from 'pino';
import {
    AgentType,
    Task,
    WsMessageType,
    WsMessage,
    WsPairRequest,
    serializeMessage,
    deserializeMessage,
} from '@cwac/shared';
import { AgentRunner } from './agents/base';
import { checkAllAgents } from './health';

const logger = pino({ name: 'tunnel' });

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

interface TunnelOptions {
    gatewayUrl: string;
    pairingCode: string;
    deviceName: string;
    runners: Map<AgentType, AgentRunner>;
}

export class Tunnel {
    private ws: WebSocket | null = null;
    private opts: TunnelOptions;
    private reconnectAttempt = 0;
    private paired = false;
    private deviceId: string | null = null;

    constructor(opts: TunnelOptions) {
        this.opts = opts;
    }

    /**
     * Connect to the gateway WebSocket server.
     */
    connect(): void {
        logger.info({ url: this.opts.gatewayUrl }, 'Connecting to gateway...');

        this.ws = new WebSocket(this.opts.gatewayUrl);

        this.ws.on('open', () => {
            logger.info('Connected to gateway');
            this.reconnectAttempt = 0;

            if (!this.paired) {
                this.sendPairRequest();
            }
        });

        this.ws.on('message', (data: Buffer) => {
            try {
                const msg = deserializeMessage(data.toString());
                this.handleMessage(msg);
            } catch (err: any) {
                logger.error({ err: err.message }, 'Invalid message from gateway');
            }
        });

        this.ws.on('close', () => {
            logger.warn('Disconnected from gateway');
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            logger.error({ err: err.message }, 'WebSocket error');
        });
    }

    /**
     * Disconnect from the gateway.
     */
    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    private sendPairRequest(): void {
        const availableAgents = Array.from(this.opts.runners.keys());
        const msg: WsPairRequest = {
            type: WsMessageType.PAIR_REQUEST,
            pairingCode: this.opts.pairingCode,
            deviceName: this.opts.deviceName,
            availableAgents,
        };

        this.send(msg);
        logger.info(
            { pairingCode: this.opts.pairingCode, agents: availableAgents },
            'Sent pairing request'
        );
    }

    private async handleMessage(msg: WsMessage): Promise<void> {
        switch (msg.type) {
            case WsMessageType.PAIR_ACCEPTED:
                this.paired = true;
                this.deviceId = msg.deviceId;
                logger.info({ deviceId: msg.deviceId }, '✅ Successfully paired with gateway!');
                break;

            case WsMessageType.PAIR_REJECTED:
                logger.error({ reason: msg.reason }, '❌ Pairing rejected');
                this.disconnect();
                process.exit(1);
                break;

            case WsMessageType.TASK_DISPATCH:
                await this.handleTask(msg.task);
                break;

            case WsMessageType.STATUS_REQUEST:
                await this.handleStatusRequest(msg.requestId);
                break;

            case WsMessageType.CANCEL_TASK:
                logger.info({ taskId: msg.taskId }, 'Cancel request received (not yet implemented)');
                break;

            case WsMessageType.HEARTBEAT:
                this.send({
                    type: WsMessageType.HEARTBEAT_ACK,
                    timestamp: Date.now(),
                });
                break;

            default:
                logger.warn({ type: (msg as any).type }, 'Unhandled message type');
        }
    }

    private async handleTask(task: Task): Promise<void> {
        const runner = this.opts.runners.get(task.agent);

        if (!runner) {
            this.send({
                type: WsMessageType.TASK_RESULT,
                result: {
                    taskId: task.id,
                    status: 'failed',
                    output: '',
                    error: `Agent ${task.agent} is not available on this device.`,
                    durationMs: 0,
                },
            });
            return;
        }

        logger.info({ taskId: task.id, agent: task.agent }, 'Executing task...');

        // Send progress indicator
        this.send({
            type: WsMessageType.TASK_PROGRESS,
            taskId: task.id,
            partialOutput: `Running on ${runner.getName()}...`,
        });

        const result = await runner.execute(task.prompt, task.workspace);
        result.taskId = task.id;

        this.send({
            type: WsMessageType.TASK_RESULT,
            result,
        });

        logger.info(
            { taskId: task.id, status: result.status, durationMs: result.durationMs },
            'Task completed'
        );
    }

    private async handleStatusRequest(requestId: string): Promise<void> {
        const agents = await checkAllAgents(this.opts.runners);
        this.send({
            type: WsMessageType.STATUS_RESPONSE,
            requestId,
            agents,
        });
    }

    private send(msg: WsMessage): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(serializeMessage(msg));
        }
    }

    private scheduleReconnect(): void {
        const delay = Math.min(
            BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt),
            MAX_RECONNECT_DELAY_MS
        );
        this.reconnectAttempt++;
        logger.info({ delay, attempt: this.reconnectAttempt }, 'Reconnecting...');
        setTimeout(() => this.connect(), delay);
    }
}
