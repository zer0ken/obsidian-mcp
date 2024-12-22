// src/types.ts
export interface Tool {
    name: string;
    description: string;
    inputSchema: {
      type: string;
      properties: Record<string, any>;
      required?: string[];
    };
    handler: (args: any) => Promise<{
      content: Array<{
        type: string;
        text: string;
      }>;
    }>;
  }
  
  export interface ToolProvider {
    getTools(): Tool[];
  }
  
  // src/tools/note-tools.ts
  import { z } from "zod";
  import { Tool, ToolProvider } from "../types.js";
  import { promises as fs } from "fs";
  import path from "path";
  
  const CreateNoteSchema = z.object({
    filename: z.string(),
    content: z.string(),
    folder: z.string().optional()
  });
  
  export class NoteTools implements ToolProvider {
    constructor(private vaultPath: string) {}
  
    getTools(): Tool[] {
      return [
        {
          name: "create-note",
          description: "Create a new note in the vault",
          inputSchema: {
            type: "object",
            properties: {
              filename: {
                type: "string",
                description: "Name of the note (with .md extension)"
              },
              content: {
                type: "string",
                description: "Content of the note in markdown format"
              },
              folder: {
                type: "string",
                description: "Optional subfolder path"
              }
            },
            required: ["filename", "content"]
          },
          handler: async (args) => {
            const { filename, content, folder } = CreateNoteSchema.parse(args);
            const notePath = await this.createNote(filename, content, folder);
            return {
              content: [
                {
                  type: "text",
                  text: `Successfully created note: ${notePath}`
                }
              ]
            };
          }
        }
      ];
    }
  
    private async createNote(filename: string, content: string, folder?: string): Promise<string> {
      if (!filename.endsWith(".md")) {
        filename = `${filename}.md`;
      }
  
      const notePath = folder 
        ? path.join(this.vaultPath, folder, filename)
        : path.join(this.vaultPath, filename);
  
      const noteDir = path.dirname(notePath);
      await fs.mkdir(noteDir, { recursive: true });
  
      try {
        await fs.access(notePath);
        throw new Error("Note already exists");
      } catch (error) {
        if (error.code === "ENOENT") {
          await fs.writeFile(notePath, content);
          return notePath;
        }
        throw error;
      }
    }
  }
  
  // src/tools/search-tools.ts
  import { z } from "zod";
  import { Tool, ToolProvider } from "../types.js";
  import { promises as fs } from "fs";
  import path from "path";
  
  const SearchSchema = z.object({
    query: z.string(),
    path: z.string().optional(),
    caseSensitive: z.boolean().optional()
  });
  
  export class SearchTools implements ToolProvider {
    constructor(private vaultPath: string) {}
  
    getTools(): Tool[] {
      return [
        {
          name: "search-vault",
          description: "Search for text across notes",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query"
              },
              path: {
                type: "string",
                description: "Optional path to limit search scope"
              },
              caseSensitive: {
                type: "boolean",
                description: "Whether to perform case-sensitive search"
              }
            },
            required: ["query"]
          },
          handler: async (args) => {
            const { query, path: searchPath, caseSensitive } = SearchSchema.parse(args);
            const results = await this.searchVault(query, searchPath, caseSensitive);
            return {
              content: [
                {
                  type: "text",
                  text: this.formatSearchResults(results)
                }
              ]
            };
          }
        }
      ];
    }
  
    private async searchVault(query: string, searchPath?: string, caseSensitive = false) {
      // Implementation of searchVault method...
    }
  
    private formatSearchResults(results: any[]) {
      // Implementation of formatSearchResults method...
    }
  }
  
  // src/server.ts
  import { Server } from "@modelcontextprotocol/sdk/server/index.js";
  import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
  } from "@modelcontextprotocol/sdk/types.js";
  import { Tool, ToolProvider } from "./types.js";
  
  export class ObsidianServer {
    private server: Server;
    private tools: Map<string, Tool> = new Map();
  
    constructor() {
      this.server = new Server(
        {
          name: "obsidian-vault",
          version: "1.0.0"
        },
        {
          capabilities: {
            tools: {}
          }
        }
      );
  
      this.setupHandlers();
    }
  
    registerToolProvider(provider: ToolProvider) {
      for (const tool of provider.getTools()) {
        this.tools.set(tool.name, tool);
      }
    }
  
    private setupHandlers() {
      this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Array.from(this.tools.values()).map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      }));
  
      this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const tool = this.tools.get(name);
        
        if (!tool) {
          throw new Error(`Unknown tool: ${name}`);
        }
  
        return tool.handler(args);
      });
    }
  
    async start() {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("Obsidian MCP Server running on stdio");
    }
  }
  
  // src/main.ts
  import { ObsidianServer } from "./server.js";
  import { NoteTools } from "./tools/note-tools.js";
  import { SearchTools } from "./tools/search-tools.js";
  
  async function main() {
    const vaultPath = process.argv[2];
    if (!vaultPath) {
      console.error("Please provide the path to your Obsidian vault");
      process.exit(1);
    }
  
    try {
      const server = new ObsidianServer();
      
      // Register tool providers
      server.registerToolProvider(new NoteTools(vaultPath));
      server.registerToolProvider(new SearchTools(vaultPath));
  
      await server.start();
    } catch (error) {
      console.error("Fatal error:", error);
      process.exit(1);
    }
  }
  
  main().catch((error) => {
    console.error("Unhandled error:", error);
    process.exit(1);
  });