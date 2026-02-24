import {
    AgentType,
    AgentStatusMap,
    Task,
    TaskResult,
} from './types';

// ─── WebSocket Message Types ───

export enum WsMessageType {
    // Gateway → Connector
    TASK_DISPATCH = 'task:dispatch',
    STATUS_REQUEST = 'status:request',
    CANCEL_TASK = 'task:cancel',

    // Connector → Gateway
    TASK_RESULT = 'task:result',
    TASK_PROGRESS = 'task:progress',
    STATUS_RESPONSE = 'status:response',
    PAIR_REQUEST = 'pair:request',

    // Gateway → Connector
    PAIR_ACCEPTED = 'pair:accepted',
    PAIR_REJECTED = 'pair:rejected',

    // Bidirectional
    HEARTBEAT = 'heartbeat',
    HEARTBEAT_ACK = 'heartbeat:ack',
    ERROR = 'error',
}

// ─── Message Payloads ───

export interface WsTaskDispatch {
    type: WsMessageType.TASK_DISPATCH;
    task: Task;
}

export interface WsTaskResult {
    type: WsMessageType.TASK_RESULT;
    result: TaskResult;
}

export interface WsTaskProgress {
    type: WsMessageType.TASK_PROGRESS;
    taskId: string;
    partialOutput: string;
}

export interface WsStatusRequest {
    type: WsMessageType.STATUS_REQUEST;
    requestId: string;
}

export interface WsStatusResponse {
    type: WsMessageType.STATUS_RESPONSE;
    requestId: string;
    agents: AgentStatusMap;
}

export interface WsCancelTask {
    type: WsMessageType.CANCEL_TASK;
    taskId: string;
}

export interface WsPairRequest {
    type: WsMessageType.PAIR_REQUEST;
    pairingCode: string;
    deviceName: string;
    availableAgents: AgentType[];
}

export interface WsPairAccepted {
    type: WsMessageType.PAIR_ACCEPTED;
    deviceId: string;
}

export interface WsPairRejected {
    type: WsMessageType.PAIR_REJECTED;
    reason: string;
}

export interface WsHeartbeat {
    type: WsMessageType.HEARTBEAT;
    timestamp: number;
}

export interface WsHeartbeatAck {
    type: WsMessageType.HEARTBEAT_ACK;
    timestamp: number;
}

export interface WsError {
    type: WsMessageType.ERROR;
    message: string;
    code?: string;
}

export type WsMessage =
    | WsTaskDispatch
    | WsTaskResult
    | WsTaskProgress
    | WsStatusRequest
    | WsStatusResponse
    | WsCancelTask
    | WsPairRequest
    | WsPairAccepted
    | WsPairRejected
    | WsHeartbeat
    | WsHeartbeatAck
    | WsError;

// ─── Serialization ───

export function serializeMessage(msg: WsMessage): string {
    return JSON.stringify(msg);
}

export function deserializeMessage(data: string): WsMessage {
    const parsed = JSON.parse(data);
    if (!parsed.type || !Object.values(WsMessageType).includes(parsed.type)) {
        throw new Error(`Invalid message type: ${parsed.type}`);
    }
    return parsed as WsMessage;
}
