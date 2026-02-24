import { AgentType, TaskResult } from '@cwac/shared';

/**
 * Abstract base interface for all agent runners.
 */
export interface AgentRunner {
    /** Execute a prompt in the given workspace and return the result. */
    execute(prompt: string, workspace: string): Promise<TaskResult>;

    /** Check if the agent is available and healthy. */
    checkHealth(): Promise<boolean>;

    /** Get the agent type. */
    getType(): AgentType;

    /** Get the agent display name. */
    getName(): string;

    /** Get the agent version (if available). */
    getVersion(): Promise<string | undefined>;
}
