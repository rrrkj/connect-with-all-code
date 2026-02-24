import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import {
    Task,
    TaskResult,
    AgentType,
    AgentStatusMap,
    WsMessageType,
    WsMessage,
    WsTaskDispatch,
    WsStatusRequest,
    WsCancelTask,
    serializeMessage,
    deserializeMessage,
} from '@cwac/shared';

const logger = pino({ name: 'ws-server' });

// ─── Pairing ───

interface PendingPairing {
    userId: string;
    createdAt: number;
}

interface ConnectedDevice {
    id: string;
    ws: WebSocket;
    userId: string;
    deviceName: string;
    availableAgents: AgentType[];
    lastHeartbeat: number;
}

// ─── State ───

const pendingPairings = new Map<string, PendingPairing>(); // pairingCode → pending
const connectedDevices = new Map<string, ConnectedDevice>(); // deviceId → device
const userDevices = new Map<string, string>(); // userId → deviceId

// Callbacks
type ResultHandler = (userId: string, result: TaskResult) => void;
type StatusHandler = (userId: string, agents: AgentStatusMap) => void;

let onResultHandler: ResultHandler | null = null;
let onStatusHandler: StatusHandler | null = null;

const pendingStatusRequests = new Map<string, string>(); // requestId → userId

// ─── Public API ───

export function initWsServer(server: Server): void {
    const wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws: WebSocket) => {
        logger.info('New WebSocket connection');

        ws.on('message', (data: Buffer) => {
            try {
                const msg = deserializeMessage(data.toString());
                handleMessage(ws, msg);
            } catch (err: any) {
                logger.error({ err: err.message }, 'Invalid WebSocket message');
                ws.send(serializeMessage({ type: WsMessageType.ERROR, message: 'Invalid message format' }));
            }
        });

        ws.on('close', () => {
            // Find and remove the disconnected device
            for (const [deviceId, device] of connectedDevices.entries()) {
                if (device.ws === ws) {
                    connectedDevices.delete(deviceId);
                    userDevices.delete(device.userId);
                    logger.info({ deviceId, userId: device.userId }, 'Device disconnected');
                    break;
                }
            }
        });

        ws.on('error', (err) => {
            logger.error({ err: err.message }, 'WebSocket error');
        });
    });

    // Heartbeat check every 30 seconds
    setInterval(() => {
        const now = Date.now();
        for (const [deviceId, device] of connectedDevices.entries()) {
            if (now - device.lastHeartbeat > 60_000) {
                logger.warn({ deviceId }, 'Device heartbeat timeout, disconnecting');
                device.ws.close();
                connectedDevices.delete(deviceId);
                userDevices.delete(device.userId);
            } else {
                device.ws.send(
                    serializeMessage({ type: WsMessageType.HEARTBEAT, timestamp: now })
                );
            }
        }
    }, 30_000);

    logger.info('WebSocket server initialized on /ws');
}

export function onResult(handler: ResultHandler): void {
    onResultHandler = handler;
}

export function onStatus(handler: StatusHandler): void {
    onStatusHandler = handler;
}

/**
 * Generate a pairing code for a user.
 */
export function createPairingCode(userId: string): string {
    // Clean up old pairing codes for this user
    for (const [code, pending] of pendingPairings.entries()) {
        if (pending.userId === userId) {
            pendingPairings.delete(code);
        }
    }

    const code = `${randomSegment()}-${randomSegment()}`;
    pendingPairings.set(code, { userId, createdAt: Date.now() });

    // Expire after 5 minutes
    setTimeout(() => pendingPairings.delete(code), 5 * 60 * 1000);

    return code;
}

/**
 * Dispatch a task to the connected device for a user.
 */
export function dispatchTask(userId: string, task: Task): boolean {
    const deviceId = userDevices.get(userId);
    if (!deviceId) return false;

    const device = connectedDevices.get(deviceId);
    if (!device || device.ws.readyState !== WebSocket.OPEN) return false;

    const msg: WsTaskDispatch = {
        type: WsMessageType.TASK_DISPATCH,
        task,
    };

    device.ws.send(serializeMessage(msg));
    logger.info({ taskId: task.id, deviceId }, 'Task dispatched to device');
    return true;
}

/**
 * Request agent status from a user's connected device.
 */
