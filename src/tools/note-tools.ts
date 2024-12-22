import { z } from "zod";
import { Tool, ToolProvider } from "../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

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
      },
      {
        name: "edit-note",
        description: "Edit an existing note (use only filename, not full path)",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Name of the note file (e.g., 'note.md'), not full path"
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
        },
        handler: async (args) => {
          const { path: notePath, operation, content } = EditNoteSchema.parse(args);
          
          // Add validation to ensure only filename is provided
          if (notePath.includes('/') || notePath.includes('\\')) {
            throw new McpError(ErrorCode.InvalidRequest, 
              `Please provide only the filename (e.g., "note.md") rather than a path with directories`);
          }
          
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
    // Ensure we're only working with the filename
    const filename = path.basename(notePath);
    const fullPath = path.join(this.vaultPath, filename);

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
        throw new McpError(ErrorCode.InvalidRequest, 
          `Note "${filename}" not found. Please provide only the filename without any path.`);
      }
      throw new McpError(ErrorCode.InternalError, `Failed to ${operation} note: ${error.message}`);
    }
  }
}