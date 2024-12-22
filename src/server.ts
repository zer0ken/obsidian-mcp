import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode
} from "@modelcontextprotocol/sdk/types.js";
import { Tool } from "./types.js";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import os from 'os';

// Utility function to expand home directory
function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Utility function to resolve symlinks
async function resolveSymlinks(filepath: string): Promise<string> {
  try {
    const realPath = await fs.realpath(filepath);
    return realPath;
  } catch (error) {
    // If file doesn't exist yet, return original path
    if ((error as any).code === 'ENOENT') {
      return filepath;
    }
    throw error;
  }
}

export class ObsidianServer {
  private server: Server;
  private tools: Map<string, Tool<any>> = new Map();
  private vaultPath: string;

  constructor(vaultPath: string) {
    // Normalize and resolve vault path
    const expandedPath = expandHome(vaultPath);
    this.vaultPath = path.resolve(expandedPath);
    this.server = new Server(
      {
        name: "obsidian-vault",
        version: "1.0.0"
      },
      {
        capabilities: {
          resources: {},
          tools: {}
        }
      }
    );

    this.setupHandlers();
  }

  registerTool<T>(tool: Tool<T>) {
    this.tools.set(tool.name, tool);
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Array.from(this.tools.values()).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema.jsonSchema
      }))
    }));

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const files = await this.getAllMarkdownFiles();
      return {
        resources: files.map(file => ({
          uri: `file://${file}`,
          name: path.basename(file),
          mimeType: "text/markdown"
        }))
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params?.uri;
      if (!uri || typeof uri !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid URI parameter");
      }
      const filePath = uri.replace("file://", "");
      
      try {
        const content = await fs.readFile(filePath, "utf-8");
        return {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text: content
            }
          ]
        };
      } catch (error: any) {
        throw new McpError(ErrorCode.InternalError, `Failed to read file: ${error.message}`);
      }
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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

  private async getAllMarkdownFiles(dir = this.vaultPath): Promise<string[]> {
    let files: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        files = files.concat(await this.getAllMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }

    return files;
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Obsidian MCP Server running on stdio");
  }
}
