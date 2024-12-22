import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Request } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";

// Schemas for validating tool inputs
const CreateNoteSchema = z.object({
  filename: z.string(),
  content: z.string(),
  folder: z.string().optional()
});

const EditNoteSchema = z.object({
  path: z.string(),
  operation: z.enum(['append', 'prepend', 'replace', 'delete']),
  content: z.string().optional()
});

const SearchSchema = z.object({
  query: z.string(),
  path: z.string().optional(),
  caseSensitive: z.boolean().optional()
});

class ObsidianServer {
  private vaultPath: string;
  private server: Server;

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

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
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
          }
        },
        {
          name: "edit-note",
          description: "Edit an existing note",
          inputSchema: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Path to the note file"
              },
              operation: {
                type: "string",
                enum: ["append", "prepend", "replace", "delete"],
                description: "Type of edit operation"
              },
              content: {
                type: "string",
                description: "New content (not needed for delete)"
              }
            },
            required: ["path", "operation"]
          }
        },
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
          }
        }
      ]
    }));

    // List available resources (markdown files)
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

    // Read resource content
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request: Request) => {
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

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request: Request) => {
      const params = request.params;
      if (!params || typeof params !== 'object') {
        throw new McpError(ErrorCode.InvalidParams, "Invalid request parameters");
      }
      
      const name = (params as any).name;
      const args = (params as any).arguments;
      
      if (!name || typeof name !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, "Missing or invalid tool name");
      }

      try {
        switch (name) {
          case "create-note": {
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

          case "edit-note": {
            const { path: notePath, operation, content } = EditNoteSchema.parse(args);
            await this.editNote(notePath, operation, content);
            return {
              content: [
                {
                  type: "text",
                  text: `Successfully ${operation}ed note: ${notePath}`
                }
              ]
            };
          }

          case "search-vault": {
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

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")}`);
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
      throw new McpError(ErrorCode.InvalidRequest, "Note already exists");
    } catch (error: any) {
      if (error.code === "ENOENT") {
        await fs.writeFile(notePath, content);
        return notePath;
      }
      throw error;
    }
  }

  private async editNote(notePath: string, operation: string, content?: string): Promise<void> {
    const fullPath = path.join(this.vaultPath, notePath);

    try {
      if (operation === "delete") {
        await fs.unlink(fullPath);
        return;
      }

      const existingContent = await fs.readFile(fullPath, "utf-8");
      let newContent: string;

      if (operation !== "delete" && !content) {
        throw new McpError(ErrorCode.InvalidParams, `Content is required for ${operation} operation`);
      }

      switch (operation) {
        case "append":
          newContent = `${existingContent}\n${content as string}`;
          break;
        case "prepend":
          newContent = `${content as string}\n${existingContent}`;
          break;
        case "replace":
          newContent = content as string;
          break;
        default:
          throw new McpError(ErrorCode.InvalidParams, `Invalid operation: ${operation}`);
      }

      await fs.writeFile(fullPath, newContent);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        throw new McpError(ErrorCode.InvalidRequest, `Note not found: ${notePath}`);
      }
      throw new McpError(ErrorCode.InternalError, `Failed to ${operation} note: ${error.message}`);
    }
  }

  private async searchVault(query: string, searchPath?: string, caseSensitive = false): Promise<Array<{file: string, matches: Array<{line: number, text: string}>}>> {
    const files = await this.getAllMarkdownFiles(searchPath ? path.join(this.vaultPath, searchPath) : undefined);
    const results: Array<{file: string, matches: Array<{line: number, text: string}>}> = [];

    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      const lines = content.split("\n");
      const matches: Array<{line: number, text: string}> = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (caseSensitive ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase())) {
          matches.push({
            line: i + 1,
            text: line.trim()
          });
        }
      }

      if (matches.length > 0) {
        results.push({
          file: path.relative(this.vaultPath, file),
          matches
        });
      }
    }

    return results;
  }

  private formatSearchResults(results: Array<{file: string, matches: Array<{line: number, text: string}>}>): string {
    if (results.length === 0) {
      return "No matches found";
    }

    return results.map(result => {
      const matchText = result.matches
        .map(m => `  Line ${m.line}: ${m.text}`)
        .join("\n");
      return `${result.file}:\n${matchText}`;
    }).join("\n\n");
  }

  public async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Obsidian MCP Server running on stdio");
  }
}

// Start the server
const vaultPath = process.argv[2];
if (!vaultPath) {
  console.error("Please provide the path to your Obsidian vault");
  process.exit(1);
}

const server = new ObsidianServer(vaultPath);
server.start().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
