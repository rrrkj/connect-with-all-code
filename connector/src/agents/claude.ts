import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { AgentType, TaskResult } from '@cwac/shared';
import { AgentRunner } from './base';

const logger = pino({ name: 'agent:claude' });

const DEFAULT_TIMEOUT_MS = 3_600_000; // 60 minutes

export class ClaudeCodeRunner implements AgentRunner {
    private command: string;
    private timeoutMs: number;

    constructor(command: string = 'claude', timeoutMs: number = DEFAULT_TIMEOUT_MS) {
        this.command = command;
        this.timeoutMs = timeoutMs;
    }

    getType(): AgentType {
        return AgentType.CLAUDE;
    }

    getName(): string {
        return 'Claude Code';
    }

    async getVersion(): Promise<string | undefined> {
        try {
            const output = await this.runCommand([this.command, '--version'], 10_000);
            return output.trim() || undefined;
        } catch {
            return undefined;
        }
    }

    async checkHealth(): Promise<boolean> {
        try {
            await this.runCommand([this.command, '--version'], 10_000);
            return true;
        } catch {
            return false;
        }
    }

    async execute(prompt: string, workspace: string): Promise<TaskResult> {
        const taskId = uuidv4();
        const startTime = Date.now();

        try {
            // Resolve and validate workspace directory
            let resolvedWorkspace = expandHome(workspace);
            if (!existsSync(resolvedWorkspace)) {
                const fallback = process.env.HOME || process.cwd();
                logger.warn(
                    { taskId, requestedWorkspace: workspace, fallback },
                    'Workspace directory does not exist, falling back'
                );
                resolvedWorkspace = fallback;
            }

            logger.info({ taskId, workspace: resolvedWorkspace, promptLength: prompt.length }, 'Executing Claude Code task');

            // Pass prompt via stdin (not CLI args) to avoid shell escaping issues
            const args = [
                '-p',
                '--dangerously-skip-permissions',
                '--output-format', 'json',
            ];

            const output = await this.runCommand(
                [this.command, ...args],
                this.timeoutMs,
                resolvedWorkspace,
                prompt,
            );

            // Parse JSON output from Claude Code
            let responseText = output;
            try {
                const parsed = JSON.parse(output);
                if (parsed.result) {
                    responseText = parsed.result;
                } else if (parsed.content) {
                    responseText = typeof parsed.content === 'string'
                        ? parsed.content
                        : JSON.stringify(parsed.content, null, 2);
                } else if (parsed.text) {
                    responseText = parsed.text;
                }
            } catch {
                // If not valid JSON, use raw output
                responseText = output;
            }

            const durationMs = Date.now() - startTime;

            return {
                taskId,
                status: 'completed',
                output: responseText,
                durationMs,
            };
        } catch (err: any) {
            const durationMs = Date.now() - startTime;
            logger.error({ taskId, err: err.message }, 'Claude Code task failed');

            return {
                taskId,
                status: 'failed',
                output: '',
                error: err.message || 'Unknown error',
                durationMs,
            };
        }
    }

    private runCommand(
        args: string[],
        timeoutMs: number,
        cwd?: string,
        stdinData?: string,
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const [cmd, ...cmdArgs] = args;
            const proc = spawn(cmd, cmdArgs, {
                cwd: cwd || undefined,
                env: { ...process.env },
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true,
            });

            // Write prompt to stdin and close it immediately
            if (stdinData) {
                proc.stdin.write(stdinData);
            }
            proc.stdin.end();

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            proc.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            const timer = setTimeout(() => {
                proc.kill('SIGTERM');
                reject(new Error(`Command timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            proc.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(stderr || `Process exited with code ${code}`));
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }
}

function expandHome(path: string): string {
    if (path.startsWith('~/')) {
        return path.replace('~', process.env.HOME || '');
    }
    return path;
}