export function requestStatus(userId: string): boolean {
    const deviceId = userDevices.get(userId);
    if (!deviceId) return false;

    const device = connectedDevices.get(deviceId);
    if (!device || device.ws.readyState !== WebSocket.OPEN) return false;

    const requestId = uuidv4();
    pendingStatusRequests.set(requestId, userId);

    const msg: WsStatusRequest = {
        type: WsMessageType.STATUS_REQUEST,
        requestId,
    };

    device.ws.send(serializeMessage(msg));
    return true;
}

/**
 * Cancel the active task on a user's device.
 */
export function cancelTask(userId: string, taskId: string): boolean {
    const deviceId = userDevices.get(userId);
    if (!deviceId) return false;

    const device = connectedDevices.get(deviceId);
    if (!device || device.ws.readyState !== WebSocket.OPEN) return false;

    const msg: WsCancelTask = {
        type: WsMessageType.CANCEL_TASK,
        taskId,
    };

    device.ws.send(serializeMessage(msg));
    return true;
}

/**
 * Check if a user has a connected device.
 */
export function isDeviceConnected(userId: string): boolean {
    const deviceId = userDevices.get(userId);
    if (!deviceId) return false;
    const device = connectedDevices.get(deviceId);
    return device !== undefined && device.ws.readyState === WebSocket.OPEN;
}

// ─── Internal Handlers ───

function handleMessage(ws: WebSocket, msg: WsMessage): void {
    switch (msg.type) {
        case WsMessageType.PAIR_REQUEST:
            handlePairRequest(ws, msg);
            break;

        case WsMessageType.TASK_RESULT:
            handleTaskResult(msg);
            break;

        case WsMessageType.TASK_PROGRESS:
            // TODO: Forward progress to WhatsApp user
            logger.info({ taskId: msg.taskId }, 'Task progress received');
            break;

        case WsMessageType.STATUS_RESPONSE:
            handleStatusResponse(msg);
            break;

        case WsMessageType.HEARTBEAT_ACK:
            handleHeartbeatAck(ws, msg);
            break;

        default:
            logger.warn({ type: (msg as any).type }, 'Unhandled message type');
    }
}

function handlePairRequest(ws: WebSocket, msg: Extract<WsMessage, { type: WsMessageType.PAIR_REQUEST }>): void {
    const pending = pendingPairings.get(msg.pairingCode);

    if (!pending) {
        ws.send(
            serializeMessage({
                type: WsMessageType.PAIR_REJECTED,
                reason: 'Invalid or expired pairing code.',
            })
        );
        return;
    }

    const deviceId = uuidv4();
    const device: ConnectedDevice = {
        id: deviceId,
        ws,
        userId: pending.userId,
        deviceName: msg.deviceName,
        availableAgents: msg.availableAgents,
        lastHeartbeat: Date.now(),
    };

    connectedDevices.set(deviceId, device);
    userDevices.set(pending.userId, deviceId);
    pendingPairings.delete(msg.pairingCode);

    ws.send(
        serializeMessage({
            type: WsMessageType.PAIR_ACCEPTED,
            deviceId,
        })
    );

    logger.info(
        { deviceId, userId: pending.userId, deviceName: msg.deviceName },
        'Device paired successfully'
    );
}

function handleTaskResult(msg: Extract<WsMessage, { type: WsMessageType.TASK_RESULT }>): void {
    // Find which user this result is for
    for (const device of connectedDevices.values()) {
        if (onResultHandler) {
            onResultHandler(device.userId, msg.result);
        }
        break;
    }
}

function handleStatusResponse(msg: Extract<WsMessage, { type: WsMessageType.STATUS_RESPONSE }>): void {
    const userId = pendingStatusRequests.get(msg.requestId);
    if (userId && onStatusHandler) {
        onStatusHandler(userId, msg.agents);
        pendingStatusRequests.delete(msg.requestId);
    }
}

function handleHeartbeatAck(ws: WebSocket, _msg: Extract<WsMessage, { type: WsMessageType.HEARTBEAT_ACK }>): void {
    for (const device of connectedDevices.values()) {
        if (device.ws === ws) {
            device.lastHeartbeat = Date.now();
            break;
        }
    }
}

// ─── Helpers ───

function randomSegment(): string {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}
