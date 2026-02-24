import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import {
    AgentType,
    AGENT_ALIASES,
    AGENT_DISPLAY_NAMES,
    AgentStatusMap,
} from '@cwac/shared';
import { parseCommand, getHelpText } from './parser';
import { sendTextMessage } from './whatsapp';
import { sessionManager } from './session';
import { taskQueue } from './queue';
import {
    dispatchTask,
    requestStatus,
    cancelTask,
    isDeviceConnected,
    createPairingCode,
} from './ws-server';

const logger = pino({ name: 'router' });

/**
 * Handle an inbound WhatsApp message.
 */
export async function handleInboundMessage(userId: string, message: string): Promise<void> {
    const parsed = parseCommand(message);

    switch (parsed.type) {
        case 'agent':
            await handleAgentCommand(userId, parsed.agent, parsed.prompt);
            break;

        case 'default_agent':
            await handleDefaultAgentCommand(userId, parsed.prompt);
            break;

        case 'system':
            await handleSystemCommand(userId, parsed.command, parsed.args);
            break;

        case 'error':
            await sendTextMessage(userId, `⚠️ ${parsed.message}`);
            break;
    }
}

async function handleAgentCommand(userId: string, agent: AgentType, prompt: string): Promise<void> {
    if (!isDeviceConnected(userId)) {
        await sendTextMessage(
            userId,
            '❌ No device connected. Run `npx cwac-connector start` on your machine, then send `/pair <code>` here.'
        );
        return;
    }

    const session = sessionManager.getSession(userId);
    const displayName = AGENT_DISPLAY_NAMES[agent];

    // Acknowledge receipt
    await sendTextMessage(userId, `🤖 *${displayName}* | Task received. Running...`);

    // Enqueue task
    const task = taskQueue.enqueue(agent, prompt, session.defaultWorkspace, userId);

    // Dispatch to device
    const dispatched = dispatchTask(userId, task);
    if (!dispatched) {
        await sendTextMessage(userId, `❌ Failed to dispatch to *${displayName}*. Device may have disconnected.`);
    }
}

async function handleDefaultAgentCommand(userId: string, prompt: string): Promise<void> {
    const session = sessionManager.getSession(userId);
    await handleAgentCommand(userId, session.defaultAgent, prompt);
}

async function handleSystemCommand(userId: string, command: string, args: string): Promise<void> {
    switch (command) {
        case '/help':
            await sendTextMessage(userId, getHelpText());
            break;

        case '/status':
            await handleStatusCommand(userId);
            break;

        case '/default':
            await handleDefaultCommand(userId, args);
            break;

        case '/history':
            await handleHistoryCommand(userId);
            break;

        case '/cancel':
            await handleCancelCommand(userId);
            break;

        case '/pair':
            await handlePairCommand(userId, args);
            break;

        default:
            await sendTextMessage(userId, `⚠️ Unknown command: ${command}`);
    }
}

async function handleStatusCommand(userId: string): Promise<void> {
    if (!isDeviceConnected(userId)) {
        await sendTextMessage(
            userId,
            '📊 *Agent Status*\n\n❌ No device connected.\nRun `npx cwac-connector start` on your dev machine.'
        );
        return;
    }

    // Request status from the connector
    const requested = requestStatus(userId);
    if (requested) {
        await sendTextMessage(userId, '📊 Checking agent status...');
    } else {
        await sendTextMessage(userId, '❌ Could not reach your device.');
    }
}

