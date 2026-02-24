import { UserSession, AgentType } from '@cwac/shared';
import pino from 'pino';
import path from 'path';
import os from 'os';

const logger = pino({ name: 'session' });

/**
 * In-memory session store.
 * For production, replace with Redis-backed implementation.
 */
class SessionManager {
    private sessions = new Map<string, UserSession>();

    getSession(userId: string): UserSession {
        let session = this.sessions.get(userId);
        if (!session) {
            session = {
                userId,
                defaultAgent: AgentType.CLAUDE,
                defaultWorkspace: os.homedir(),
                pairedDeviceId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            this.sessions.set(userId, session);
            logger.info({ userId }, 'Created new session');
        }
        return session;
    }

    updateSession(userId: string, updates: Partial<UserSession>): UserSession {
        const session = this.getSession(userId);
        Object.assign(session, updates, { updatedAt: Date.now() });
        this.sessions.set(userId, session);
        return session;
    }

    setDefaultAgent(userId: string, agent: AgentType, workspace?: string): UserSession {
        const updates: Partial<UserSession> = { defaultAgent: agent };
        if (workspace) updates.defaultWorkspace = resolveWorkspace(workspace);
        return this.updateSession(userId, updates);
    }

    setPairedDevice(userId: string, deviceId: string): UserSession {
        return this.updateSession(userId, { pairedDeviceId: deviceId });
    }

    hasPairedDevice(userId: string): boolean {
        const session = this.getSession(userId);
        return session.pairedDeviceId !== null;
    }

    getAllSessions(): UserSession[] {
        return Array.from(this.sessions.values());
    }
}

export const sessionManager = new SessionManager();

/**
 * Resolve a workspace path. If it's a relative name like "resume-updater",
 * resolve it against the user's home directory.
 */
function resolveWorkspace(workspace: string): string {
    // Already absolute
    if (path.isAbsolute(workspace)) return workspace;
    // Expand ~/
    if (workspace.startsWith('~/')) {
        return path.join(os.homedir(), workspace.slice(2));
    }
    // Relative folder name → resolve against home directory
    return path.join(os.homedir(), workspace);
}
