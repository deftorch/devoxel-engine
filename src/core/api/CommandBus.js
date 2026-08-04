/**
 * CommandBus handles external commands, enabling the engine to be controlled remotely
 * (e.g. by an MCP Server, WebSockets, or browser console).
 * Adheres to MCP Tool Specification (JSON Schema).
 */
export class CommandBus {
  constructor() {
    this.commands = new Map();
  }

  /**
   * Register a new command handler with JSON Schema.
   * @param {Object} config
   * @param {string} config.name - Command name
   * @param {string} config.description - Detailed description for AI/MCP
   * @param {Object} config.schema - JSON Schema for the payload
   * @param {Function} config.handler - Function to execute when command is called
   */
  register({ name, description, schema, handler }) {
    if (this.commands.has(name)) {
      console.warn(`[CommandBus] Overwriting command: ${name}`);
    }
    this.commands.set(name, { name, description, schema, handler });
  }

  /**
   * Get all registered commands (Formatted for MCP Tools).
   * @returns {Array<Object>} List of tool definitions.
   */
  getTools() {
    return Array.from(this.commands.values()).map(cmd => ({
      name: cmd.name,
      description: cmd.description,
      inputSchema: cmd.schema
    }));
  }

  /**
   * Execute a registered command.
   * @param {string} name - Command name
   * @param {Object} [payload] - Arguments for the command
   * @returns {Promise<any>}
   */
  async execute(name, payload = {}) {
    const command = this.commands.get(name);
    if (!command) {
      throw new Error(`[CommandBus] Command not found: ${name}`);
    }
    try {
      return await command.handler(payload);
    } catch (e) {
      console.error(`[CommandBus] Error executing ${name}:`, e);
      throw e;
    }
  }
}