async function handleDefaultCommand(userId: string, args: string): Promise<void> {
    if (!args) {
        const session = sessionManager.getSession(userId);
        const displayName = AGENT_DISPLAY_NAMES[session.defaultAgent];
        await sendTextMessage(
            userId,
            `📌 Current defaults:\n• Agent: *${displayName}*\n• Workspace: \`${session.defaultWorkspace}\``
        );
        return;
    }

    const parts = args.trim().split(/\s+/);
    const agentArg = parts[0]?.toLowerCase();
    const workspace = parts.slice(1).join(' ') || undefined;

    // Try to resolve agent name
    const aliasKey = agentArg.startsWith('/') ? agentArg : `/${agentArg}`;
    const agent = AGENT_ALIASES[aliasKey];

    if (!agent) {
        await sendTextMessage(
            userId,
            `⚠️ Unknown agent: \`${agentArg}\`. Available: claude, anti, cursor, wind`
        );
        return;
    }

    const session = sessionManager.setDefaultAgent(userId, agent, workspace);
    const displayName = AGENT_DISPLAY_NAMES[agent];

    let msg = `✅ Default agent set to *${displayName}*`;
    if (workspace) {
        msg += `\n📁 Workspace: \`${workspace}\``;
    }
    await sendTextMessage(userId, msg);
}

async function handleHistoryCommand(userId: string): Promise<void> {
    const history = taskQueue.getHistory(userId, 10);

    if (history.length === 0) {
        await sendTextMessage(userId, '📜 No tasks in history yet.');
        return;
    }

    const lines = history.map((task, i) => {
        const status = task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : '⏳';
        const agent = AGENT_DISPLAY_NAMES[task.agent];
        const timeAgo = getTimeAgo(task.createdAt);
        const promptPreview = task.prompt.length > 50 ? task.prompt.slice(0, 50) + '...' : task.prompt;
        return `${status} *${agent}* (${timeAgo})\n   ${promptPreview}`;
    });

    await sendTextMessage(userId, `📜 *Recent Tasks*\n\n${lines.join('\n\n')}`);
}

async function handleCancelCommand(userId: string): Promise<void> {
    const activeTask = taskQueue.getActiveTask();

    if (!activeTask || activeTask.userId !== userId) {
        await sendTextMessage(userId, '⚠️ No active task to cancel.');
        return;
    }

    cancelTask(userId, activeTask.id);
    taskQueue.cancelActive();

    const displayName = AGENT_DISPLAY_NAMES[activeTask.agent];
    await sendTextMessage(userId, `🛑 Cancelled *${displayName}* task.`);
}

async function handlePairCommand(userId: string, args: string): Promise<void> {
    const code = args.trim();

    if (!code) {
        // Generate a new pairing code
        const newCode = createPairingCode(userId);
        await sendTextMessage(
            userId,
            `🔗 *Pairing Code:* \`${newCode}\`\n\nRun this on your dev machine:\n\`\`\`\nnpx cwac-connector start --pair ${newCode}\n\`\`\`\n\nCode expires in 5 minutes.`
        );
        return;
    }

    // If they're providing a code, they may have generated it from the connector side
    // This flow is handled via WebSocket (connector sends pair request)
    await sendTextMessage(userId, `🔗 Waiting for device to connect with code \`${code}\`...`);
}

/**
 * Handle a status response from the connector (called by ws-server).
 */
export async function handleStatusResponse(userId: string, agents: AgentStatusMap): Promise<void> {
    const lines = Object.values(agents).map((a) => {
        const icon = a.available ? '✅' : '⚠️';
        const displayName = AGENT_DISPLAY_NAMES[a.agent];
        const version = a.version ? ` (v${a.version})` : '';
        const status = a.available ? 'online' : 'offline';
        return `${icon} *${displayName}*${version} — ${status}`;
    });

    await sendTextMessage(userId, `📊 *Agent Status*\n\n${lines.join('\n')}`);
}

/**
 * Handle a task result from the connector (called by ws-server).
 */
export async function handleTaskResultMessage(userId: string, taskId: string, output: string, error?: string): Promise<void> {
    const history = taskQueue.getHistory(userId, 20);
    const task = history.find((t) => t.id === taskId);
    const agentName = task ? AGENT_DISPLAY_NAMES[task.agent] : 'Agent';

    if (error) {
        await sendTextMessage(userId, `❌ *${agentName}* | Task failed:\n${error}`);
    } else {
        await sendTextMessage(userId, `✅ *${agentName}* | Done:\n\n${output}`);
    }
}

// ─── Helpers ───

function getTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
