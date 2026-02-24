import pino from 'pino';
import { AgentType, AgentHealth, AgentStatusMap } from '@cwac/shared';
import { AgentRunner } from './agents/base';

const logger = pino({ name: 'health' });

/**
 * Check the health of all registered agent runners.
 */
export async function checkAllAgents(runners: Map<AgentType, AgentRunner>): Promise<AgentStatusMap> {
    const results: Partial<AgentStatusMap> = {};

    const checks = Array.from(runners.entries()).map(async ([type, runner]) => {
        try {
            const available = await runner.checkHealth();
            const version = available ? await runner.getVersion() : undefined;

            results[type] = {
                agent: type,
                available,
                version,
                lastChecked: Date.now(),
            };

            logger.info({ agent: type, available, version }, 'Health check');
        } catch (err: any) {
            results[type] = {
                agent: type,
                available: false,
                lastChecked: Date.now(),
            };
            logger.error({ agent: type, err: err.message }, 'Health check failed');
        }
    });

    await Promise.all(checks);

    // Fill in missing agents as unavailable
    for (const type of Object.values(AgentType)) {
        if (!results[type]) {
            results[type] = {
                agent: type,
                available: false,
                lastChecked: Date.now(),
            };
        }
    }

    return results as AgentStatusMap;
}
