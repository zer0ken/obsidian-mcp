import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
  Request
} from "@modelcontextprotocol/sdk/types.js";
import { RateLimiter, ConnectionMonitor, validateMessageSize } from "./utils/security.js";
import { Tool } from "./types.js";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import os from 'os';
import {
  getNoteResourceTemplates,
  listVaultResources,
  readVaultResource
} from "./utils/resources.js";
import { listPrompts, getPrompt, registerPrompt } from "./utils/prompt-factory.js";
import { listVaultsPrompt } from "./prompts/list-vaults/index.js";

// Utility function to expand home directory
function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

export class ObsidianServer {
  private server: Server;
  private tools: Map<string, Tool<any>> = new Map();
  private vaults: Map<string, string> = new Map();
  private rateLimiter: RateLimiter;
  private connectionMonitor: ConnectionMonitor;

  constructor(vaultConfigs: { name: string; path: string }[]) {
    // Initialize vaults
    vaultConfigs.forEach(config => {
      const expandedPath = expandHome(config.path);
      this.vaults.set(config.name, path.resolve(expandedPath));
    });
    this.server = new Server(
      {
        name: "obsidian-vault",
        version: "1.0.0"
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          prompts: {}
        }
      }
    );

    // Initialize security features
    this.rateLimiter = new RateLimiter();
    this.connectionMonitor = new ConnectionMonitor();

    // Register prompts
    registerPrompt(listVaultsPrompt);

    this.setupHandlers();

    // Setup connection monitoring
    this.connectionMonitor.start(() => {
      console.error("Connection timeout detected");
      this.server.close();
    });

    // Setup error handler
    this.server.onerror = (error) => {
      console.error("Server error:", error);
    };
  }

  registerTool<T>(tool: Tool<T>) {
    this.tools.set(tool.name, tool);
  }

  private validateRequest(request: any) {
    try {
      // Validate message size
      validateMessageSize(request);

      // Update connection activity
      this.connectionMonitor.updateActivity();

      // Check rate limit (using method name as client id for basic implementation)
      if (!this.rateLimiter.checkLimit(request.method)) {
        throw new McpError(ErrorCode.InvalidRequest, "Rate limit exceeded");
      }
    } catch (error) {
      console.error("Request validation failed:", error);
      throw error;
    }
  }

  private setupHandlers() {
    // List available prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      this.validateRequest(request);
      return listPrompts();
    });

    // Get specific prompt
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      this.validateRequest(request);
      const { name, arguments: args } = request.params;
      
      if (!name || typeof name !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid prompt name");
      }

      const result = await getPrompt(name, this.vaults, args);
      return {
        ...result,
        _meta: {
          promptName: name,
          timestamp: new Date().toISOString()
        }
      };
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      this.validateRequest(request);
      return {
        tools: Array.from(this.tools.values()).map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema.jsonSchema
        }))
      };
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      this.validateRequest(request);
      const resources = await listVaultResources(this.vaults);
      return {
        resources,
        resourceTemplates: getNoteResourceTemplates()
      };
    });

    // Read resource content
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      this.validateRequest(request);
      const uri = request.params?.uri;
      if (!uri || typeof uri !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid URI parameter");
      }

      if (!uri.startsWith('obsidian-vault://')) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid URI format. Only vault resources are supported.");
      }

      // Handle root vault list
      if (uri === 'obsidian-vault://') {
        return {
          contents: [{
            uri,
            mimeType: "application/json",
            text: JSON.stringify({
              totalVaults: this.vaults.size,
              vaults: Array.from(this.vaults.entries()).map(([name, path]) => ({
                name,
                path,
                isAccessible: true
              }))
            }, null, 2)
          }]
        };
      }

      // Handle individual vault resources
      return {
        contents: [await readVaultResource(this.vaults, uri)]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      this.validateRequest(request);
      const params = request.params;
      if (!params || typeof params !== 'object') {
        throw new McpError(ErrorCode.InvalidParams, "Invalid request parameters");
      }
      
      const name = params.name;
      const args = params.arguments;
      
      if (!name || typeof name !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid tool name");
      }

      const tool = this.tools.get(name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      try {
        // Validate and transform arguments using tool's schema handler
        const validatedArgs = tool.inputSchema.parse(args);
        
        // Execute tool with validated arguments
        const result = await tool.handler(validatedArgs);
        
        return {
          _meta: {
            toolName: name,
            timestamp: new Date().toISOString(),
            success: true
          },
          content: result.content
        };
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          const formattedErrors = error.errors.map(e => {
            const path = e.path.join(".");
            const message = e.message;
            return `${path ? path + ': ' : ''}${message}`;
          }).join("\n");
          
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid arguments:\n${formattedErrors}`
          );
        }
        
        // Enhance error reporting
        if (error instanceof McpError) {
          throw error;
        }
        
        // Convert unknown errors to McpError with helpful message
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log("Obsidian MCP Server running on stdio");
  }

  async stop() {
    this.connectionMonitor.stop();
    await this.server.close();
    console.log("Obsidian MCP Server stopped");
  }
}
