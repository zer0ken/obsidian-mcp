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

export class ObsidianServer {
  private server: Server;
  private tools: Map<string, Tool> = new Map();
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
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

  registerTool(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Array.from(this.tools.values()).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
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

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const params = request.params;
      if (!params || typeof params !== 'object') {
        throw new McpError(ErrorCode.InvalidParams, "Invalid request parameters");
      }
      
      const name = (params as any).name;
      const args = (params as any).arguments;
      
      if (!name || typeof name !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid tool name");
      }

      const tool = this.tools.get(name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      try {
        return await tool.handler(args);
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`);
        }
        throw error;
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
